// Groq API wrapper. Handles LLM completions (drafting replies + translation)
// and Whisper STT for voice messages.
//
// One provider, three uses:
//   1. classifyAndDraft() — decides the tier and drafts a suggested staff reply
//   2. translate() — translates text between languages using an LLM prompt
//   3. transcribe() — Whisper-large-v3 STT for guest voice notes

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
      model: model || process.env.GROQ_LLM_MODEL || 'llama-3.3-70b-versatile',
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
// tier is auto | needs_approval | urgent. draft is populated only for needs_approval.
async function classifyAndDraft({ guestMessage, hotelName, knowledgeBase }) {
  const kbContext = knowledgeBase.map(k => `Q: ${k.question}\nA: ${k.answer}`).join('\n\n');
  const system = `You are the AI concierge for ${hotelName}. Classify each incoming guest message and respond as JSON.

Rules for classification:
- "urgent": complaints, safety issues, broken/leaking things, health issues, angry sentiment
- "auto": routine question that can be answered directly from the knowledge base below
- "needs_approval": guest-specific request (upgrade, booking, availability, custom request) — you draft a reply, staff approves

Knowledge base for this property:
${kbContext || '(no entries yet)'}

Respond with valid JSON only, no other text, matching this shape:
{"tier": "auto" | "needs_approval" | "urgent", "detectedLanguage": "<ISO 639-1 code>", "reply": "<English reply text, or empty for urgent>"}`;

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

module.exports = { chatCompletion, translate, classifyAndDraft, transcribe };
