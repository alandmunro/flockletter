BEGIN;
-- Previous releases ignore the additional scheduler columns and setting.
-- A code rollback can leave them in place. A schema rollback retains receipts and operator history.
ALTER TABLE public.date_automations DROP COLUMN IF EXISTS last_scan_started_at,
  DROP COLUMN IF EXISTS current_scan_started_at;
COMMIT;
