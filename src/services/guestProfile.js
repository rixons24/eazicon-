// Guest behavior tracking. Every message and itinerary interaction rolls up
// into a per-guest-session profile: which languages they use, which activity
// categories they ask about, and how their messages get tiered. This powers
// the dashboard's "Guest insights" tab — a lightweight, privacy-conscious
// alternative to a full CRM, scoped to what a hotel can actually act on.
//
// Deliberately NOT tracked: name, nationality, or any identity beyond the
// anonymous session id already used elsewhere in the app. See the migration
// file for the reasoning on why language isn't treated as a nationality proxy.

const { query } = require('../db/pool');
const { nanoid } = require('nanoid');

// Called after every resolved guest message. isNewConversation increments
// conversation_count so repeat visits are distinguishable from one long chat.
async function recordInteraction({ hotelId, sessionId, language, tier, isNewConversation }) {
  const langKey = language || 'en';
  const tierKey = tier || 'auto';
  try {
    await query(
      `INSERT INTO guest_profiles (id, hotel_id, guest_session, languages, tier_counts, message_count, conversation_count, first_seen, last_seen)
       VALUES ($1, $2, $3, jsonb_build_object($4::text, 1), jsonb_build_object($5::text, 1), 1, $6, NOW(), NOW())
       ON CONFLICT (hotel_id, guest_session) DO UPDATE SET
         languages = guest_profiles.languages || jsonb_build_object($4::text, COALESCE((guest_profiles.languages->>$4)::int, 0) + 1),
         tier_counts = guest_profiles.tier_counts || jsonb_build_object($5::text, COALESCE((guest_profiles.tier_counts->>$5)::int, 0) + 1),
         message_count = guest_profiles.message_count + 1,
         conversation_count = guest_profiles.conversation_count + $6,
         last_seen = NOW()`,
      [nanoid(12), hotelId, sessionId, langKey, tierKey, isNewConversation ? 1 : 0]
    );
  } catch (e) {
    // Never let profile tracking break the actual guest-facing reply
    console.warn('[guestProfile] recordInteraction failed', e.message);
  }
}

// Called when a guest builds an itinerary — one row update per interest tag
// picked (max ~6, so looping is cheap).
async function recordInterests({ hotelId, sessionId, interests }) {
  if (!sessionId || !interests || !interests.length) return;
  for (const interest of interests) {
    try {
      await query(
        `INSERT INTO guest_profiles (id, hotel_id, guest_session, interests, first_seen, last_seen)
         VALUES ($1, $2, $3, jsonb_build_object($4::text, 1), NOW(), NOW())
         ON CONFLICT (hotel_id, guest_session) DO UPDATE SET
           interests = guest_profiles.interests || jsonb_build_object($4::text, COALESCE((guest_profiles.interests->>$4)::int, 0) + 1),
           last_seen = NOW()`,
        [nanoid(12), hotelId, sessionId, interest]
      );
    } catch (e) {
      console.warn('[guestProfile] recordInterests failed', e.message);
    }
  }
}

// Aggregate view for the dashboard: top languages, top interests, and basic
// counts across guests this hotel has talked to. sinceDate (optional) scopes
// to guests active since that cutoff — their language/interest counts are
// still lifetime totals, not counts-within-the-period, since individual
// interactions aren't timestamped in the aggregate profile row. That's a
// reasonable approximation ("who was active this month, and what does their
// overall behavior look like") rather than a perfectly period-scoped figure.
async function getInsights(hotelId, sinceDate) {
  const { rows } = await query(
    'SELECT * FROM guest_profiles WHERE hotel_id = $1 AND ($2::timestamptz IS NULL OR last_seen >= $2)',
    [hotelId, sinceDate || null]
  );

  const languageTotals = {};
  const interestTotals = {};
  let totalMessages = 0;
  let repeatGuests = 0;

  for (const p of rows) {
    for (const [lang, count] of Object.entries(p.languages || {})) {
      languageTotals[lang] = (languageTotals[lang] || 0) + count;
    }
    for (const [interest, count] of Object.entries(p.interests || {})) {
      interestTotals[interest] = (interestTotals[interest] || 0) + count;
    }
    totalMessages += p.message_count || 0;
    if ((p.conversation_count || 0) > 1) repeatGuests++;
  }

  const sortDesc = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

  return {
    totalGuests: rows.length,
    repeatGuests,
    totalMessages,
    topLanguages: sortDesc(languageTotals),
    topInterests: sortDesc(interestTotals),
  };
}

// Individual guest list for the dashboard's guest table — each guest's
// primary (most-used) language, top interest, and activity summary.
// sinceDate scopes to guests active since that cutoff, same approximation
// as getInsights above.
async function listGuests(hotelId, limit = 100, sinceDate) {
  const { rows } = await query(
    'SELECT * FROM guest_profiles WHERE hotel_id = $1 AND ($3::timestamptz IS NULL OR last_seen >= $3) ORDER BY last_seen DESC LIMIT $2',
    [hotelId, limit, sinceDate || null]
  );
  return rows.map(p => {
    const langs = Object.entries(p.languages || {}).sort((a, b) => b[1] - a[1]);
    const interests = Object.entries(p.interests || {}).sort((a, b) => b[1] - a[1]);
    return {
      guestSession: p.guest_session,
      primaryLanguage: langs[0]?.[0] || null,
      topInterest: interests[0]?.[0] || null,
      messageCount: p.message_count,
      conversationCount: p.conversation_count,
      tierCounts: p.tier_counts,
      firstSeen: p.first_seen,
      lastSeen: p.last_seen,
    };
  });
}

module.exports = { recordInteraction, recordInterests, getInsights, listGuests };
