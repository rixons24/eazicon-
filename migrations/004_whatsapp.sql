-- WhatsApp Business Cloud API configuration, per hotel. Each hotel connects
-- their own WhatsApp Business number via Meta's Cloud API — there's no
-- shared pool, since WhatsApp Business requires a verified number per
-- business. Hotels get these three values from their own Meta Business
-- app/dashboard and paste them into Settings; the webhook URL to register
-- with Meta is unique per hotel (encodes the hotel id in the path), which is
-- how an incoming webhook hit gets routed to the right property without
-- needing any other lookup.

ALTER TABLE hotels ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id TEXT;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS whatsapp_access_token TEXT;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS whatsapp_verify_token TEXT;
ALTER TABLE hotels ADD COLUMN IF NOT EXISTS whatsapp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
