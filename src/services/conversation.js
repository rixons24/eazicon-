// Get or create a conversation for a guest. guestSession is whatever stable
// identifier the channel provides: a random session id from localStorage
// for the web widget, or the guest's WhatsApp phone number for that channel.
// Shared across all inbound channels so the tiering/translation pipeline
// downstream never needs to know which one a message came from.

const { nanoid } = require('nanoid');
const { query } = require('../db/pool');

async function ensureConversation(hotelId, guestSession, channel = 'web') {
  const { rows } = await query(
    "SELECT id FROM conversations WHERE hotel_id = $1 AND guest_session = $2 AND status = 'open'",
    [hotelId, guestSession]
  );
  if (rows[0]) return { id: rows[0].id, isNew: false };
  const id = nanoid(12);
  await query(
    'INSERT INTO conversations (id, hotel_id, guest_session, channel) VALUES ($1, $2, $3, $4)',
    [id, hotelId, guestSession, channel]
  );
  return { id, isNew: true };
}

module.exports = { ensureConversation };
