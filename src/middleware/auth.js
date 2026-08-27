const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');

// Two auth patterns:
//   requireAuth  → for dashboard routes: verifies a JWT and loads the account
//   requireHotel → for widget-facing routes: looks up hotel by hotelId + verifies
//                  the request came from an allowed origin (loose check for MVP)

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.account = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// Loads the hotel row and attaches it to req.hotel. Widget-facing routes call
// this; they identify the hotel by hotelId in body or query (the same id
// baked into the embed script tag), NOT by JWT.
async function loadHotel(req, res, next) {
  const hotelId = req.body?.hotelId || req.query?.hotelId || req.params?.hotelId;
  if (!hotelId) return res.status(400).json({ error: 'hotelId required' });
  const { rows } = await query('SELECT * FROM hotels WHERE id = $1', [hotelId]);
  if (!rows[0]) return res.status(404).json({ error: 'hotel not found' });
  req.hotel = rows[0];
  next();
}

module.exports = { requireAuth, loadHotel };
