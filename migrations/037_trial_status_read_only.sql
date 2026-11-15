BEGIN;
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
 -- Observation never creates a namespace or takes the global registry write lock.
 -- An existing accepted trial still needs the exact namespace, attempt, and both claims.
 IF action <> 'status' THEN
   PERFORM pg_advisory_xact_lock(725025);
   INSERT INTO flockletter_customer_jobs.trial_namespaces(namespace,key_tag,policy_id,policy_version,policy_mode,retention_days)
   VALUES(ns,tag,policy,version,CASE WHEN days=0 THEN 'lifetime' ELSE 'bounded' END,nullif(days,0)) ON CONFLICT DO NOTHING;
 END IF;
 SELECT * INTO n FROM flockletter_customer_jobs.trial_namespaces WHERE namespace=ns;
 IF NOT FOUND OR n.key_tag<>tag OR n.policy_id<>policy OR n.policy_version<>version OR n.retention_days IS DISTINCT FROM nullif(days,0) THEN RETURN 'configuration_hold'; END IF;
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
COMMIT;
