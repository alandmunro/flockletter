BEGIN;

CREATE TABLE IF NOT EXISTS public.customer_audience_import_jobs (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL,
  actor_id text NOT NULL, user_id text NOT NULL, actor_kind text NOT NULL CHECK (actor_kind IN ('session','connection')),
  mode text NOT NULL CHECK (mode IN ('exercise','live')),
  input jsonb, result jsonb, error_code text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','complete','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,brand_id,id),
  FOREIGN KEY(workspace_id,brand_id) REFERENCES public.brands(workspace_id,id),
  CHECK ((state='queued') = (input IS NOT NULL)),
  CHECK ((state='complete') = (result IS NOT NULL)),
  CHECK ((state='failed') = (error_code IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_audience_one_queued_import
  ON public.customer_audience_import_jobs(workspace_id,brand_id) WHERE state='queued';
ALTER TABLE public.customer_audience_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_audience_import_jobs FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_policies WHERE schemaname='public' AND tablename='customer_audience_import_jobs' AND policyname='brand_boundary'
  ) THEN
    CREATE POLICY brand_boundary ON public.customer_audience_import_jobs
      USING(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true))
      WITH CHECK(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true));
  END IF;
END $$;
REVOKE ALL ON public.customer_audience_import_jobs FROM PUBLIC;
DROP TRIGGER IF EXISTS flockletter_retention_insert_guard ON public.customer_audience_import_jobs;
CREATE TRIGGER flockletter_retention_insert_guard BEFORE INSERT ON public.customer_audience_import_jobs
  FOR EACH ROW EXECUTE FUNCTION public.flockletter_retention_insert_guard();
ALTER TABLE public.customer_audience_import_jobs ENABLE ALWAYS TRIGGER flockletter_retention_insert_guard;

COMMIT;
