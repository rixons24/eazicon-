require('dotenv').config();
const { Pool } = require('pg');

// Render's managed Postgres requires SSL. Local dev typically doesn't.
const isProd = process.env.NODE_ENV === 'production';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => {
  console.error('[db] unexpected pool error', err);
});

module.exports = { pool, query: (text, params) => pool.query(text, params) };
