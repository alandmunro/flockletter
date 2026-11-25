BEGIN;
ALTER TABLE public.customer_audience_import_jobs NO FORCE ROW LEVEL SECURITY;
-- Resolve pending imports before rolling back the queue.
DO $$ BEGIN
  IF EXISTS (SELECT FROM public.customer_audience_import_jobs WHERE state='queued') THEN
    RAISE EXCEPTION 'Resolve queued audience imports before rollback';
  END IF;
END $$;
DROP TABLE IF EXISTS public.customer_audience_import_jobs;
COMMIT;
