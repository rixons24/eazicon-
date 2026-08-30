// Itinerary-intent short-circuit. If a guest asks anything shaped like "what
// is there to do" / "activities" / "recommend something", we skip the LLM
// and hand back a special tier that tells the widget to render the
// interactive interest picker instead of plain text — this is what actually
// triggers the itinerary builder in conversation, rather than it sitting
// unused behind the /itinerary API with no route in.
//
// Patterns cover English plus a few of the languages the widget already
// supports; the LLM classifier doesn't need to catch this one since a false
// negative here just falls through to a normal (and still useful) LLM reply.

const ITINERARY_PATTERNS = [
  /\b(things? to do|what.*(can|to) do|activit(y|ies)|excursion|itinerary|day trip|recommend(ation)?s?|sightsee|explore|tour)\b/i,
  /\b(safari|snorkel|diving|nightlife|spa|beach trip)\b/i, // direct category mentions
  // Polish / Chinese / Arabic / German / Japanese / Swahili equivalents
  /atrakcj|zwiedza|wycieczk/i,
  /活动|观光|行程|推荐|旅游/,
  /أنشطة|جولة|رحلة|نشاطات/,
  /aktivität|ausflug|sehenswürdigkeit|unternehmen/i,
  /アクティビティ|観光|ツアー|おすすめ/,
  /shughuli|matembezi|safari za/i,
];

function isItineraryIntent(text) {
  return ITINERARY_PATTERNS.some(p => p.test(text));
}

module.exports = { isItineraryIntent };
