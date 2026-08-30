// Groq API wrapper. Handles LLM completions (drafting replies + translation),
// lightweight language detection, and Whisper STT for voice messages.
//
// One provider, four uses:
//   1. classifyAndDraft() — decides the tier and drafts a suggested staff reply
//   2. translate() — translates text between languages using an LLM prompt
//   3. detectLanguage() — cheap, single-word ISO code detection (no KB context)
//   4. transcribe() — Whisper-large-v3 STT for guest voice notes

const GROQ_BASE = 'https://api.groq.com/openai/v1';

function requireKey() {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY missing from env');
  return process.env.GROQ_API_KEY;
}

async function chatCompletion({ system, user, temperature = 0.3, model }) {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${requireKey()}`,
    },
    body: JSON.stringify({
      // Fallback here matters: if GROQ_LLM_MODEL is ever unset, this must be a
      // currently-supported model, not a deprecated one (llama-3.3-70b-versatile
      // and llama-3.1-8b-instant were both retired by Groq in mid-2026).
      model: model || process.env.GROQ_LLM_MODEL || 'openai/gpt-oss-20b',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq chat completion failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// Cheap, standalone language detection — no KB context, no drafting, just a
// single ISO 639-1 code back. Used for paths (like the itinerary prompt) that
// deliberately skip the full classifyAndDraft call to stay fast/free, but
// still want better-than-script-guessing accuracy for Latin-script languages
// (Polish, German, Swahili, etc. all look the same to a regex).
async function detectLanguage(text) {
  const raw = await chatCompletion({
    system: 'Detect the language of the user\'s message. Reply with ONLY the ISO 639-1 two-letter code (e.g. "en", "pl", "sw"). No other text.',
    user: text,
    temperature: 0,
    model: process.env.GROQ_LLM_MODEL || 'openai/gpt-oss-20b', // small/fast is fine here
  });
  const code = raw.trim().toLowerCase().slice(0, 2);
  return /^[a-z]{2}$/.test(code) ? code : 'en';
}

// Translate arbitrary text into targetLang. Returns just the translated string.
// Uses GROQ_TRANSLATE_MODEL specifically (not the plan's classification model)
// because translation quality on lower-resource languages (Swahili, Amharic,
// etc.) benefits from a larger model regardless of which plan the hotel is on.
async function translate(text, targetLang) {
  if (!text || !targetLang || targetLang === 'en') return text;
  const languageMap = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', pl: 'Polish', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ar: 'Arabic', sw: 'Swahili', ru: 'Russian', nl: 'Dutch', hi: 'Hindi', tr: 'Turkish', am: 'Amharic' };
  const targetName = languageMap[targetLang] || targetLang;
  return chatCompletion({
    system: `You are a professional translator. Translate the user's text to ${targetName}, preserving tone and meaning precisely. Reply with ONLY the translation, no preamble, no quotes, no explanation.`,
    user: text,
    temperature: 0.1,
    model: process.env.GROQ_TRANSLATE_MODEL || process.env.GROQ_LLM_MODEL || 'openai/gpt-oss-120b',
  });
}

// Classify a guest message and, when relevant, draft a suggested reply for staff.
// Returns { tier, draft, detectedLanguage }.
// tier is auto | needs_approval | urgent | itinerary. draft is populated for needs_approval.
//
// "itinerary" is intentionally an LLM-judged category, not just the cheap
// keyword regex in itineraryIntent.js — that regex only catches obvious
// English phrasings ("things to do", "activities"). A guest writing "nahitaji
// kuzunguka na familia" (Swahili) or "gostaria de explorar..." (Portuguese)
// won't match any fixed keyword list in every language, but the LLM
// recognizes the intent regardless of language or phrasing. The regex stays
// as a free, instant first pass; this is the accurate fallback net.
async function classifyAndDraft({ guestMessage, hotelName, knowledgeBase }) {
  const kbContext = knowledgeBase.map(k => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n');
  const system = `You are the AI concierge for ${hotelName}. Classify each incoming guest message and respond as JSON.

Rules for classification:
- "urgent": complaints, safety issues, broken/leaking things, health issues, angry sentiment
- "itinerary": the guest wants ideas for things to do, sightseeing, excursions, exploring the area, or activities for themselves/family/partner — in ANY language or phrasing, not just obvious English keywords. This takes priority over "auto" whenever the guest is asking "what can we do" in spirit, even indirectly (e.g. "I want to explore with my wife", "we'd like to go around with the kids").
- "auto": routine question that can be answered directly from the knowledge base below (checkout time, wifi, hours, amenities)
- "needs_approval": guest-specific request (upgrade, booking, availability, custom request) — you draft a reply, staff approves

Knowledge base for this property:
${kbContext || '(no entries yet)'}

Formatting rules for "reply": plain conversational text only. NEVER use markdown — no **bold**, no bullet asterisks, no headers, no numbered lists with periods. If listing a few things, write them as a natural sentence or use simple dashes, since this text is shown directly in a plain-text chat bubble that does not render markdown. Keep it to 2-4 sentences; this is a chat reply, not an article.

For "itinerary", leave "reply" empty — the app shows an interactive activity picker instead of a text answer.

Respond with valid JSON only, no other text, matching this shape:
{"tier": "auto" | "needs_approval" | "urgent" | "itinerary", "detectedLanguage": "<ISO 639-1 code>", "reply": "<plain text reply, or empty for urgent/itinerary>"}`;

  const raw = await chatCompletion({ system, user: guestMessage, temperature: 0.2 });
  try {
    // Strip common LLM wrappers (```json blocks) before parsing
    const cleaned = raw.replace(/^```json\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      tier: parsed.tier || 'needs_approval',
      draft: parsed.reply || '',
      detectedLanguage: parsed.detectedLanguage || 'en',
    };
  } catch (e) {
    console.warn('[groq] failed to parse LLM classification, defaulting to needs_approval', raw);
    return { tier: 'needs_approval', draft: raw, detectedLanguage: 'en' };
  }
}

// Whisper STT via Groq. audioBuffer is a Node Buffer.
async function transcribe(audioBuffer, filename = 'audio.webm') {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), filename);
  form.append('model', process.env.GROQ_STT_MODEL || 'whisper-large-v3');
  form.append('response_format', 'verbose_json');

  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${requireKey()}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq transcription failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return {
    transcript: data.text,
    detectedLanguage: data.language ? data.language.slice(0, 2).toLowerCase() : 'en',
  };
}

module.exports = { chatCompletion, translate, detectLanguage, classifyAndDraft, transcribe };
