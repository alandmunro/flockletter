BEGIN;
ALTER TABLE public.date_automations ADD COLUMN IF NOT EXISTS last_scan_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS current_scan_started_at timestamptz;

-- Preserve operator overrides and the audit history when the migrations are replayed.
WITH seeded AS (
  INSERT INTO flockletter_customer_jobs.texting_settings(key,workspace_id,value)
    VALUES ('annual_catch_up_days',NULL,'2'::jsonb) ON CONFLICT DO NOTHING RETURNING key,value
)
INSERT INTO flockletter_customer_jobs.texting_setting_changes(key,workspace_id,old_value,new_value,actor_id,interface,reason)
  SELECT key,NULL,NULL,value,'migration:048','migration','Two local days for annual greeting recovery (REL-7).' FROM seeded;
COMMIT;
