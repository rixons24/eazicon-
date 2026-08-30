const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Helper: ensure the hotel belongs to the logged-in account
async function ownedHotel(accountId, hotelId) {
  const { rows } = await query('SELECT * FROM hotels WHERE id = $1 AND account_id = $2', [hotelId, accountId]);
  return rows[0] || null;
}

// GET /dashboard/hotels — list this account's properties
router.get('/hotels', async (req, res) => {
  const { rows } = await query('SELECT * FROM hotels WHERE account_id = $1 ORDER BY created_at', [req.account.accountId]);
  res.json({ hotels: rows });
});

// PATCH /dashboard/hotels/:hotelId — update branding, plan, voice toggle, etc.
router.patch('/hotels/:hotelId', async (req, res) => {
  const hotel = await ownedHotel(req.account.accountId, req.params.hotelId);
  if (!hotel) return res.status(404).json({ error: 'not found' });
  const { name, propertyType, plan, voiceReplyEnabled, branding, languages } = req.body;
  await query(
    `UPDATE hotels SET
       name = COALESCE($1, name),
       property_type = COALESCE($2, property_type),
       plan = COALESCE($3, plan),
       voice_reply_enabled = COALESCE($4, voice_reply_enabled),
       branding = COALESCE($5, branding),
       languages = COALESCE($6, languages)
     WHERE id = $7`,
    [name, propertyType, plan, voiceReplyEnabled, branding ? JSON.stringify(branding) : null, languages, hotel.id]
  );
  res.json({ ok: true });
});

// GET /dashboard/hotels/:hotelId/knowledge
router.get('/hotels/:hotelId/knowledge', async (req, res) => {
  const hotel = await ownedHotel(req.account.accountId, req.params.hotelId);
  if (!hotel) return res.status(404).json({ error: 'not found' });
  const { rows } = await query(
    'SELECT * FROM knowledge_entries WHERE hotel_id = $1 ORDER BY created_at DESC',
    [hotel.id]
  );
  res.json({ entries: rows });
});

// POST /dashboard/hotels/:hotelId/knowledge
router.post('/hotels/:hotelId/knowledge', async (req, res) => {
  const hotel = await ownedHotel(req.account.accountId, req.params.hotelId);
  if (!hotel) return res.status(404).json({ error: 'not found' });
  const { question, answer, keywords } = req.body;
  if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
  const id = nanoid(12);
  await query(
    'INSERT INTO knowledge_entries (id, hotel_id, question, answer, keywords) VALUES ($1, $2, $3, $4, $5)',
    [id, hotel.id, question, answer, keywords || []]
  );
  res.json({ id });
});

router.delete('/knowledge/:entryId', async (req, res) => {
  const { rows } = await query(
    `DELETE FROM knowledge_entries WHERE id = $1
     AND hotel_id IN (SELECT id FROM hotels WHERE account_id = $2)
     RETURNING id`,
    [req.params.entryId, req.account.accountId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// GET /dashboard/hotels/:hotelId/operators
router.get('/hotels/:hotelId/operators', async (req, res) => {
  const hotel = await ownedHotel(req.account.accountId, req.params.hotelId);
  if (!hotel) return res.status(404).json({ error: 'not found' });
  const { rows } = await query('SELECT * FROM operators WHERE hotel_id = $1 ORDER BY partnered DESC, name', [hotel.id]);
  res.json({ operators: rows });
});

router.post('/hotels/:hotelId/operators', async (req, res) => {
  const hotel = await ownedHotel(req.account.accountId, req.params.hotelId);
  if (!hotel) return res.status(404).json({ error: 'not found' });
  const { name, category, tags, price, partnered, tier, durationDays } = req.body;
  if (!name || !category) return res.status(400).json({ error: 'name and category required' });
  const id = nanoid(12);
  await query(
    `INSERT INTO operators (id, hotel_id, name, category, tags, price, partnered, tier, duration_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, hotel.id, name, category, tags || [category], price || null, !!partnered, tier || null, durationDays || 1]
  );
  res.json({ id });
});

router.delete('/operators/:operatorId', async (req, res) => {
  const { rows } = await query(
    `DELETE FROM operators WHERE id = $1
     AND hotel_id IN (SELECT id FROM hotels WHERE account_id = $2)
     RETURNING id`,
    [req.params.operatorId, req.account.accountId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// GET /dashboard/hotels/:hotelId/queue — the auto/needs_approval/urgent queue
router.get('/hotels/:hotelId/queue', async (req, res) => {
  const hotel = await ownedHotel(req.account.accountId, req.params.hotelId);
  if (!hotel) return res.status(404).json({ error: 'not found' });
  const { rows } = await query(
    `SELECT m.*, c.guest_session, c.guest_language, c.channel
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.hotel_id = $1 AND m.role = 'guest'
     ORDER BY m.created_at DESC LIMIT 100`,
    [hotel.id]
  );
  // Also send today's auto-handled count for the dashboard summary
  const { rows: countRows } = await query(
    `SELECT tier, COUNT(*) FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.hotel_id = $1 AND m.created_at > NOW() - INTERVAL '24 hours'
     GROUP BY tier`,
    [hotel.id]
  );
  res.json({ messages: rows, counts: Object.fromEntries(countRows.map(r => [r.tier, parseInt(r.count, 10)])) });
});

// GET /dashboard/conversations/:conversationId/messages — full thread, ordered
// chronologically, with both original-language text and English translations
// on every row. Used by the "View full conversation" expand in the queue so a
// manager can double-check what a guest actually said if a tier looks off.
router.get('/conversations/:conversationId/messages', async (req, res) => {
  const { rows } = await query(
    `SELECT m.* FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     JOIN hotels h ON h.id = c.hotel_id
     WHERE m.conversation_id = $1 AND h.account_id = $2
     ORDER BY m.created_at ASC`,
    [req.params.conversationId, req.account.accountId]
  );
  res.json({ messages: rows });
});

// POST /dashboard/messages/:messageId/approve — staff approves (or edits) a draft
router.post('/messages/:messageId/approve', async (req, res) => {
  const { editedText } = req.body;
  const { rows } = await query(
    `SELECT m.*, c.hotel_id FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = $1 AND c.hotel_id IN (SELECT id FROM hotels WHERE account_id = $2)`,
    [req.params.messageId, req.account.accountId]
  );
  const msg = rows[0];
  if (!msg) return res.status(404).json({ error: 'not found' });

  const finalText = editedText || msg.approval_draft;
  // Mark original guest message as approved
  await query(
    `UPDATE messages SET approval_status = $1, approval_draft = $2 WHERE id = $3`,
    [editedText ? 'edited' : 'approved', finalText, msg.id]
  );
  // Insert staff-sent reply message
  await query(
    `INSERT INTO messages (id, conversation_id, role, content_original, content_english, tier, approval_status, created_at)
     VALUES ($1, $2, 'staff', $3, $4, 'auto', 'sent', NOW())`,
    [nanoid(12), msg.conversation_id, finalText, finalText]
  );
  res.json({ ok: true, sentText: finalText });
});

router.post('/messages/:messageId/dismiss', async (req, res) => {
  await query(
    `UPDATE messages SET approval_status = 'dismissed'
     WHERE id = $1 AND conversation_id IN (
       SELECT c.id FROM conversations c
       JOIN hotels h ON h.id = c.hotel_id
       WHERE h.account_id = $2
     )`,
    [req.params.messageId, req.account.accountId]
  );
  res.json({ ok: true });
});

module.exports = router;
