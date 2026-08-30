-- Discovery questions: a small, hotel-configurable list of things the
-- concierge proactively asks a NEW guest once (allergies, special occasions,
-- arrival time, etc.) rather than only reacting after something goes wrong.
-- The soy-allergy case that prompted this — a guest mentioning an allergy
-- only after food was already an issue — is exactly what asking early helps
-- prevent.
--
-- Kept intentionally simple for v1: one question is asked at the start of a
-- guest's first conversation; the answer isn't parsed out automatically, but
-- because it's asked and answered right there in the thread, staff see it
-- naturally via "View full conversation" without any extra tooling.

CREATE TABLE IF NOT EXISTS discovery_questions (
  id          TEXT PRIMARY KEY,
  hotel_id    TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_discovery_questions_hotel ON discovery_questions(hotel_id, sort_order);

-- Tracks whether a discovery question has already been asked in this
-- conversation, so we ask once per new guest, not on every message.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS discovery_question_asked BOOLEAN NOT NULL DEFAULT FALSE;
