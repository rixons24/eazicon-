// Runs every .sql file in /migrations in filename order.
// Idempotent: uses CREATE TABLE IF NOT EXISTS, so re-running is safe.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

async function migrate() {
  const dir = path.join(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  console.log(`[migrate] running ${files.length} migration file(s)`);
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`[migrate] → ${file}`);
    await pool.query(sql);
  }
  console.log('[migrate] done');
  await pool.end();
}

migrate().catch(err => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
