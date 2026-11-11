BEGIN;
-- Existing photo bytes and subscriber choices remain untouched.
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_mime_check;
ALTER TABLE assets ADD CONSTRAINT assets_mime_check CHECK(mime IN ('image/png','image/jpeg','image/webp','image/gif'));
ALTER TABLE customer_audience_settings ADD COLUMN IF NOT EXISTS confirmation_mode text NOT NULL DEFAULT 'double_opt_in';
ALTER TABLE subscriber_consent_events ADD COLUMN IF NOT EXISTS evidence_source text NOT NULL DEFAULT '';
ALTER TABLE subscriber_consent_events ADD COLUMN IF NOT EXISTS recorded_by text NOT NULL DEFAULT '';
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='customer_audience_settings'::regclass AND conname='customer_audience_confirmation_mode') THEN
    ALTER TABLE customer_audience_settings ADD CONSTRAINT customer_audience_confirmation_mode CHECK(confirmation_mode IN ('double_opt_in','single_opt_in'));
  END IF;
END $$;
COMMIT;
