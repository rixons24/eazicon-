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
// Every message row stores BOTH the original-language text and an English
// version in content_english — this is what lets a manager see what a guest
// actually said even if the concierge misread the tier, without needing to
// re-translate anything themselves.
//
// Returns { tier, guestReplyText, guestReplyEnglish, guestMessageEnglish, staffDraft?, detectedLanguage }.

const { query } = require('../db/pool');
const { nanoid } = require('nanoid');
const groq = require('./groq');
const translate = require('./translate');
const { isUrgent } = require('./escalation');
const { isItineraryIntent } = require('./itineraryIntent');
const { isHumanRequest } = require('./humanRequest');
const { checkLimit, tickUsage, getPlan } = require('./plans');

const TIER_ACK = {
  urgent: 'Thank you. I have flagged this for our front desk manager who will help you right away.',
  needs_approval: "Let me check on that for you and get back with confirmation shortly.",
  limit_reached: 'This concierge has reached its message limit for now. Please ask at the front desk.',
  itinerary: "I'd love to help you plan your day! Pick what interests you and I'll put together some options.",
  human_requested: "Of course. I've let our team know, and someone will join this conversation shortly.",
};

// Cheap, zero-cost language guess from character script alone — used only for
// the itinerary prompt, where we deliberately skip the LLM call (and its
// language detection) to keep this path free. Catches the scripts that are
// visually unambiguous; Latin-script languages fall back to English here
// since telling Polish from German from Swahili needs real detection.
function guessScriptLanguage(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  return null; // Latin-script or unrecognized — caller decides the fallback
}

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

// Resolves a language for paths that skip full LLM classification (urgent,
// human-request, itinerary regex hits) and therefore get no free language
// detection. Tries cheapest-first: passed-in hint → free script guess
// (catches Chinese/Arabic/Japanese/Korean/Russian instantly) → one cheap
// standalone LLM call as a last resort for Latin-script languages a regex
// can't tell apart (Polish vs German vs Swahili all look the same).
//
// This was the actual bug behind urgent messages showing no English
// translation in the dashboard: the urgent branch had no fallback at all
// before this, so real widget traffic (which never sends a language hint)
// silently skipped translation every time.
async function resolveLanguage(guestMessage, guestLanguage) {
  if (guestLanguage) return guestLanguage;
  const scriptGuess = guessScriptLanguage(guestMessage);
  if (scriptGuess) return scriptGuess;
  try { return await groq.detectLanguage(guestMessage); }
  catch { return 'en'; }
}

// Persists both messages with full bilingual context: the guest row carries
// their original text AND its English translation; the agent row carries the
// English version staff would recognize AND whatever language the guest saw.
// Also stamps the detected language onto the conversation record itself, so
// the dashboard's language badge reflects reality instead of staying blank.
//
// approval_status is set to 'pending' for needs_approval, urgent, AND
// human_requested tiers — none of these have a draft to approve, but they DO
// need a human to mark them handled, and giving them the same pending/
// dismissed lifecycle is what lets "dismiss" actually remove them from the
// queue. Without this, those items have no status to change and reappear on
// every refresh regardless of what staff do with them.
async function persistMessages({ conversationId, guestMessage, guestMessageEnglish, tier, staffDraft, agentReplyOriginalLang, agentReplyEnglish, detectedLanguage }) {
  const needsStatus = tier === 'needs_approval' || tier === 'urgent' || tier === 'human_requested';
  await query(
    `INSERT INTO messages (id, conversation_id, role, content_original, content_english, tier, approval_status, approval_draft, created_at)
     VALUES ($1, $2, 'guest', $3, $4, $5, $6, $7, NOW())`,
    [nanoid(12), conversationId, guestMessage, guestMessageEnglish || null, tier, needsStatus ? 'pending' : null, staffDraft || null]
  );
  await query(
    `INSERT INTO messages (id, conversation_id, role, content_original, content_english, tier, created_at)
     VALUES ($1, $2, 'agent', $3, $4, $5, NOW())`,
    [nanoid(12), conversationId, agentReplyOriginalLang, agentReplyEnglish, tier]
  );
  await query(
    'UPDATE conversations SET updated_at = NOW(), guest_language = COALESCE($2, guest_language) WHERE id = $1',
    [conversationId, detectedLanguage || null]
  );
}

