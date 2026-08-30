// Itinerary-intent short-circuit. If a guest asks something shaped like "what
// is there to do" / "activities" — genuinely open-ended browsing, not a
// specific named request — we skip the LLM and hand back a special tier that
// tells the widget to render the interactive interest picker instead of
// plain text. This is what actually triggers the itinerary builder in
// conversation, rather than it sitting unused behind the /itinerary API.
//
// Deliberately narrow: words like "recommend", "tour", and "excursion" were
// removed from this list because they're just as likely to appear in a
// SPECIFIC request ("can you recommend a tour to swim with dolphins") as a
// general one, and this regex has no way to tell the difference — it would
// wrongly short-circuit straight to the generic picker before the smarter
// LLM classification (which correctly routes specific asks to needs_approval
// instead) ever gets a chance to run. A false negative here just falls
// through to that LLM path, which is the safer failure mode.
//
// Patterns cover English plus a few of the languages the widget already
// supports; the non-English patterns still carry some of this same risk
// since they're coarser groupings, but English is where this bug was
// actually observed, so that's where the fix is most precise.

const ITINERARY_PATTERNS = [
  /\b(things? to do|what.*(can|to) do|itinerary|day trip|sightsee|explore)\b/i,
  /\b(safari|snorkel|diving|nightlife|spa|beach trip)\b/i, // categories our picker actually covers
  // Polish / Chinese / Arabic / German / Japanese / Swahili equivalents
  /atrakcj|zwiedza|wycieczk/i,
  /活动|观光|行程|旅游/,
  /أنشطة|جولة|رحلة|نشاطات/,
  /aktivität|ausflug|sehenswürdigkeit|unternehmen/i,
  /アクティビティ|観光|ツアー/,
  /shughuli|matembezi|safari za/i,
];

function isItineraryIntent(text) {
  return ITINERARY_PATTERNS.some(p => p.test(text));
}

module.exports = { isItineraryIntent };
