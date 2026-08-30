// WhatsApp Business Cloud API webhook. Each hotel gets a unique webhook URL
// (this route's :hotelId segment) to register in their own Meta Business
// app — that's how an incoming message gets routed to the right property
// without any other lookup.
//
// Scope for v1: text messages only. WhatsApp also carries voice notes,
// images, and template messages; none of those are handled here yet — a
// voice note from a guest is acknowledged (200 OK, so Meta doesn't retry)
// but silently skipped rather than transcribed. That's the same voice gap
// that exists on the web widget's premium tier, just not wired up for this
// channel yet either.

const express = require('express');
const { query } = require('../db/pool');
const { ensureConversation } = require('../services/conversation');
const { resolveTieredReply } = require('../services/resolver');
const guestProfile = require('../services/guestProfile');
const discoveryQuestions = require('../services/discoveryQuestions');
const translate = require('../services/translate');
const whatsapp = require('../services/whatsapp');

const router = express.Router();

async function loadHotelForWebhook(hotelId) {
  const { rows } = await query('SELECT * FROM hotels WHERE id = $1', [hotelId]);
  return rows[0] || null;
}

// GET /webhooks/whatsapp/:hotelId — Meta's verification handshake, run once
// when the hotel registers this URL in their Meta app dashboard. Meta sends
// hub.mode, hub.verify_token, hub.challenge as query params; respond with
// the challenge value if the verify token matches what this hotel configured.
router.get('/:hotelId', async (req, res) => {
  const hotel = await loadHotelForWebhook(req.params.hotelId);
  if (!hotel) return res.sendStatus(404);

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && hotel.whatsapp_verify_token && token === hotel.whatsapp_verify_token) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// POST /webhooks/whatsapp/:hotelId — incoming message events from Meta.
router.post('/:hotelId', async (req, res) => {
  // Always 200 immediately-ish — Meta retries aggressively on non-2xx
  // responses, and we don't want a slow LLM call to trigger duplicate
  // delivery. Errors are logged, not surfaced to Meta.
  res.sendStatus(200);

  try {
    const hotel = await loadHotelForWebhook(req.params.hotelId);
    if (!hotel || !hotel.whatsapp_enabled) return;

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // No message payload — this is likely a delivery/read status update,
    // which Meta posts to the same webhook. Nothing to do.
    if (!message) return;

    // Text only for v1 — see file header. Voice notes, images, etc. are
    // acknowledged (200 already sent above) but not processed.
    if (message.type !== 'text') {
      console.log(`[whatsapp] skipping unsupported message type "${message.type}" for hotel ${hotel.id}`);
      return;
    }

    const guestPhone = message.from; // stable per-guest identifier, used as guest_session
    const guestMessage = message.text?.body;
    if (!guestMessage) return;

    const { id: conversationId, isNew } = await ensureConversation(hotel.id, guestPhone, 'whatsapp');
    const result = await resolveTieredReply({
      hotel,
      conversationId,
      guestMessage,
      guestLanguage: null, // WhatsApp doesn't tell us the guest's language any more than the web widget does
    });

    await guestProfile.recordInteraction({
      hotelId: hotel.id, sessionId: guestPhone,
      language: result.detectedLanguage, tier: result.tier, isNewConversation: isNew,
    });

    let replyText = result.guestReplyText;
    if (isNew) {
      try {
        const question = await discoveryQuestions.maybeAppendQuestion({ hotelId: hotel.id, conversationId, tier: result.tier });
        if (question) {
          const lang = result.detectedLanguage;
          const translatedQ = (!lang || lang === 'en') ? question : await translate(question, lang).catch(() => question);
          replyText = `${replyText}\n\n${translatedQ}`;
        }
      } catch (e) {
        console.warn('[whatsapp] discovery question step failed, continuing without it', e.message);
      }
    }

    // Itinerary tier has no interactive picker on WhatsApp (that's a widget-
    // only UI) — the guest just gets the prompt as plain text and can name
    // what they're after directly, which still routes correctly next turn.
    await whatsapp.sendMessage({
      phoneNumberId: hotel.whatsapp_phone_number_id,
      accessToken: hotel.whatsapp_access_token,
      to: guestPhone,
      text: replyText,
    });
  } catch (e) {
    console.error('[whatsapp] webhook processing failed', e);
  }
});

module.exports = router;
