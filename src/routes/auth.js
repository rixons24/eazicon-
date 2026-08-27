const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const { query } = require('../db/pool');

const router = express.Router();

// POST /auth/signup — creates account + first hotel + returns JWT + widget snippet
router.post('/signup', async (req, res) => {
  const { email, password, propertyName, propertyType, plan } = req.body;
  if (!email || !password || !propertyName) {
    return res.status(400).json({ error: 'email, password, propertyName required' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

  try {
    // Slug the property name for the hotel id — used in the widget script tag
    // and the standalone /chat/:hotelId URL. Add a short nanoid for uniqueness.
    const slug = propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
    const hotelId = `${slug}-${nanoid(6)}`;
    const accountId = nanoid(12);
    const apiKey = `kb_${nanoid(32)}`;
    const passwordHash = await bcrypt.hash(password, 10);

    await query('BEGIN');
    await query(
      'INSERT INTO accounts (id, email, password_hash) VALUES ($1, $2, $3)',
      [accountId, email.toLowerCase(), passwordHash]
    );
    await query(
      `INSERT INTO hotels (id, account_id, name, property_type, plan, trial_started_at, api_key, branding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        hotelId, accountId, propertyName, propertyType || 'boutique',
        plan || 'free',
        plan === 'trial' ? new Date() : null,
        apiKey,
        JSON.stringify({ primaryColor: '#0a2e4a', accentColor: '#a6f5c0', tagline: 'Your stay, your way' }),
      ]
    );
    await query('COMMIT');

    const token = jwt.sign({ accountId, email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      hotelId,
      apiKey,
      embedSnippet: `<script src="${req.protocol}://${req.get('host')}/widget.js" data-hotel-id="${hotelId}" async></script>`,
      chatUrl: `${req.protocol}://${req.get('host')}/chat/${hotelId}`,
    });
  } catch (e) {
    await query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(409).json({ error: 'email already registered' });
    console.error('[signup] error', e);
    res.status(500).json({ error: 'signup failed' });
  }
});

// POST /auth/signin
router.post('/signin', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const { rows } = await query('SELECT * FROM accounts WHERE email = $1', [email.toLowerCase()]);
  const account = rows[0];
  if (!account) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, account.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ accountId: account.id, email: account.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

module.exports = router;
