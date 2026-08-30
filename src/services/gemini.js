// Google Gemini API client — used as an optional translation backend when
// TRANSLATION_PROVIDER=gemini. Gemini's training data and multilingual
// tuning tends to handle Swahili and other African languages more reliably
// than Groq's currently hosted open-weight models.
//
// Get an API key: aistudio.google.com/apikey (free tier available)

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function requireKey() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing from env');
  return process.env.GEMINI_API_KEY;
}

async function translate(text, targetLang, languageNames) {
  const targetName = languageNames[targetLang] || targetLang;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const prompt = `Translate the following text to ${targetName}. Reply with ONLY the translation — no preamble, no quotes, no explanation.\n\nText: ${text}`;

  const res = await fetch(
    `${GEMINI_BASE}/models/${model}:generateContent?key=${requireKey()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini translation failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const translated = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!translated) throw new Error('Gemini returned no translation content');
  return translated.trim();
}

module.exports = { translate };
