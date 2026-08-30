-- Bridges web-widget conversations to a hotel's WhatsApp Business number so
-- staff can be notified of, and reply to, guest messages without opening the
-- dashboard. This is separate from a guest messaging the hotel's WhatsApp
-- number directly (already handled by the existing webhook) — this is about
-- WEB conversations becoming visible/answerable on WhatsApp too.
--
-- staff_whatsapp_number is the manager's own personal WhatsApp number where
-- notifications get sent. whatsapp_message_links maps each outbound
-- notification's WhatsApp message id back to the originating conversation,
-- so when staff reply-with-quote on WhatsApp, we know exactly which guest
-- conversation to route the reply into (rather than guessing "most recent").

ALTER TABLE hotels ADD COLUMN IF NOT EXISTS staff_whatsapp_number TEXT;

CREATE TABLE IF NOT EXISTS whatsapp_message_links (
  id              TEXT PRIMARY KEY,
  hotel_id        TEXT NOT NULL REFERENCES hotels(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  wa_message_id   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_links_lookup ON whatsapp_message_links(hotel_id, wa_message_id);
