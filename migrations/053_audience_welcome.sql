BEGIN;

-- One welcome message per subscriber after a live double opt-in confirmation.
-- welcome_snapshot holds the owner's copy at confirmation time; it contains no subscriber data.
CREATE TABLE IF NOT EXISTS public.customer_audience_welcomes (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL,
  subscriber_id uuid NOT NULL, confirmation_id uuid NOT NULL,
  welcome_snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','submitting','accepted','uncertain','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1),
  provider_id text, error_code text,
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,brand_id,id),
  UNIQUE(workspace_id,brand_id,subscriber_id),
  FOREIGN KEY(workspace_id,brand_id,subscriber_id) REFERENCES public.subscribers(workspace_id,brand_id,id),
  FOREIGN KEY(workspace_id,brand_id,confirmation_id) REFERENCES public.customer_audience_confirmations(workspace_id,brand_id,id)
);
CREATE INDEX IF NOT EXISTS customer_audience_welcomes_due
  ON public.customer_audience_welcomes(workspace_id,brand_id,state,next_check_at) WHERE state IN ('queued','submitting');
CREATE UNIQUE INDEX IF NOT EXISTS customer_audience_welcomes_provider
  ON public.customer_audience_welcomes(provider_id) WHERE provider_id IS NOT NULL;
ALTER TABLE public.customer_audience_welcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_audience_welcomes FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_policies WHERE schemaname='public' AND tablename='customer_audience_welcomes' AND policyname='customer_audience_brand_boundary'
  ) THEN
    CREATE POLICY customer_audience_brand_boundary ON public.customer_audience_welcomes
      USING(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true))
      WITH CHECK(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true));
  END IF;
END $$;
REVOKE ALL ON public.customer_audience_welcomes FROM PUBLIC;
DROP TRIGGER IF EXISTS flockletter_retention_insert_guard ON public.customer_audience_welcomes;
CREATE TRIGGER flockletter_retention_insert_guard BEFORE INSERT ON public.customer_audience_welcomes
  FOR EACH ROW EXECUTE FUNCTION public.flockletter_retention_insert_guard();
ALTER TABLE public.customer_audience_welcomes ENABLE ALWAYS TRIGGER flockletter_retention_insert_guard;

COMMIT;
