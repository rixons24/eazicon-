// Tiny in-memory audio cache for TTS output. Keyed by nanoid, expires after 1hr
// (voice replies only need to be fetched once by the widget playing them back).
//
// For production, swap this for S3 / Cloudflare R2 uploads with signed URLs
// so audio survives server restarts and can be delivered from a CDN.

const { nanoid } = require('nanoid');

const cache = new Map();
const TTL_MS = 60 * 60 * 1000;

function store(buffer, contentType = 'audio/mpeg') {
  const id = nanoid(16);
  const expiresAt = Date.now() + TTL_MS;
  cache.set(id, { buffer, contentType, expiresAt });
  return id;
}

function get(id) {
  const entry = cache.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { cache.delete(id); return null; }
  return entry;
}

// Cleanup every 15 minutes so we don't hold expired buffers forever
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of cache) if (entry.expiresAt < now) cache.delete(id);
}, 15 * 60 * 1000).unref();

module.exports = { store, get };
