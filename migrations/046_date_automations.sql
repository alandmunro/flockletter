BEGIN;
CREATE TABLE IF NOT EXISTS public.date_automations (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('birthday','anniversary')),
  revision integer NOT NULL, enabled boolean NOT NULL DEFAULT false, activated_at timestamptz,
  issuer text, actor text, mode text CHECK(mode IN ('capture','live')), scan_after uuid, next_scan timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,brand_id,kind),
  FOREIGN KEY(workspace_id,brand_id) REFERENCES public.brands(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS public.date_automation_revisions (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, kind text NOT NULL, revision integer NOT NULL,
  settings jsonb NOT NULL, PRIMARY KEY(workspace_id,brand_id,kind,revision),
  FOREIGN KEY(workspace_id,brand_id,kind) REFERENCES public.date_automations(workspace_id,brand_id,kind)
);
CREATE TABLE IF NOT EXISTS public.date_occurrences (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL, kind text NOT NULL, revision integer NOT NULL,
  date_id uuid NOT NULL, annual_year integer NOT NULL, local_date date NOT NULL, due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, zone text NOT NULL,
  state text NOT NULL CHECK(state IN ('planned','cancelled','skipped','expired','queued')),
  reason text, channel text CHECK(channel IN ('sms','email')), delivery_id uuid,
  PRIMARY KEY(workspace_id,brand_id,id), UNIQUE(workspace_id,brand_id,kind,date_id,annual_year),
  FOREIGN KEY(workspace_id,brand_id,kind,revision) REFERENCES public.date_automation_revisions(workspace_id,brand_id,kind,revision)
);
CREATE INDEX IF NOT EXISTS date_occurrences_due ON public.date_occurrences(workspace_id,brand_id,due_at,id) WHERE state='planned';
DO $body$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['date_automations','date_automation_revisions','date_occurrences'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tbl);
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=tbl AND policyname='brand_boundary') THEN
      EXECUTE format('CREATE POLICY brand_boundary ON public.%I USING(workspace_id=current_setting(''app.workspace_id'',true) AND brand_id::text=current_setting(''app.intake_brand_id'',true)) WITH CHECK(workspace_id=current_setting(''app.workspace_id'',true) AND brand_id::text=current_setting(''app.intake_brand_id'',true))',tbl);
    END IF;
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',tbl);
    EXECUTE format('DROP TRIGGER IF EXISTS flockletter_retention_insert_guard ON public.%I',tbl);
    EXECUTE format('CREATE TRIGGER flockletter_retention_insert_guard BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.flockletter_retention_insert_guard()',tbl);
    EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER flockletter_retention_insert_guard',tbl);
  END LOOP;
END $body$;
COMMIT;
