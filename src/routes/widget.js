const express = require('express');
const multer = require('multer');
const { nanoid } = require('nanoid');
const { query } = require('../db/pool');
const { loadHotel } = require('../middleware/auth');
const { resolveTieredReply } = require('../services/resolver');
const groq = require('../services/groq');
const translate = require('../services/translate');
const guestProfile = require('../services/guestProfile');
const discoveryQuestions = require('../services/discoveryQuestions');
const { ensureConversation } = require('../services/conversation');
const eleven = require('../services/elevenlabs');
const audioCache = require('../services/audioCache');
const { getPlan } = require('../services/plans');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Guest session id comes from the widget (localStorage) or is issued fresh below.
// POST /message — text message from guest
router.post('/message', loadHotel, async (req, res) => {
  const { guestMessage, guestLanguage, sessionId, channel } = req.body;
  if (!guestMessage) return res.status(400).json({ error: 'guestMessage required' });
  const session = sessionId || nanoid(12);

  try {
    const { id: conversationId, isNew } = await ensureConversation(req.hotel.id, session, channel);
    const result = await resolveTieredReply({
      hotel: req.hotel,
      conversationId,
      guestMessage,
      guestLanguage,
    });
    // Fire-and-forget-ish: awaited but wrapped in try/catch inside the service
    // itself, so a profile-tracking hiccup never breaks the guest's reply.
    await guestProfile.recordInteraction({
      hotelId: req.hotel.id, sessionId: session,
      language: result.detectedLanguage, tier: result.tier, isNewConversation: isNew,
    });

    // On a brand-new conversation, tack on one proactive question (allergies,
    // special occasion, etc.) if the hotel has one configured — skipped for
    // urgent/human-requested first messages, where it would feel tone-deaf.
    if (isNew) {
      try {
        const question = await discoveryQuestions.maybeAppendQuestion({
          hotelId: req.hotel.id, conversationId, tier: result.tier,
        });
        if (question) {
          const lang = result.detectedLanguage;
          const translatedQ = (!lang || lang === 'en') ? question : await translate(question, lang).catch(() => question);
          result.guestReplyText = `${result.guestReplyText}\n\n${translatedQ}`;
          result.guestReplyEnglish = `${result.guestReplyEnglish}\n\n${question}`;
        }
      } catch (e) {
        console.warn('[message] discovery question step failed, continuing without it', e.message);
      }
    }

    res.json({
      sessionId: session,
      conversationId,
      tier: result.tier,
      guestReply: result.guestReplyText,
      guestReplyEnglish: result.guestReplyEnglish,
      guestMessageEnglish: result.guestMessageEnglish,
      detectedLanguage: result.detectedLanguage,
    });
  } catch (e) {
    console.error('[message] error', e);
    res.status(500).json({ error: 'failed to process message' });
  }
});

// POST /voice-message — audio blob from guest, transcribe → resolve → optional TTS reply
router.post('/voice-message', upload.single('audio'), loadHotel, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required' });
  const session = req.body.sessionId || nanoid(12);
  const channel = req.body.channel || 'web';

  try {
    // 1. Transcribe with Whisper (Groq) — also detects source language
    const { transcript, detectedLanguage } = await groq.transcribe(req.file.buffer, req.file.originalname || 'voice.webm');

    // 2. Run the transcript through the same tiered logic as text
    const { id: conversationId, isNew } = await ensureConversation(req.hotel.id, session, channel);
    const result = await resolveTieredReply({
      hotel: req.hotel,
      conversationId,
      guestMessage: transcript,
      guestLanguage: detectedLanguage,
    });
    await guestProfile.recordInteraction({
      hotelId: req.hotel.id, sessionId: session,
      language: result.detectedLanguage, tier: result.tier, isNewConversation: isNew,
    });

    const response = {
      sessionId: session,
      conversationId,
      transcript,
      tier: result.tier,
      guestReply: result.guestReplyText,
      detectedLanguage: result.detectedLanguage,
    };

    // 3. Premium only: synthesize a spoken reply in the guest's language
    const plan = getPlan(req.hotel);
    if (plan.voice && req.hotel.voice_reply_enabled) {
      try {
        const audioBuf = await eleven.synthesize(result.guestReplyText);
        const audioId = audioCache.store(audioBuf, 'audio/mpeg');
        response.guestReplyAudioUrl = `${req.protocol}://${req.get('host')}/audio/${audioId}`;
      } catch (e) {
        console.warn('[voice-message] TTS failed, returning text-only reply', e.message);
        // Fall through gracefully — text reply still works
      }
    }

    res.json(response);
  } catch (e) {
    console.error('[voice-message] error', e);
    res.status(500).json({ error: 'failed to process voice message' });
  }
});

