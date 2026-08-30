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
const { nanoid } = require('nanoid');
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

// WhatsApp numbers can show up with or without a leading '+', spaces, etc.
// depending on where they came from — strip everything but digits so
// comparisons are reliable.
function normalizePhone(p) {
  return (p || '').replace(/\D/g, '');
}

// Handles an incoming WhatsApp message FROM the hotel's own configured staff
// number — i.e., not a guest, but a manager replying to a notification about
// a web-widget conversation (see notifyStaffViaWhatsApp in routes/widget.js).
// Requires the reply to be a WhatsApp "reply-to" (quoting the original
// notification) so we know exactly which conversation it's for — WhatsApp
// includes message.context.id for that when a user swipes-to-reply or
// long-presses → Reply on a specific message.
async function handleStaffReply(hotel, message) {
  const quotedId = message.context?.id;
  if (!quotedId) {
    await whatsapp.sendMessage({
      phoneNumberId: hotel.whatsapp_phone_number_id,
      accessToken: hotel.whatsapp_access_token,
      to: message.from,
      text: "Please reply directly to the guest's message (swipe to reply, or long-press \u2192 Reply) so I know which conversation this is for.",
    }).catch(() => {});
    return;
  }

  const { rows } = await query(
    'SELECT conversation_id FROM whatsapp_message_links WHERE hotel_id = $1 AND wa_message_id = $2',
    [hotel.id, quotedId]
  );
  const link = rows[0];
  if (!link) {
    await whatsapp.sendMessage({
      phoneNumberId: hotel.whatsapp_phone_number_id,
      accessToken: hotel.whatsapp_access_token,
      to: message.from,
      text: "I couldn't find that conversation anymore. It may be too old to reply to this way, try the dashboard instead.",
    }).catch(() => {});
    return;
  }

  // Translate into the guest's language before it lands in the web
  // conversation — same pattern as the dashboard's approve/reply endpoints.
  // The staff member wrote in whatever language they used on WhatsApp
  // (presumably English), and the guest reads it in their own.
  const { rows: convRows } = await query('SELECT guest_language FROM conversations WHERE id = $1', [link.conversation_id]);
  const guestLang = convRows[0]?.guest_language;
  const staffText = message.text?.body || '';
  let translated = staffText;
  if (guestLang && guestLang !== 'en') {
    try { translated = await translate(staffText, guestLang); }
    catch { /* fall back to the original text if translation fails */ }
  }

  await query(
    `INSERT INTO messages (id, conversation_id, role, content_original, content_english, tier, approval_status, created_at)
     VALUES ($1, $2, 'staff', $3, $4, 'auto', 'sent', NOW())`,
    [nanoid(12), link.conversation_id, translated, staffText]
  );
  await query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [link.conversation_id]);

  // The web guest picks this up via their existing polling — no need to
  // send anything back over WhatsApp for this direction.
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

    const fromNumber = message.from; // stable per-guest identifier, used as guest_session for real guests
    const guestMessage = message.text?.body;
    if (!guestMessage) return;

    // Is this the hotel's own staff replying to a web-widget notification,
    // rather than a guest messaging the business number directly? Checked
    // before anything else — if this branch fires, we never touch the
    // normal guest-message pipeline at all.
    if (hotel.staff_whatsapp_number && normalizePhone(fromNumber) === normalizePhone(hotel.staff_whatsapp_number)) {
      await handleStaffReply(hotel, message);
      return;
    }

    const guestPhone = fromNumber;
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
