BEGIN;
ALTER TABLE public.date_automations NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT FROM public.date_automations) THEN
    RAISE EXCEPTION 'Preserve automation definitions and annual receipts before rollback';
  END IF;
END $$;
DROP TABLE public.date_occurrences, public.date_automation_revisions, public.date_automations;
COMMIT;