// GET /audio/:id — serve cached TTS output
router.get('/audio/:id', (req, res) => {
  const entry = audioCache.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'audio not found or expired' });
  res.set('Content-Type', entry.contentType);
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(entry.buffer);
});

// GET /branding — widget fetches this on load to self-style
router.get('/branding', loadHotel, (req, res) => {
  res.json({ name: req.hotel.name, ...(req.hotel.branding || {}) });
});

// GET /conversation-history — restores a guest's chat on page reload. The
// widget keeps sessionId in localStorage across reloads (so the backend
// already treats it as one continuing conversation for tiering purposes),
// but until now nothing ever fetched the actual prior messages back — a
// refresh silently reset the visible chat to just the greeting even though
// the conversation was still alive server-side. This closes that gap.
//
// No JWT auth here (guests aren't staff accounts) — access is scoped by
// knowing hotelId + the random sessionId, the same trust model the rest of
// the guest-facing flow already uses.
router.get('/conversation-history', loadHotel, async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const { rows: convRows } = await query(
    `SELECT id FROM conversations WHERE hotel_id = $1 AND guest_session = $2 ORDER BY created_at DESC LIMIT 1`,
    [req.hotel.id, sessionId]
  );
  if (!convRows.length) return res.json({ messages: [] });

  const { rows } = await query(
    `SELECT role, content_original, tier, created_at FROM messages
     WHERE conversation_id = $1 AND role IN ('guest', 'agent', 'staff')
     ORDER BY created_at ASC`,
    [convRows[0].id]
  );
  res.json({ messages: rows });
});

// POST /itinerary — interests in, day plan out
router.post('/itinerary', loadHotel, async (req, res) => {
  const { interests, guestLanguage, sessionId } = req.body;
  if (!Array.isArray(interests) || !interests.length) {
    return res.status(400).json({ error: 'interests array required' });
  }

  const { rows: operators } = await query(
    'SELECT * FROM operators WHERE hotel_id = $1',
    [req.hotel.id]
  );

  const activities = [];
  for (const interest of interests) {
    // Partner operators ranked first
    const partner = operators.find(o => o.tags.includes(interest) && o.partnered);
    if (partner) {
      activities.push({ ...partner, source: 'hotel_partner' });
      continue;
    }
    // General non-partner operators as fallback
    const general = operators.find(o => o.tags.includes(interest));
    if (general) activities.push({ ...general, source: 'unvetted' });
  }

  // Safari special: pick the tier matching the property type
  if (interests.includes('safari')) {
    const targetTier = /luxury|resort/i.test(req.hotel.property_type) ? 'high' :
                       /hostel|backpack|guesthouse/i.test(req.hotel.property_type) ? 'low' : 'mid';
    const safari = operators.find(o => o.category === 'safari' && o.tier === targetTier)
                || operators.find(o => o.category === 'safari');
    if (safari) activities.push({ ...safari, source: safari.partnered ? 'hotel_partner' : 'unvetted', isMultiDay: true });
  }

  // Record which categories this guest asked about — this is the strongest
  // behavioral signal for "what do our guests actually want to do", useful
  // for deciding which local operators to partner with next.
  await guestProfile.recordInterests({ hotelId: req.hotel.id, sessionId, interests });

  const response = { activities };

  // When nothing matched, translate the fallback message into whatever
  // language the guest was already chatting in — the itinerary conversation
  // up to this point (the "let's plan your day" prompt) was already in their
  // language, so the empty-state shouldn't suddenly switch to English.
  if (!activities.length) {
    const EMPTY_MSG_EN = "No matching options on file yet for those interests. Ask at the front desk and we'll help you plan something.";
    response.emptyMessage = (!guestLanguage || guestLanguage === 'en')
      ? EMPTY_MSG_EN
      : await translate(EMPTY_MSG_EN, guestLanguage).catch(() => EMPTY_MSG_EN);
  }

  res.json(response);
});

module.exports = router;
