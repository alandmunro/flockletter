BEGIN;
CREATE TABLE IF NOT EXISTS public.customer_resend_senders (
 workspace_id text NOT NULL,brand_id uuid NOT NULL,operation_id uuid NOT NULL,actor_id text NOT NULL,creator_id text NOT NULL,
 captured boolean NOT NULL DEFAULT false,domain text NOT NULL,from_email text NOT NULL,sender_revision integer NOT NULL,
 state text NOT NULL CHECK(state IN('reviewed','queued','creating','configuring','awaiting_dns','verified','uncertain','held')),
 domain_id uuid,dns jsonb NOT NULL DEFAULT '[]',reason text,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,brand_id),FOREIGN KEY(workspace_id,brand_id) REFERENCES public.brands(workspace_id,id),UNIQUE(workspace_id,operation_id)
);
ALTER TABLE public.customer_resend_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_resend_senders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS brand_boundary ON public.customer_resend_senders;
CREATE POLICY brand_boundary ON public.customer_resend_senders USING(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true));
REVOKE ALL ON public.customer_resend_senders FROM PUBLIC;
CREATE OR REPLACE TRIGGER flockletter_retention_insert_guard BEFORE INSERT ON public.customer_resend_senders FOR EACH ROW EXECUTE FUNCTION public.flockletter_retention_insert_guard();
ALTER TABLE public.customer_resend_senders ENABLE ALWAYS TRIGGER flockletter_retention_insert_guard;
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.resend_domain_claims (
 domain text PRIMARY KEY,workspace_id text NOT NULL,brand_id uuid NOT NULL,operation_id uuid NOT NULL,domain_id uuid,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.resend_sender_routes (
 fingerprint text PRIMARY KEY,workspace_id text NOT NULL,brand_id uuid NOT NULL,route jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON flockletter_customer_jobs.resend_domain_claims,flockletter_customer_jobs.resend_sender_routes FROM PUBLIC;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.claim_resend_domain(target text,brand uuid,operation uuid,domain_name text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous text;old_operation uuid;BEGIN
 IF target IS DISTINCT FROM current_setting('app.workspace_id',true) OR NOT EXISTS(SELECT FROM public.customer_resend_senders s WHERE s.workspace_id=target AND s.brand_id=brand AND s.operation_id=operation AND s.domain=domain_name) THEN RETURN false;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('flockletter:resend-domain:'||domain_name,0));
 SELECT workspace_id,operation_id INTO previous,old_operation FROM flockletter_customer_jobs.resend_domain_claims WHERE domain=domain_name;
 IF FOUND THEN RETURN previous=target AND (old_operation=operation OR EXISTS(SELECT FROM flockletter_customer_jobs.resend_domain_claims WHERE domain=domain_name AND domain_id IS NOT NULL));END IF;
 INSERT INTO flockletter_customer_jobs.resend_domain_claims(domain,workspace_id,brand_id,operation_id) VALUES(domain_name,target,brand,operation);
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.register_resend_route(target text,brand uuid,fingerprint_value text,route_value jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF target IS DISTINCT FROM current_setting('app.workspace_id',true) OR route_value->>'workspaceId' IS DISTINCT FROM target OR route_value->>'brandId' IS DISTINCT FROM brand::text OR fingerprint_value !~ '^[a-f0-9]{64}$'
 OR NOT EXISTS(SELECT FROM public.customer_resend_senders s JOIN flockletter_customer_jobs.resend_domain_claims c ON(c.workspace_id,c.domain,c.domain_id)=(s.workspace_id,s.domain,s.domain_id)
 WHERE s.workspace_id=target AND s.brand_id=brand AND s.state='verified' AND s.domain_id::text=route_value->>'domainId' AND s.from_email=route_value->>'from') THEN RAISE EXCEPTION 'Resend route requires verified owned infrastructure';END IF;
 INSERT INTO flockletter_customer_jobs.resend_sender_routes(fingerprint,workspace_id,brand_id,route) VALUES(fingerprint_value,target,brand,route_value) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT FROM flockletter_customer_jobs.resend_sender_routes WHERE fingerprint=fingerprint_value AND route=route_value) THEN RAISE EXCEPTION 'Resend route conflict';END IF;
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.bind_resend_domain(target text,brand uuid,operation uuid,provider_domain uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF target IS DISTINCT FROM current_setting('app.workspace_id',true) THEN RAISE EXCEPTION 'Invalid domain scope';END IF;
 UPDATE flockletter_customer_jobs.resend_domain_claims c SET domain_id=provider_domain FROM public.customer_resend_senders s
 WHERE s.workspace_id=target AND s.brand_id=brand AND s.operation_id=operation AND s.domain_id=provider_domain AND c.workspace_id=target AND c.domain=s.domain AND (c.domain_id IS NULL OR c.domain_id=provider_domain);
 IF NOT FOUND THEN RAISE EXCEPTION 'Domain binding conflict';END IF;
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.owned_resend_domain(target text,domain_name text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT domain_id FROM flockletter_customer_jobs.resend_domain_claims WHERE workspace_id=target AND domain=domain_name AND target=current_setting('app.workspace_id',true)
$$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.resend_routes(target text)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT route FROM flockletter_customer_jobs.resend_sender_routes WHERE workspace_id=target AND target=current_setting('app.workspace_id',true) ORDER BY created_at LIMIT 101
$$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.resolve_resend_route(fingerprint_value text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT route FROM flockletter_customer_jobs.resend_sender_routes WHERE fingerprint=fingerprint_value AND fingerprint_value ~ '^[a-f0-9]{64}$'
$$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.bind_resend_domain(text,uuid,uuid,uuid),flockletter_customer_jobs.owned_resend_domain(text,text),flockletter_customer_jobs.claim_resend_domain(text,uuid,uuid,text),flockletter_customer_jobs.register_resend_route(text,uuid,text,jsonb),flockletter_customer_jobs.resend_routes(text),flockletter_customer_jobs.resolve_resend_route(text) FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['resend_domain_claims','resend_sender_routes'] LOOP
 EXECUTE format('CREATE OR REPLACE TRIGGER flockletter_retention_insert_guard BEFORE INSERT ON flockletter_customer_jobs.%I FOR EACH ROW EXECUTE FUNCTION public.flockletter_retention_insert_guard()',t);
 EXECUTE format('ALTER TABLE flockletter_customer_jobs.%I ENABLE ALWAYS TRIGGER flockletter_retention_insert_guard',t);
 END LOOP;
END $$;
COMMIT;
