BEGIN;
CREATE INDEX IF NOT EXISTS contact_dates_automation_lookup
  ON public.contact_dates(workspace_id,brand_id,type,month,id) WHERE cleared_at IS NULL;
COMMIT;
