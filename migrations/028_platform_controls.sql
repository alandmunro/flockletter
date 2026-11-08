BEGIN;
CREATE TABLE IF NOT EXISTS public.platform_exercise_records (
 workspace_id text NOT NULL, kind text NOT NULL CHECK(kind IN('case','health','alert','ack','inbound','approval','hold','notification')),
 id text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,kind,id)
);
ALTER TABLE public.platform_exercise_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_exercise_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_boundary ON public.platform_exercise_records;
CREATE POLICY workspace_boundary ON public.platform_exercise_records USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
CREATE TABLE IF NOT EXISTS flockletter_retention_control.platform_records (
 workspace_id text NOT NULL, kind text NOT NULL CHECK(kind IN('case','health','alert','ack','inbound','approval','hold','notification')),
 id text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,kind,id)
);
REVOKE ALL ON flockletter_retention_control.platform_records FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.flockletter_platform_hold(target text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT target=current_setting('app.workspace_id',true) AND (
 EXISTS(SELECT FROM flockletter_retention_control.platform_records WHERE workspace_id=target AND kind='hold' AND id='current' AND body->>'held'='true') OR
 EXISTS(SELECT FROM public.platform_exercise_records WHERE workspace_id=target AND kind='hold' AND id='current' AND body->>'held'='true'))
$$;
REVOKE ALL ON FUNCTION public.flockletter_platform_hold(text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION flockletter_retention_control.expire_platform_inbox() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE n integer; BEGIN
 DELETE FROM flockletter_retention_control.platform_records WHERE (workspace_id,kind,id) IN (
 SELECT workspace_id,kind,id FROM flockletter_retention_control.platform_records WHERE workspace_id='_platform_inbox' AND kind='inbound' AND created_at<clock_timestamp()-interval '90 days' ORDER BY created_at LIMIT 1000);
 GET DIAGNOSTICS n=ROW_COUNT; RETURN n;
 END $$;
REVOKE ALL ON FUNCTION flockletter_retention_control.expire_platform_inbox() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.flockletter_retention_insert_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended(NEW.workspace_id,0)) THEN RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='workspace_retention_busy'; END IF;
 IF EXISTS(SELECT FROM flockletter_retention_control.receipts WHERE workspace_id=NEW.workspace_id) OR EXISTS(SELECT FROM flockletter_retention_control.restore_quarantines WHERE workspace_id=NEW.workspace_id AND blocked) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='workspace_retention_blocked';
 END IF;
 RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION public.flockletter_retention_insert_guard() FROM PUBLIC;
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'customer_retention_receipts' AND EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND a.attnum>0 AND NOT a.attisdropped) LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS flockletter_retention_insert_guard ON public.%I',t.relname);
 EXECUTE format('CREATE TRIGGER flockletter_retention_insert_guard BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.flockletter_retention_insert_guard()',t.relname);
 EXECUTE format('ALTER TABLE public.%I ENABLE ALWAYS TRIGGER flockletter_retention_insert_guard',t.relname);
 END LOOP;
END $$;
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['flockletter_customer_jobs.scopes','flockletter_customer_jobs.support_reply_routes','flockletter_retention_control.platform_records'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS flockletter_retention_insert_guard ON %s',target);
 EXECUTE format('CREATE TRIGGER flockletter_retention_insert_guard BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION public.flockletter_retention_insert_guard()',target);
 EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER flockletter_retention_insert_guard',target);
 END LOOP;
END $$;
COMMIT;
