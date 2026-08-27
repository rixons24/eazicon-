const express = require('express');
const multer = require('multer');
const { nanoid } = require('nanoid');
const { query } = require('../db/pool');
const { loadHotel } = require('../middleware/auth');
const { resolveTieredReply } = require('../services/resolver');
const groq = require('../services/groq');
const eleven = require('../services/elevenlabs');
const audioCache = require('../services/audioCache');
const { getPlan } = require('../services/plans');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Get or create a conversation for a guest session (widget passes sessionId from localStorage)
async function ensureConversation(hotelId, sessionId, channel = 'web') {
  const { rows } = await query(
    'SELECT id FROM conversations WHERE hotel_id = $1 AND guest_session = $2 AND status = \'open\'',
    [hotelId, sessionId]
  );
  if (rows[0]) return rows[0].id;
  const id = nanoid(12);
  await query(
    'INSERT INTO conversations (id, hotel_id, guest_session, channel) VALUES ($1, $2, $3, $4)',
    [id, hotelId, sessionId, channel]
  );
  return id;
}

// POST /message — text message from guest
router.post('/message', loadHotel, async (req, res) => {
  const { guestMessage, guestLanguage, sessionId, channel } = req.body;
  if (!guestMessage) return res.status(400).json({ error: 'guestMessage required' });
  const session = sessionId || nanoid(12);

  try {
    const conversationId = await ensureConversation(req.hotel.id, session, channel);
    const result = await resolveTieredReply({
      hotel: req.hotel,
      conversationId,
      guestMessage,
      guestLanguage,
    });
    res.json({
      sessionId: session,
      conversationId,
      tier: result.tier,
      guestReply: result.guestReplyText,
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
    const conversationId = await ensureConversation(req.hotel.id, session, channel);
    const result = await resolveTieredReply({
      hotel: req.hotel,
      conversationId,
      guestMessage: transcript,
      guestLanguage: detectedLanguage,
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

// POST /itinerary — interests in, day plan out
router.post('/itinerary', loadHotel, async (req, res) => {
  const { interests } = req.body;
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

  res.json({ activities });
});

module.exports = router;
