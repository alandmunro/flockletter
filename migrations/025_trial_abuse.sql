BEGIN;
-- Pseudonymous security records: never store Clerk IDs, fingerprints or raw workspace IDs here.
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.trial_namespaces (
 namespace text PRIMARY KEY CHECK(namespace ~ '^[a-f0-9]{64}$'),
 key_tag text NOT NULL CHECK(key_tag ~ '^[a-f0-9]{64}$'),
 policy_id text NOT NULL, policy_version integer NOT NULL CHECK(policy_version>0),
 policy_mode text NOT NULL CHECK(policy_mode IN ('lifetime','bounded')),
 retention_days integer CHECK(retention_days BETWEEN 1 AND 3650),
 CHECK((policy_mode='lifetime' AND retention_days IS NULL) OR (policy_mode='bounded' AND retention_days IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.trial_claims (
 namespace text NOT NULL REFERENCES flockletter_customer_jobs.trial_namespaces(namespace),
 kind text NOT NULL CHECK(kind IN ('owner','card')),subject_digest text NOT NULL CHECK(subject_digest ~ '^[a-f0-9]{64}$'),
 workspace_digest text NOT NULL CHECK(workspace_digest ~ '^[a-f0-9]{64}$'),intent_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('reserved','consumed')),expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(namespace,kind,subject_digest)
);
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.trial_attempts (
 namespace text NOT NULL REFERENCES flockletter_customer_jobs.trial_namespaces(namespace),
 workspace_digest text NOT NULL CHECK(workspace_digest ~ '^[a-f0-9]{64}$'),intent_id uuid NOT NULL,
 owner_digest text NOT NULL CHECK(owner_digest ~ '^[a-f0-9]{64}$'),card_digest text CHECK(card_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('reserved','consumed')),expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(namespace,intent_id)
);
REVOKE ALL ON flockletter_customer_jobs.trial_namespaces,flockletter_customer_jobs.trial_claims,flockletter_customer_jobs.trial_attempts FROM PUBLIC;
-- One fixed lock serializes bounded registry changes, including retention. No identity-derived lock leaks.
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.trial_claim(
 workspace text, ns text, tag text, policy text, version integer, days integer,
 wd text, intent uuid, owner_key text, card_key text, action text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n flockletter_customer_jobs.trial_namespaces%ROWTYPE;
 a flockletter_customer_jobs.trial_attempts%ROWTYPE;
 c flockletter_customer_jobs.trial_claims%ROWTYPE;
 deadline timestamptz;
BEGIN
 IF workspace IS DISTINCT FROM current_setting('app.workspace_id',true) OR
 NOT EXISTS(SELECT FROM public.workspaces w WHERE w.workspace_id=workspace) OR
 ns !~ '^[a-f0-9]{64}$' OR tag !~ '^[a-f0-9]{64}$' OR wd !~ '^[a-f0-9]{64}$' OR owner_key !~ '^[a-f0-9]{64}$' OR
 ns IS NULL OR tag IS NULL OR wd IS NULL OR owner_key IS NULL OR intent IS NULL OR
 policy IS NULL OR length(policy) NOT BETWEEN 1 AND 80 OR version IS NULL OR version<1 OR days IS NULL OR days NOT BETWEEN 0 AND 3650 OR
 action IS NULL OR action NOT IN ('reserve','consume','status') OR (action IN ('consume','status') AND (card_key IS NULL OR card_key !~ '^[a-f0-9]{64}$')) THEN
 RAISE EXCEPTION 'Invalid trial registry scope'; END IF;
 PERFORM pg_advisory_xact_lock(725025);
 INSERT INTO flockletter_customer_jobs.trial_namespaces(namespace,key_tag,policy_id,policy_version,policy_mode,retention_days)
 VALUES(ns,tag,policy,version,CASE WHEN days=0 THEN 'lifetime' ELSE 'bounded' END,nullif(days,0)) ON CONFLICT DO NOTHING;
 SELECT * INTO n FROM flockletter_customer_jobs.trial_namespaces WHERE namespace=ns;
 IF n.key_tag<>tag OR n.policy_id<>policy OR n.policy_version<>version OR n.retention_days IS DISTINCT FROM nullif(days,0) THEN RETURN 'configuration_hold'; END IF;
 SELECT * INTO a FROM flockletter_customer_jobs.trial_attempts WHERE namespace=ns AND intent_id=intent;
 IF FOUND AND (a.owner_digest<>owner_key OR a.workspace_digest<>wd OR (a.card_digest IS NOT NULL AND a.card_digest IS DISTINCT FROM card_key AND action<>'reserve')) THEN RETURN 'identity_hold'; END IF;
 IF action='status' THEN
   IF a.state='consumed' AND a.card_digest=card_key AND (a.expires_at IS NULL OR a.expires_at>now()) AND
   (SELECT count(*) FROM flockletter_customer_jobs.trial_claims WHERE namespace=ns AND workspace_digest=wd AND intent_id=intent AND state='consumed' AND (expires_at IS NULL OR expires_at>now()) AND ((kind='owner' AND subject_digest=owner_key) OR (kind='card' AND subject_digest=card_key)))=2 THEN RETURN 'allowed'; END IF;
   RETURN 'identity_hold';
 END IF;
 IF a.state='consumed' AND (a.expires_at IS NULL OR a.expires_at>now()) THEN
   IF (SELECT count(*) FROM flockletter_customer_jobs.trial_claims WHERE namespace=ns AND workspace_digest=wd AND intent_id=intent AND state='consumed' AND (expires_at IS NULL OR expires_at>now()) AND
       ((kind='owner' AND subject_digest=owner_key) OR (kind='card' AND subject_digest=a.card_digest)))=2 THEN RETURN 'allowed'; END IF;
   RETURN 'identity_hold';
 END IF;
 IF a.intent_id IS NOT NULL AND a.expires_at<=now() THEN RETURN 'reservation_expired'; END IF;
 SELECT * INTO c FROM flockletter_customer_jobs.trial_claims WHERE namespace=ns AND kind='owner' AND subject_digest=owner_key;
 IF FOUND AND (c.expires_at IS NULL OR c.expires_at>now()) AND (c.intent_id<>intent OR c.workspace_digest<>wd) THEN RETURN 'trial_unavailable'; END IF;
 IF action='reserve' THEN
   IF a.intent_id IS NOT NULL THEN RETURN 'allowed'; END IF;
   IF (SELECT count(*) FROM flockletter_customer_jobs.trial_attempts WHERE namespace=ns AND owner_digest=owner_key AND created_at>now()-interval '24 hours')>=3 THEN RETURN 'retry_later'; END IF;
   deadline:=now()+interval '35 minutes';
   INSERT INTO flockletter_customer_jobs.trial_claims(namespace,kind,subject_digest,workspace_digest,intent_id,state,expires_at)
   VALUES(ns,'owner',owner_key,wd,intent,'reserved',deadline) ON CONFLICT(namespace,kind,subject_digest)
   DO UPDATE SET workspace_digest=excluded.workspace_digest,intent_id=excluded.intent_id,state='reserved',expires_at=excluded.expires_at,created_at=now();
   INSERT INTO flockletter_customer_jobs.trial_attempts(namespace,workspace_digest,intent_id,owner_digest,state,expires_at) VALUES(ns,wd,intent,owner_key,'reserved',deadline);
   RETURN 'allowed';
 END IF;
 IF a.intent_id IS NULL OR c.intent_id IS DISTINCT FROM intent OR c.workspace_digest IS DISTINCT FROM wd OR c.expires_at<=now() THEN RETURN 'reservation_expired'; END IF;
 SELECT * INTO c FROM flockletter_customer_jobs.trial_claims WHERE namespace=ns AND kind='card' AND subject_digest=card_key;
 IF FOUND AND (c.expires_at IS NULL OR c.expires_at>now()) AND (c.intent_id<>intent OR c.workspace_digest<>wd) THEN RETURN 'trial_unavailable'; END IF;
 deadline:=CASE WHEN days=0 THEN NULL ELSE now()+make_interval(days=>days) END;
 INSERT INTO flockletter_customer_jobs.trial_claims(namespace,kind,subject_digest,workspace_digest,intent_id,state,expires_at)
 VALUES(ns,'card',card_key,wd,intent,'consumed',deadline) ON CONFLICT(namespace,kind,subject_digest)
 DO UPDATE SET workspace_digest=excluded.workspace_digest,intent_id=excluded.intent_id,state='consumed',expires_at=excluded.expires_at;
 UPDATE flockletter_customer_jobs.trial_claims SET state='consumed',expires_at=deadline WHERE namespace=ns AND kind='owner' AND subject_digest=owner_key;
 UPDATE flockletter_customer_jobs.trial_attempts SET state='consumed',card_digest=card_key,expires_at=deadline WHERE namespace=ns AND intent_id=intent;
 RETURN 'allowed';
END $$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.trial_claim(text,text,text,text,integer,integer,text,uuid,text,text,text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.trial_retention_inventory(ns text, wd text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
 WITH records AS (
 SELECT 'claim' type,kind||':'||subject_digest id,intent_id,state,expires_at,created_at FROM flockletter_customer_jobs.trial_claims WHERE namespace=ns AND workspace_digest=wd
 UNION ALL SELECT 'attempt',intent_id::text,intent_id,state,expires_at,created_at FROM flockletter_customer_jobs.trial_attempts WHERE namespace=ns AND workspace_digest=wd
 ), summary AS (SELECT count(*)::int amount,CASE WHEN bool_or(expires_at IS NULL) THEN NULL ELSE max(expires_at) END until,coalesce(jsonb_agg(to_jsonb(records) ORDER BY type,id),'[]'::jsonb) snapshot FROM records)
 SELECT jsonb_build_object('namespace',ns,'workspaceDigest',wd,'policyId',n.policy_id,'policyVersion',n.policy_version,'policyMode',n.policy_mode,'retentionDays',n.retention_days,
 'recordCount',s.amount,'retainUntil',s.until,'digest',encode(sha256(convert_to(s.snapshot::text,'UTF8')),'hex'))
 FROM flockletter_customer_jobs.trial_namespaces n CROSS JOIN summary s WHERE n.namespace=ns
$$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.trial_expire_claims(ns text, wd text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(725025);
 DELETE FROM flockletter_customer_jobs.trial_claims WHERE namespace=ns AND workspace_digest=wd AND expires_at<=now();
 DELETE FROM flockletter_customer_jobs.trial_attempts WHERE namespace=ns AND workspace_digest=wd AND expires_at<=now();
 RETURN flockletter_customer_jobs.trial_retention_inventory(ns,wd);
END $$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.trial_retention_inventory(text,text),flockletter_customer_jobs.trial_expire_claims(text,text) FROM PUBLIC;
CREATE TABLE IF NOT EXISTS customer_trial_setups (
 workspace_id text NOT NULL REFERENCES workspaces(workspace_id),id uuid NOT NULL,
 actor_id text NOT NULL,operation_key uuid NOT NULL,plan text NOT NULL CHECK(plan IN ('starter','growth','pro')),
 source text NOT NULL CHECK(source IN ('exercise','stripe_test','stripe_live')),provider_account text NOT NULL,
 registry_namespace text NOT NULL,registry_workspace_digest text NOT NULL,owner_digest text NOT NULL,card_digest text,
 state text NOT NULL CHECK(state IN ('pending','card_verified','reviewed','activation_pending','active','denied','expired')),
 revision integer NOT NULL DEFAULT 1,checkout_id text,customer_id text,payment_method_id text,setup_intent_id text,
 review jsonb,review_hash text,review_expires_at timestamptz,activation_key uuid,approved_at timestamptz,trial_end_at timestamptz,
 subscription_id text,failure_code text,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,actor_id,operation_key)
);
ALTER TABLE customer_trial_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_trial_setups FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='customer_trial_setups' AND policyname='workspace_boundary') THEN
 CREATE POLICY workspace_boundary ON customer_trial_setups USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
 END IF;
END $$;
REVOKE ALL ON customer_trial_setups FROM PUBLIC;
COMMIT;
