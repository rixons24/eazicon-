// Core tier resolver. This is THE piece of the concierge — everything else
// (routes, channels, voice/text) funnels through here so the classification
// logic lives in exactly one place.
//
// Flow:
//   1. Enforce plan limits (free tier cap, trial expiry) — fail fast, no LLM cost
//   2. Check for urgent keywords — skip LLM, notify staff, return safe acknowledgment
//   3. Try quick keyword match against knowledge base — cheap, no LLM cost
//   4. Fall through to LLM classification + drafting — the expensive path
//
// Returns { tier, guestReplyText, staffDraft?, detectedLanguage }.

const { query } = require('../db/pool');
const { nanoid } = require('nanoid');
const groq = require('./groq');
const { isUrgent } = require('./escalation');
const { checkLimit, tickUsage, getPlan } = require('./plans');

const TIER_ACK = {
  urgent: 'Thank you — I have flagged this for our front desk manager who will help you right away.',
  needs_approval: "Let me check on that for you and get back with confirmation shortly.",
  limit_reached: 'This concierge has reached its message limit for now. Please ask at the front desk.',
};

// Cheap first-pass KB lookup — tokenize question keywords and try substring match.
// Not as good as embeddings, but zero-cost and answers 60-80% of routine questions
// (wifi, breakfast, hours, checkout) without an LLM call.
function keywordMatchKB(kbEntries, guestMessage) {
  const lower = guestMessage.toLowerCase();
  for (const entry of kbEntries) {
    if (entry.keywords && entry.keywords.length) {
      if (entry.keywords.some(k => lower.includes(k.toLowerCase()))) return entry;
    }
    // Fallback: first significant word of the KB question
    const firstWord = entry.question.split(/\s+/)[0]?.toLowerCase();
    if (firstWord && firstWord.length > 3 && lower.includes(firstWord)) return entry;
  }
  return null;
}

async function loadKB(hotelId) {
  const { rows } = await query(
    'SELECT question, answer, keywords FROM knowledge_entries WHERE hotel_id = $1',
    [hotelId]
  );
  return rows;
}

async function persistMessages({ conversationId, guestMessage, guestLanguage, tier, staffDraft, guestReply }) {
  // Guest message
  await query(
    `INSERT INTO messages (id, conversation_id, role, content_original, content_english, tier, approval_status, approval_draft, created_at)
     VALUES ($1, $2, 'guest', $3, $4, $5, $6, $7, NOW())`,
    [nanoid(12), conversationId, guestMessage, null, tier, tier === 'needs_approval' ? 'pending' : null, staffDraft || null]
  );
  // Agent auto-reply (or the acknowledgment shown to the guest)
  await query(
    `INSERT INTO messages (id, conversation_id, role, content_original, content_english, tier, created_at)
     VALUES ($1, $2, 'agent', $3, $4, $5, NOW())`,
    [nanoid(12), conversationId, guestReply, guestReply, tier]
  );
  await query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [conversationId]);
}

// Main entry point. Callers pass a hotel row (already loaded), the guest
// message string, and the conversation id. Voice callers also pass a
// pre-detected language from Whisper.
async function resolveTieredReply({ hotel, conversationId, guestMessage, guestLanguage }) {
  // 1. Plan limit check
  const limit = checkLimit(hotel);
  if (!limit.allowed) {
    return {
      tier: 'limit_reached',
      guestReplyText: TIER_ACK.limit_reached,
      detectedLanguage: guestLanguage || 'en',
    };
  }

  // 2. Urgent escalation (English keyword regex — the LLM path also catches non-English urgent)
  if (isUrgent(guestMessage)) {
    await persistMessages({
      conversationId, guestMessage, guestLanguage,
      tier: 'urgent', guestReply: TIER_ACK.urgent,
    });
    await tickUsage(query, hotel.id);
    return { tier: 'urgent', guestReplyText: TIER_ACK.urgent, detectedLanguage: guestLanguage || 'en' };
  }

  // 3. Cheap KB keyword lookup
  const kb = await loadKB(hotel.id);
  const kbHit = keywordMatchKB(kb, guestMessage);
  if (kbHit) {
    const targetLang = guestLanguage || 'en';
    const translated = targetLang === 'en' ? kbHit.answer : await groq.translate(kbHit.answer, targetLang);
    await persistMessages({
      conversationId, guestMessage, guestLanguage,
      tier: 'auto', guestReply: translated,
    });
    await tickUsage(query, hotel.id);
    return { tier: 'auto', guestReplyText: translated, detectedLanguage: targetLang };
  }

  // 4. LLM classification + drafting (the expensive path)
  const model = getPlan(hotel).llmModel;
  const result = await groq.classifyAndDraft({
    guestMessage,
    hotelName: hotel.name,
    knowledgeBase: kb,
    ...(model ? { model } : {}),
  });

  const finalLang = guestLanguage || result.detectedLanguage || 'en';

  if (result.tier === 'urgent') {
    await persistMessages({
      conversationId, guestMessage, guestLanguage: finalLang,
      tier: 'urgent', guestReply: TIER_ACK.urgent,
    });
    await tickUsage(query, hotel.id);
    return { tier: 'urgent', guestReplyText: TIER_ACK.urgent, detectedLanguage: finalLang };
  }

  if (result.tier === 'auto') {
    const translated = finalLang === 'en' ? result.draft : await groq.translate(result.draft, finalLang);
    await persistMessages({
      conversationId, guestMessage, guestLanguage: finalLang,
      tier: 'auto', guestReply: translated,
    });
    await tickUsage(query, hotel.id);
    return { tier: 'auto', guestReplyText: translated, detectedLanguage: finalLang };
  }

  // needs_approval: guest gets a holding message, staff gets the draft in their queue
  const ack = finalLang === 'en' ? TIER_ACK.needs_approval : await groq.translate(TIER_ACK.needs_approval, finalLang);
  await persistMessages({
    conversationId, guestMessage, guestLanguage: finalLang,
    tier: 'needs_approval', staffDraft: result.draft, guestReply: ack,
  });
  await tickUsage(query, hotel.id);
  return {
    tier: 'needs_approval',
    guestReplyText: ack,
    staffDraft: result.draft,
    detectedLanguage: finalLang,
  };
}

module.exports = { resolveTieredReply };
