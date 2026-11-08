BEGIN;
ALTER TABLE sandbox_checkouts ADD COLUMN IF NOT EXISTS effective_end_at timestamptz;
COMMIT;
