-- Guest profiles: aggregated behavior per guest across all their visits/messages.
-- Deliberately tracks LANGUAGE and BEHAVIOR, not nationality/origin — language
-- doesn't reliably indicate where someone is from (a Portuguese speaker could
-- be Brazilian, Portuguese, Angolan, Mozambican, or simply bilingual), so
-- treating it as a nationality guess risks the hotel acting on a wrong
-- assumption. Primary language and interest patterns are what's actually
-- useful and reliable: which languages guests need support in, which
-- activities they ask about most, how often the concierge escalates for them.

CREATE TABLE IF NOT EXISTS guest_profiles (
  id                  TEXT PRIMARY KEY,
  hotel_id            TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  guest_session       TEXT NOT NULL,
  languages           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {"pl": 4, "en": 1} — message counts per detected language
  interests           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {"safari": 2, "snorkel": 1} — itinerary picks
  tier_counts         JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {"auto": 5, "urgent": 1, "needs_approval": 2}
  message_count       INTEGER NOT NULL DEFAULT 0,
  conversation_count  INTEGER NOT NULL DEFAULT 0,
  first_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(hotel_id, guest_session)
);
CREATE INDEX IF NOT EXISTS idx_guest_profiles_hotel ON guest_profiles(hotel_id, last_seen DESC);
