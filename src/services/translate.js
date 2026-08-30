// Translation abstraction. Groq's smaller/free-tier models can be inconsistent
// on lower-resource languages (Swahili, Amharic, etc.) since translation
// quality tracks how much of that language was in the model's training data.
//
// This module lets you pick the translation backend independently of the
// classification LLM:
//   - TRANSLATION_PROVIDER=groq (default)   — uses GROQ_TRANSLATE_MODEL,
//     which defaults to a larger model than the free-tier classification
//     model, since translation quality matters even for free-tier hotels.
//   - TRANSLATION_PROVIDER=gemini           — routes to Google's Gemini API,
//     which generally handles Swahili and other African/lower-resource
//     languages more reliably than Groq's currently hosted open models.
//
// Swap providers by changing one env var — no code changes needed elsewhere,
// since resolver.js and every route call translate(text, lang) from here.

const groq = require('./groq');
const gemini = require('./gemini');

const LANGUAGE_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', pl: 'Polish', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  ar: 'Arabic', sw: 'Swahili', ru: 'Russian', nl: 'Dutch', hi: 'Hindi',
  tr: 'Turkish', am: 'Amharic',
};

async function translate(text, targetLang) {
  if (!text || !targetLang) return text;

  const provider = (process.env.TRANSLATION_PROVIDER || 'groq').toLowerCase();

  if (provider === 'gemini' && process.env.GEMINI_API_KEY) {
    try {
      return await gemini.translate(text, targetLang, LANGUAGE_NAMES);
    } catch (e) {
      console.warn('[translate] Gemini failed, falling back to Groq:', e.message);
      // Fall through to Groq rather than failing the whole guest message
    }
  }

  return groq.translate(text, targetLang);
}

module.exports = translate;