// Best-effort translate-to-English for the guest's own message, used purely
// for the staff-facing caption. Never blocks or fails the main reply flow.
async function toEnglish(text, lang) {
  if (!lang || lang === 'en') return null;
  try { return await translate(text, 'en'); } catch { return null; }
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
      guestReplyEnglish: TIER_ACK.limit_reached,
      guestMessageEnglish: null,
      detectedLanguage: guestLanguage || 'en',
    };
  }

  // 2. Urgent escalation (English keyword regex — the LLM path also catches non-English urgent)
  if (isUrgent(guestMessage)) {
    const targetLang = await resolveLanguage(guestMessage, guestLanguage);
    const gmEn = await toEnglish(guestMessage, targetLang);
    await persistMessages({
      conversationId, guestMessage, guestMessageEnglish: gmEn, detectedLanguage: targetLang,
      tier: 'urgent', agentReplyOriginalLang: TIER_ACK.urgent, agentReplyEnglish: TIER_ACK.urgent,
    });
    await tickUsage(query, hotel.id);
    return {
      tier: 'urgent',
      guestReplyText: TIER_ACK.urgent,
      guestReplyEnglish: TIER_ACK.urgent,
      guestMessageEnglish: gmEn,
      detectedLanguage: targetLang,
    };
  }

  // 2a. Explicit request for a human — a preference, not an emergency, so it
  // gets its own tier rather than being folded into "urgent". Skips the LLM
  // entirely: no attempt at answering, just an immediate handoff acknowledgment.
  if (isHumanRequest(guestMessage)) {
    const targetLang = await resolveLanguage(guestMessage, guestLanguage);
    const ack = targetLang === 'en' ? TIER_ACK.human_requested : await translate(TIER_ACK.human_requested, targetLang).catch(() => TIER_ACK.human_requested);
    const gmEn = await toEnglish(guestMessage, targetLang);
    await persistMessages({
      conversationId, guestMessage, guestMessageEnglish: gmEn, detectedLanguage: targetLang,
      tier: 'human_requested', agentReplyOriginalLang: ack, agentReplyEnglish: TIER_ACK.human_requested,
    });
    await tickUsage(query, hotel.id);
    return {
      tier: 'human_requested',
      guestReplyText: ack,
      guestReplyEnglish: TIER_ACK.human_requested,
      guestMessageEnglish: gmEn,
      detectedLanguage: targetLang,
    };
  }

  // 2b. Itinerary intent — "what is there to do", "activities", etc. Skips the
  // full classifyAndDraft LLM call (free, no KB context needed) and tells the
  // widget to render the interactive interest picker instead of plain text.
  // This is what actually surfaces the itinerary builder in conversation,
  // rather than it sitting unused behind the /itinerary API.
  if (isItineraryIntent(guestMessage)) {
    const targetLang = await resolveLanguage(guestMessage, guestLanguage);
    const prompt = targetLang === 'en' ? TIER_ACK.itinerary : await translate(TIER_ACK.itinerary, targetLang);
    const gmEn = await toEnglish(guestMessage, targetLang);
    await persistMessages({
      conversationId, guestMessage, guestMessageEnglish: gmEn, detectedLanguage: targetLang,
      tier: 'itinerary', agentReplyOriginalLang: prompt, agentReplyEnglish: TIER_ACK.itinerary,
    });
    await tickUsage(query, hotel.id);
    return {
      tier: 'itinerary',
      guestReplyText: prompt,
      guestReplyEnglish: TIER_ACK.itinerary,
      guestMessageEnglish: gmEn,
      detectedLanguage: targetLang,
    };
  }

  // 3. Cheap KB keyword lookup
  const kb = await loadKB(hotel.id);
  const kbHit = keywordMatchKB(kb, guestMessage);
  if (kbHit) {
    const targetLang = guestLanguage || 'en';
    const translated = targetLang === 'en' ? kbHit.answer : await translate(kbHit.answer, targetLang);
    const gmEn = await toEnglish(guestMessage, targetLang);
    await persistMessages({
      conversationId, guestMessage, guestMessageEnglish: gmEn, detectedLanguage: targetLang,
      tier: 'auto', agentReplyOriginalLang: translated, agentReplyEnglish: kbHit.answer,
    });
    await tickUsage(query, hotel.id);
    return {
      tier: 'auto',
      guestReplyText: translated,
      guestReplyEnglish: kbHit.answer,
      guestMessageEnglish: gmEn,
      detectedLanguage: targetLang,
    };
  }

  // 4. LLM classification + drafting (the expensive path)
  const model = getPlan(hotel).llmModel;
  const result = await groq.classifyAndDraft({
    guestMessage,
    hotelName: hotel.name,
    knowledgeBase: kb,
    ...(model ? { model } : {}),
  });

  // The LLM's self-reported detectedLanguage isn't perfectly reliable,
  // especially on short messages — and since translation depends entirely
  // on this value, a mislabeled "en" silently skips translation even when
  // the tier classification itself was correct. The script guess is a hard,
  // deterministic signal for non-Latin scripts (Arabic characters can never
  // be English), so it wins whenever the two disagree. This is what was
  // causing Arabic/Chinese/etc. messages to occasionally show no English
  // translation in the dashboard despite everything else working.
  let finalLang = guestLanguage || result.detectedLanguage || 'en';
  const scriptCheck = guessScriptLanguage(guestMessage);
  if (scriptCheck && scriptCheck !== finalLang) finalLang = scriptCheck;

  const gmEn = await toEnglish(guestMessage, finalLang);

  if (result.tier === 'urgent') {
    await persistMessages({
      conversationId, guestMessage, guestMessageEnglish: gmEn, detectedLanguage: finalLang,
      tier: 'urgent', agentReplyOriginalLang: TIER_ACK.urgent, agentReplyEnglish: TIER_ACK.urgent,
    });
    await tickUsage(query, hotel.id);
    return {
      tier: 'urgent',
      guestReplyText: TIER_ACK.urgent,
      guestReplyEnglish: TIER_ACK.urgent,
      guestMessageEnglish: gmEn,
      detectedLanguage: finalLang,
    };
  }

  // Caught here for any phrasing/language the free regex missed — same
  // reasoning as the itinerary branch below.
  if (result.tier === 'human_requested') {
    const ack = finalLang === 'en' ? TIER_ACK.human_requested : await translate(TIER_ACK.human_requested, finalLang);
    await persistMessages({
      conversationId, guestMessage, guestMessageEnglish: gmEn, detectedLanguage: finalLang,
      tier: 'human_requested', agentReplyOriginalLang: ack, agentReplyEnglish: TIER_ACK.human_requested,
    });
    await tickUsage(query, hotel.id);
    return {
      tier: 'human_requested',
      guestReplyText: ack,
      guestReplyEnglish: TIER_ACK.human_requested,
      guestMessageEnglish: gmEn,
      detectedLanguage: finalLang,
    };
  }

  // Caught here for any phrasing/language the free regex missed — the LLM
  // understands "I want to explore with my wife" or its equivalent in any
  // language means the same thing as "what things are there to do".
  if (result.tier === 'itinerary') {
    const prompt = finalLang === 'en' ? TIER_ACK.itinerary : await translate(TIER_ACK.itinerary, finalLang);
    await persistMessages({
      conversationId, guestMessage, guestMessageEnglish: gmEn, detectedLanguage: finalLang,
      tier: 'itinerary', agentReplyOriginalLang: prompt, agentReplyEnglish: TIER_ACK.itinerary,
    });
    await tickUsage(query, hotel.id);
    return {
      tier: 'itinerary',
      guestReplyText: prompt,
      guestReplyEnglish: TIER_ACK.itinerary,
      guestMessageEnglish: gmEn,
      detectedLanguage: finalLang,
    };
  }

  if (result.tier === 'auto') {
    const translated = finalLang === 'en' ? result.draft : await translate(result.draft, finalLang);
    await persistMessages({
      conversationId, guestMessage, guestMessageEnglish: gmEn, detectedLanguage: finalLang,
      tier: 'auto', agentReplyOriginalLang: translated, agentReplyEnglish: result.draft,
    });
    await tickUsage(query, hotel.id);
    return {
      tier: 'auto',
      guestReplyText: translated,
      guestReplyEnglish: result.draft,
      guestMessageEnglish: gmEn,
      detectedLanguage: finalLang,
    };
  }

  // needs_approval: guest gets a holding message, staff gets the draft in their queue
  const ack = finalLang === 'en' ? TIER_ACK.needs_approval : await translate(TIER_ACK.needs_approval, finalLang);
  await persistMessages({
    conversationId, guestMessage, guestMessageEnglish: gmEn, detectedLanguage: finalLang,
    tier: 'needs_approval', staffDraft: result.draft,
    agentReplyOriginalLang: ack, agentReplyEnglish: TIER_ACK.needs_approval,
  });
  await tickUsage(query, hotel.id);
  return {
    tier: 'needs_approval',
    guestReplyText: ack,
    guestReplyEnglish: TIER_ACK.needs_approval,
    guestMessageEnglish: gmEn,
    staffDraft: result.draft,
    detectedLanguage: finalLang,
  };
}

module.exports = { resolveTieredReply };
