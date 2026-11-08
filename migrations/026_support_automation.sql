BEGIN;
ALTER TABLE customer_support_dispatches ADD COLUMN IF NOT EXISTS authority_kind text NOT NULL DEFAULT 'owner' CHECK(authority_kind IN ('owner','operator','automation'));
ALTER TABLE customer_support_dispatches ADD COLUMN IF NOT EXISTS authority_ref text;
ALTER TABLE customer_support_dispatches ADD COLUMN IF NOT EXISTS policy_version integer;
CREATE TABLE IF NOT EXISTS customer_support_policies (
 workspace_id text NOT NULL REFERENCES workspaces(workspace_id),version integer NOT NULL CHECK(version>0),
 enabled boolean NOT NULL,mode text NOT NULL CHECK(mode IN ('capture','live')),responses jsonb NOT NULL,
 guidance_digest text NOT NULL CHECK(guidance_digest ~ '^[a-f0-9]{64}$'),review_code text NOT NULL CHECK(review_code ~ '^[a-f0-9]{64}$'),
 approved_by text NOT NULL,authority_ref text NOT NULL,valid_until timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,version)
);
CREATE TABLE IF NOT EXISTS customer_support_policy_previews (
 workspace_id text NOT NULL REFERENCES workspaces(workspace_id),id uuid NOT NULL,parent_version integer NOT NULL CHECK(parent_version>=0),
 enabled boolean NOT NULL,mode text NOT NULL CHECK(mode IN ('capture','live')),responses jsonb NOT NULL,
 guidance_digest text NOT NULL,review_code text NOT NULL,valid_until timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 created_by text NOT NULL,authority_ref text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS customer_support_automation_runs (
 workspace_id text NOT NULL,id uuid NOT NULL,ticket_id uuid NOT NULL,input_version integer NOT NULL,policy_version integer NOT NULL CHECK(policy_version>=0),
 state text NOT NULL CHECK(state IN ('held','queued','accepted','uncertain','rejected')),reason text,dispatch_id uuid,
 mode text NOT NULL CHECK(mode IN ('capture','live')),created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,ticket_id,input_version,policy_version),
 FOREIGN KEY(workspace_id,ticket_id) REFERENCES customer_support_tickets(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS customer_support_threads (
 workspace_id text NOT NULL,ticket_id uuid NOT NULL,nonce uuid NOT NULL,participant_digest text NOT NULL CHECK(participant_digest ~ '^[a-f0-9]{64}$'),
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,last_message_id text,
 PRIMARY KEY(workspace_id,ticket_id),FOREIGN KEY(workspace_id,ticket_id) REFERENCES customer_support_tickets(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS customer_support_native_receipts (
 workspace_id text NOT NULL REFERENCES workspaces(workspace_id),provider_email_id uuid NOT NULL,event_id text NOT NULL,digest text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','accepted','ignored','blocked')),ticket_id uuid,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 reason text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,provider_email_id),UNIQUE(workspace_id,event_id)
);
CREATE TABLE IF NOT EXISTS customer_support_operator_audit (
 workspace_id text NOT NULL REFERENCES workspaces(workspace_id),id uuid NOT NULL,authority_ref text NOT NULL,user_id text NOT NULL,
 action text NOT NULL,ticket_id uuid,reason text NOT NULL,operation_key uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['customer_support_policies','customer_support_policy_previews','customer_support_automation_runs','customer_support_threads','customer_support_native_receipts','customer_support_operator_audit'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='workspace_boundary') THEN
   EXECUTE format('CREATE POLICY workspace_boundary ON public.%I USING (workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true))',t);
  END IF;
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
 END LOOP;
END $$;
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.support_reply_routes (
 workspace_id text NOT NULL,ticket_id uuid NOT NULL,token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 participant_digest text NOT NULL CHECK(participant_digest ~ '^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,UNIQUE(workspace_id,ticket_id)
);
REVOKE ALL ON flockletter_customer_jobs.support_reply_routes FROM PUBLIC;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.register_support_reply_route(w text,t uuid,h text,p text,e timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old flockletter_customer_jobs.support_reply_routes%ROWTYPE;
BEGIN
 IF w IS DISTINCT FROM current_setting('app.workspace_id',true) OR w IS NULL OR length(w)>200 OR h !~ '^[a-f0-9]{64}$' OR p !~ '^[a-f0-9]{64}$' OR h IS NULL OR p IS NULL OR e IS NULL OR e<=now() OR e>now()+interval '30 days' THEN RAISE EXCEPTION 'Invalid support reply route'; END IF;
 IF NOT EXISTS(SELECT FROM public.workspaces WHERE workspace_id=w) OR NOT EXISTS(SELECT FROM public.customer_support_tickets WHERE workspace_id=w AND id=t) OR EXISTS(SELECT FROM public.customer_retention_receipts WHERE workspace_id=w) THEN RAISE EXCEPTION 'Support workspace unavailable'; END IF;
 SELECT * INTO old FROM flockletter_customer_jobs.support_reply_routes WHERE workspace_id=w AND ticket_id=t FOR UPDATE;
 IF FOUND THEN
  IF old.token_hash=h AND old.participant_digest=p AND old.expires_at=e THEN RETURN; END IF;
  IF old.expires_at>now() THEN RAISE EXCEPTION 'Active support route is immutable'; END IF;
  DELETE FROM flockletter_customer_jobs.support_reply_routes WHERE workspace_id=w AND ticket_id=t;
 END IF;
 INSERT INTO flockletter_customer_jobs.support_reply_routes VALUES(w,t,h,p,e);
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.resolve_support_reply_route(h text)
RETURNS TABLE(workspace_id text,ticket_id uuid,participant_digest text,expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT r.workspace_id,r.ticket_id,r.participant_digest,r.expires_at FROM flockletter_customer_jobs.support_reply_routes r
 WHERE h ~ '^[a-f0-9]{64}$' AND r.token_hash=h AND r.expires_at>now()
 AND NOT EXISTS(SELECT FROM flockletter_retention_control.receipts x WHERE x.workspace_id=r.workspace_id)
 LIMIT 1
$$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.register_support_reply_route(text,uuid,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.resolve_support_reply_route(text) FROM PUBLIC;
COMMIT;
