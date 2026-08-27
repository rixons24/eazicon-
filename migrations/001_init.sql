-- Karibu backend schema. Run with `npm run migrate`.
-- Every table uses TEXT ids so we can use nanoid slugs (readable in URLs like /chat/zanzi-boutique-01).

CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hotels (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  property_type         TEXT NOT NULL DEFAULT 'boutique',
  plan                  TEXT NOT NULL DEFAULT 'free',            -- free | standard | premium | trial
  trial_started_at      TIMESTAMPTZ,
  voice_reply_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  languages             TEXT[] NOT NULL DEFAULT ARRAY['en'],
  branding              JSONB  NOT NULL DEFAULT '{}'::jsonb,     -- {logoUrl, primaryColor, accentColor, tagline}
  usage_messages_month  INTEGER NOT NULL DEFAULT 0,
  usage_reset_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  api_key               TEXT UNIQUE NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hotels_account ON hotels(account_id);
CREATE INDEX IF NOT EXISTS idx_hotels_api_key ON hotels(api_key);

-- Knowledge base: one row per Q&A entry the hotel has taught the concierge.
-- Kept simple (keyword matching) for MVP; add pgvector + embeddings later for RAG.
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id          TEXT PRIMARY KEY,
  hotel_id    TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  keywords    TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_hotel ON knowledge_entries(hotel_id);

-- Operators: local tour/activity providers. Partnered ones get priority in itineraries.
CREATE TABLE IF NOT EXISTS operators (
  id          TEXT PRIMARY KEY,
  hotel_id    TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,                                       -- snorkel | safari | culture | food | spa | nightlife | transport
  tags        TEXT[] NOT NULL DEFAULT '{}',
  price       NUMERIC(10,2),
  currency    TEXT NOT NULL DEFAULT 'USD',
  unit        TEXT NOT NULL DEFAULT 'per_person',
  partnered   BOOLEAN NOT NULL DEFAULT FALSE,
  commission  NUMERIC(5,4) DEFAULT 0,
  tier        TEXT,                                                -- low | mid | high (only meaningful for multi-tier categories like safari)
  duration_days INTEGER DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_operators_hotel ON operators(hotel_id);
CREATE INDEX IF NOT EXISTS idx_operators_category ON operators(hotel_id, category);

-- Conversations: one per guest thread. Guest is identified by a short session id
-- issued by the widget (persists across page loads via localStorage or cookie).
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  hotel_id        TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  guest_session   TEXT NOT NULL,
  guest_language  TEXT,
  channel         TEXT NOT NULL DEFAULT 'web',                     -- web | whatsapp | instagram | qr
  status          TEXT NOT NULL DEFAULT 'open',                    -- open | resolved
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conv_hotel ON conversations(hotel_id, status, updated_at DESC);

-- Messages within a conversation. Tier is set by the resolver; approval_status
-- tracks the staff review flow for tier=needs_approval items.
CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL,                                 -- guest | agent | staff
  content_original  TEXT NOT NULL,
  content_english   TEXT,
  tier              TEXT,                                          -- auto | needs_approval | urgent | limit_reached
  approval_status   TEXT,                                          -- pending | approved | edited | sent | dismissed
  approval_draft    TEXT,
  audio_url         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_pending ON messages(approval_status) WHERE approval_status = 'pending';

-- Booking requests: itinerary/upgrade requests routed to staff.
CREATE TABLE IF NOT EXISTS booking_requests (
  id               TEXT PRIMARY KEY,
  hotel_id         TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  type             TEXT NOT NULL,                                  -- upgrade | itinerary | activity
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',                -- pending | confirmed | declined
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bookings_hotel ON booking_requests(hotel_id, status, created_at DESC);
