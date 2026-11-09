BEGIN;
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.confirmation_routes (
 workspace_id text NOT NULL,brand_id uuid NOT NULL,confirmation_id uuid NOT NULL,
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 recipient_digest text NOT NULL CHECK(recipient_digest ~ '^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,
 UNIQUE(workspace_id,brand_id,confirmation_id)
);
REVOKE ALL ON flockletter_customer_jobs.confirmation_routes FROM PUBLIC;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.register_confirmation_route(w text,b uuid,c uuid,h text,r text,e timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old flockletter_customer_jobs.confirmation_routes%ROWTYPE;
BEGIN
 IF w IS NULL OR w IS DISTINCT FROM current_setting('app.workspace_id',true) OR b IS NULL OR b::text IS DISTINCT FROM current_setting('app.intake_brand_id',true) OR length(w)>200 OR h IS NULL OR h !~ '^[a-f0-9]{64}$' OR r IS NULL OR r !~ '^[a-f0-9]{64}$' OR e IS NULL OR e<=clock_timestamp() OR e>clock_timestamp()+interval '90 days' THEN RAISE EXCEPTION 'Invalid confirmation route'; END IF;
 IF NOT EXISTS(SELECT FROM public.customer_audience_confirmations WHERE workspace_id=w AND brand_id=b AND id=c AND mode='live' AND state='submitting' AND attempts=1) OR EXISTS(SELECT FROM public.customer_retention_receipts WHERE workspace_id=w) OR public.flockletter_retention_blocked(w) THEN RAISE EXCEPTION 'Confirmation unavailable'; END IF;
 SELECT * INTO old FROM flockletter_customer_jobs.confirmation_routes WHERE workspace_id=w AND brand_id=b AND confirmation_id=c FOR UPDATE;
 IF FOUND THEN
  IF old.token_hash=h AND old.recipient_digest=r AND old.expires_at=e THEN RETURN; END IF;
  RAISE EXCEPTION 'Confirmation route is immutable';
 END IF;
 INSERT INTO flockletter_customer_jobs.confirmation_routes VALUES(w,b,c,h,r,e);
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.resolve_confirmation_route(h text)
RETURNS TABLE(workspace_id text,brand_id uuid,confirmation_id uuid,recipient_digest text,expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.workspace_id,r.brand_id,r.confirmation_id,r.recipient_digest,r.expires_at FROM flockletter_customer_jobs.confirmation_routes r
 WHERE h ~ '^[a-f0-9]{64}$' AND r.token_hash=h AND r.expires_at>clock_timestamp()
 AND NOT EXISTS(SELECT FROM flockletter_retention_control.receipts x WHERE x.workspace_id=r.workspace_id)
 AND NOT EXISTS(SELECT FROM flockletter_retention_control.restore_quarantines x WHERE x.workspace_id=r.workspace_id AND x.blocked)
 LIMIT 1
$$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.register_confirmation_route(text,uuid,uuid,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.resolve_confirmation_route(text) FROM PUBLIC;
CREATE TABLE IF NOT EXISTS public.customer_audience_feedback (
 workspace_id text NOT NULL,brand_id uuid NOT NULL,event_id text NOT NULL CHECK(length(event_id) BETWEEN 1 AND 200),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),confirmation_id uuid NOT NULL,provider_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('accepted','delivered','hard_bounce','complaint','failed','delayed')),
 occurred_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,brand_id,event_id),UNIQUE(event_id),
 FOREIGN KEY(workspace_id,brand_id,confirmation_id) REFERENCES public.customer_audience_confirmations(workspace_id,brand_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_confirmation_provider_binding ON public.customer_audience_confirmations(provider_id) WHERE mode='live' AND provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_audience_feedback_timeline ON public.customer_audience_feedback(workspace_id,brand_id,confirmation_id,occurred_at DESC,created_at DESC);
ALTER TABLE public.customer_audience_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_audience_feedback FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_audience_brand_boundary ON public.customer_audience_feedback;
CREATE POLICY customer_audience_brand_boundary ON public.customer_audience_feedback USING(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true));
REVOKE ALL ON public.customer_audience_feedback FROM PUBLIC;
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['flockletter_customer_jobs.confirmation_routes','public.customer_audience_feedback'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS flockletter_retention_insert_guard ON %s',target);
 EXECUTE format('CREATE TRIGGER flockletter_retention_insert_guard BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION public.flockletter_retention_insert_guard()',target);
 EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER flockletter_retention_insert_guard',target);
 END LOOP;
END $$;
COMMIT;
