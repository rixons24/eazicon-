// ElevenLabs text-to-speech. Used only on the premium plan for voice replies.
// Returns raw MP3 audio bytes; the caller decides how to persist/serve them.
//
// In production you'd upload the buffer to S3/Cloudflare R2 and return a signed
// URL; for MVP we serve directly from an in-memory cache keyed by a nanoid.

const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';

function requireKey() {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY missing from env');
  return process.env.ELEVENLABS_API_KEY;
}

// ElevenLabs auto-detects the language from the text with their multilingual
// model, so we don't need to pass a language code — just the target voice.
async function synthesize(text, voiceId) {
  const voice = voiceId || process.env.ELEVENLABS_DEFAULT_VOICE_ID;
  if (!voice) throw new Error('ELEVENLABS_DEFAULT_VOICE_ID missing from env');

  const res = await fetch(`${ELEVEN_BASE}/text-to-speech/${voice}`, {
    method: 'POST',
    headers: {
      'xi-api-key': requireKey(),
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${err}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { synthesize };
