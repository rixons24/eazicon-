// Escalation short-circuit. If any of these patterns match, we skip the LLM
// entirely and route straight to staff — cheaper (no LLM call) and safer
// (guaranteed no accidental auto-answer to a complaint).
//
// Patterns cover English + common phrasings; the LLM classifier also has an
// "urgent" tier for cases these regexes miss (Polish/Chinese/etc. complaints).

const URGENT_PATTERNS = [
  /\b(not working|doesn'?t work|broken|leak|leaking|flood|smell|smells|smoke)\b/i,
  /\b(fire|emergency|urgent|asap|immediately)\b/i,
  /\b(refund|complaint|complain|unacceptable|angry|furious|terrible|awful|worst)\b/i,
  /\b(medical|allergic|allergy|injur(y|ed)|hurt|bleeding|pain|hospital|doctor)\b/i,
  /\b(threat|dangerous|unsafe|scared|afraid|police)\b/i,
];

function isUrgent(text) {
  return URGENT_PATTERNS.some(p => p.test(text));
}

module.exports = { isUrgent };
