const express = require('express');
const { nanoid } = require('nanoid');
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const guestProfile = require('../services/guestProfile');

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

// GET /dashboard/fetch-brand-color?url=... — best-effort brand color pull.
// Fetches the given page's HTML and looks for a declared <meta name="theme-color">.
// This is deliberately simple: extracting a "dominant color" from a logo image
// or full CSS analysis would need an image-processing library and much more
// surface area for something that's a nice-to-have, not a core feature. Many
// sites don't declare a theme-color at all, in which case we say so plainly
// rather than guessing — manual color selection always remains available.
router.get('/fetch-brand-color', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'url required' });

  let normalizedUrl = targetUrl;
  if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = `https://${normalizedUrl}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const pageRes = await fetch(normalizedUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EziconBrandFetch/1.0)' },
    });
    clearTimeout(timeout);
    if (!pageRes.ok) return res.json({ color: null, reason: 'site returned an error' });

    const html = await pageRes.text();
    const themeMatch = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,6})["']/i)
      || html.match(/<meta[^>]+content=["'](#[0-9a-fA-F]{3,6})["'][^>]+name=["']theme-color["']/i);
    if (themeMatch) return res.json({ color: themeMatch[1] });

    res.json({ color: null, reason: 'no theme-color meta tag found' });
  } catch (e) {
    res.json({ color: null, reason: 'could not fetch that site' });
  }
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
  // Two different counts, deliberately kept separate:
  //   recentCounts   — how many of each tier arrived in the last 24h (a
  //                    historical/throughput number, never goes down)
  //   pendingCounts  — how many are CURRENTLY outstanding (approval_status
  //                    = 'pending'), which is what "Needs attention" and
  //                    "Urgent" on the dashboard should actually reflect —
  //                    this is the number that should shrink as staff
  //                    dismiss or approve items.
  const { rows: recentRows } = await query(
    `SELECT tier, COUNT(*) FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.hotel_id = $1 AND m.created_at > NOW() - INTERVAL '24 hours'
     GROUP BY tier`,
    [hotel.id]
  );
  const { rows: pendingRows } = await query(
    `SELECT tier, COUNT(*) FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.hotel_id = $1 AND m.approval_status = 'pending'
     GROUP BY tier`,
    [hotel.id]
  );
  res.json({
    messages: rows,
    counts: Object.fromEntries(recentRows.map(r => [r.tier, parseInt(r.count, 10)])),
    pendingCounts: Object.fromEntries(pendingRows.map(r => [r.tier, parseInt(r.count, 10)])),
  });
});

// GET /dashboard/hotels/:hotelId/insights — aggregate language/interest
// patterns across every guest this property has talked to. Powers the
// "Guest insights" dashboard tab.
router.get('/hotels/:hotelId/insights', async (req, res) => {
  const hotel = await ownedHotel(req.account.accountId, req.params.hotelId);
  if (!hotel) return res.status(404).json({ error: 'not found' });
  const insights = await guestProfile.getInsights(hotel.id);
  res.json(insights);
});

// GET /dashboard/hotels/:hotelId/guests — individual guest profiles, most
// recently active first. Each row is one anonymous guest session with their
// primary language, top interest, and activity counts — not a name or any
// PII, just the behavior pattern.
router.get('/hotels/:hotelId/guests', async (req, res) => {
  const hotel = await ownedHotel(req.account.accountId, req.params.hotelId);
  if (!hotel) return res.status(404).json({ error: 'not found' });
  const guests = await guestProfile.listGuests(hotel.id);
  res.json({ guests });
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
  const result = await query(
    `UPDATE messages SET approval_status = 'dismissed'
     WHERE id = $1 AND conversation_id IN (
       SELECT c.id FROM conversations c
       JOIN hotels h ON h.id = c.hotel_id
       WHERE h.account_id = $2
     )
     RETURNING id`,
    [req.params.messageId, req.account.accountId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// POST /dashboard/messages/bulk-dismiss — dismiss several queue items in one
// request, backing the dashboard's "select all" + multi-dismiss control.
router.post('/messages/bulk-dismiss', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
  const result = await query(
    `UPDATE messages SET approval_status = 'dismissed'
     WHERE id = ANY($1::text[]) AND conversation_id IN (
       SELECT c.id FROM conversations c
       JOIN hotels h ON h.id = c.hotel_id
       WHERE h.account_id = $2
     )
     RETURNING id`,
    [ids, req.account.accountId]
  );
  res.json({ ok: true, dismissed: result.rows.length });
});

module.exports = router;
