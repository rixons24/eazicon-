// Human-handoff intent detector. Some guests just don't want to deal with an
// AI regardless of how well it answers — this catches that preference so
// they're not stuck arguing with a bot. Kept as its own tier (not merged into
// "urgent") since it's a preference, not an emergency, but gets the same
// pending/dismissed lifecycle so it shows up in the staff queue.
//
// This is the keyword-detection half; the widget also has an always-visible
// "Talk to a human" button, since discoverability matters more than matching
// every possible phrasing across every language — most guests who want this
// will use the button, not type a magic phrase.

const HUMAN_REQUEST_PATTERNS = [
  /\b(speak|talk) (to|with) (a )?(human|person|someone|staff|manager|agent|reception)\b/i,
  /\b(real|actual) (person|human)\b/i,
  /\bcan i (talk|speak) to (someone|staff|reception)\b/i,
  /\bstop (the )?bot\b/i,
  /\bnot a (bot|robot|machine)\b/i,
  // Polish / Chinese / Arabic / German / Japanese / Swahili equivalents
  /rozmawiać z (człowiekiem|osobą|pracownikiem)/i,
  /人工客服|真人|转人工/,
  /موظف بشري|شخص حقيقي|التحدث مع موظف/,
  /mit einem menschen sprechen|echte person|mitarbeiter sprechen/i,
  /人間と話したい|スタッフと話したい|オペレーター/,
  /ongea na mtu|mfanyakazi wa kweli/i,
];

function isHumanRequest(text) {
  return HUMAN_REQUEST_PATTERNS.some(p => p.test(text));
}

module.exports = { isHumanRequest };
