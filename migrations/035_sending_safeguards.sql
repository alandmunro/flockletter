BEGIN;
-- No email addresses, message bodies or credentials. Runtime may only call scoped routines.
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.sending_state (
 workspace_id text PRIMARY KEY, first_sent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),next_at timestamptz,
 incident_revision integer NOT NULL DEFAULT 0, held boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.sending_admissions (
 workspace_id text NOT NULL, recipient_id uuid NOT NULL, provider text NOT NULL CHECK(provider IN('ses','resend','capture')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),accepted_at timestamptz,delivered_at timestamptz,bounced_at timestamptz,complained_at timestamptz,
 PRIMARY KEY(workspace_id,recipient_id)
);
CREATE INDEX IF NOT EXISTS sending_admissions_period ON flockletter_customer_jobs.sending_admissions(provider,created_at);
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.sending_account (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),exercise boolean NOT NULL DEFAULT false,next_at timestamptz,
 resend_retry_at timestamptz,observed_at timestamptz, snapshot_started_at timestamptz,monthly_used integer,monthly_limit integer,monthly_reset timestamptz,
 daily_used integer,daily_limit integer,daily_reset timestamptz
);
INSERT INTO flockletter_customer_jobs.sending_account(singleton) VALUES(true) ON CONFLICT DO NOTHING;
REVOKE ALL ON flockletter_customer_jobs.sending_state,flockletter_customer_jobs.sending_admissions,flockletter_customer_jobs.sending_account FROM PUBLIC;

CREATE OR REPLACE FUNCTION flockletter_customer_jobs.sending_usage(month_used integer,month_limit integer,month_reset timestamptz,day_used integer,day_limit integer,day_reset timestamptz,started timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF month_used IS NULL OR month_used<0 OR month_limit IS NULL OR month_limit<1 OR day_used IS NULL OR day_used<0 OR day_limit<1
 OR month_reset IS NULL OR month_reset<=clock_timestamp() OR month_reset>clock_timestamp()+interval '35 days'
 OR day_reset IS NULL OR day_reset<=clock_timestamp() OR day_reset>clock_timestamp()+interval '25 hours'
 OR started IS NULL OR started>clock_timestamp() OR started<clock_timestamp()-interval '30 seconds' THEN
 RAISE EXCEPTION 'Invalid sending usage observation'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('flockletter:sending-global',0));
 IF EXISTS(SELECT FROM flockletter_customer_jobs.sending_account WHERE singleton AND monthly_reset>clock_timestamp() AND monthly_reset IS DISTINCT FROM month_reset) THEN RAISE EXCEPTION 'Provider billing period changed before reset';END IF;
 UPDATE flockletter_customer_jobs.sending_account SET observed_at=clock_timestamp(),snapshot_started_at=started,
 monthly_used=CASE WHEN monthly_reset=month_reset THEN greatest(monthly_used,month_used) ELSE month_used END,
 monthly_limit=month_limit,monthly_reset=month_reset,daily_used=day_used,daily_limit=day_limit,daily_reset=day_reset
 WHERE singleton AND (snapshot_started_at IS NULL OR snapshot_started_at<=started);
END $$;

CREATE OR REPLACE FUNCTION flockletter_customer_jobs.sending_status(target text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 s flockletter_customer_jobs.sending_state; a flockletter_customer_jobs.sending_account; approval jsonb;
 phase text:='new'; daily integer:=2500; used integer; delivered integer; age_days integer:=0; blocked boolean:=false;
 warned boolean:=false; reason text[]:='{}'; count_window integer; bounce_window integer; window_hours integer; extra integer; account_used integer;
BEGIN
 IF target IS DISTINCT FROM current_setting('app.workspace_id',true) OR target !~ '^org_[A-Za-z0-9_-]{1,120}$' THEN RAISE EXCEPTION 'Invalid sending scope'; END IF;
 SELECT * INTO a FROM flockletter_customer_jobs.sending_account WHERE singleton;
 SELECT * INTO s FROM flockletter_customer_jobs.sending_state WHERE workspace_id=target;
 SELECT count(*)::integer INTO used FROM flockletter_customer_jobs.sending_admissions WHERE workspace_id=target AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 SELECT count(*)::integer INTO delivered FROM flockletter_customer_jobs.sending_admissions WHERE workspace_id=target AND delivered_at IS NOT NULL;
 IF s.first_sent_at IS NOT NULL THEN age_days:=greatest(0,floor(extract(epoch FROM clock_timestamp()-s.first_sent_at)/86400)::integer); END IF;
 SELECT body INTO approval FROM flockletter_retention_control.platform_records WHERE workspace_id=target AND kind='approval' AND id='sending-trust';
 IF approval IS NULL AND a.exercise THEN SELECT body INTO approval FROM public.platform_exercise_records WHERE workspace_id=target AND kind='approval' AND id='sending-trust'; END IF;
 IF approval->>'phase'='limited' THEN phase:='limited';daily:=100;
 ELSIF approval->>'phase'='established' AND age_days>=7 AND delivered>=100 THEN phase:='established';daily:=5000;
 ELSIF approval->>'phase'='full' AND age_days>=14 AND delivered>=500 THEN phase:='full';daily:=NULL; END IF;
 blocked:=coalesce(s.held,false) AND NOT(coalesce(approval->>'resume','false')='true' AND approval->>'incidentRevision'=s.incident_revision::text);
 IF blocked THEN reason:=array_append(reason,'sending_reputation_hold'); END IF;
 FOREACH window_hours IN ARRAY ARRAY[24,168] LOOP
  SELECT count(*) FILTER(WHERE accepted_at IS NOT NULL)::integer,count(*) FILTER(WHERE bounced_at IS NOT NULL)::integer INTO count_window,bounce_window
  FROM flockletter_customer_jobs.sending_admissions WHERE workspace_id=target AND created_at>=clock_timestamp()-make_interval(hours=>window_hours);
  IF count_window>=100 AND bounce_window*100>=count_window THEN warned:=true; END IF;
 END LOOP;
 IF daily IS NOT NULL AND used>=daily THEN reason:=array_append(reason,'sending_daily_limit'); END IF;
 SELECT * INTO a FROM flockletter_customer_jobs.sending_account WHERE singleton;
 IF a.resend_retry_at>clock_timestamp() THEN reason:=array_append(reason,'sending_provider_backoff'); END IF;
 IF a.observed_at IS NULL OR a.observed_at<clock_timestamp()-interval '120 seconds' OR a.monthly_reset<=clock_timestamp() OR a.daily_reset<=clock_timestamp() THEN
  reason:=array_append(reason,'sending_provider_usage_unavailable');
 ELSE
  SELECT count(*)::integer INTO extra FROM flockletter_customer_jobs.sending_admissions WHERE provider='resend' AND created_at>=a.snapshot_started_at;
  account_used:=a.monthly_used+extra;
  IF account_used>=floor(a.monthly_limit*0.8)::integer THEN warned:=true; END IF;
  IF account_used>=floor(a.monthly_limit*0.9)::integer OR (a.daily_limit IS NOT NULL AND a.daily_used+extra>=a.daily_limit) THEN
   reason:=array_append(reason,'sending_provider_capacity'); END IF;
 END IF;
 RETURN jsonb_build_object('phase',phase,'dailyLimit',daily,'usedToday',used,'held',blocked,'warning',warned,'codes',reason,
 'observedAt',clock_timestamp(),'revision',coalesce(s.incident_revision,0),'ageDays',age_days,'delivered',delivered);
END $$;

CREATE OR REPLACE FUNCTION flockletter_customer_jobs.sending_admit(target text,recipient uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s jsonb;mode text;now_at timestamptz:=clock_timestamp();available timestamptz;
BEGIN
 IF target IS DISTINCT FROM current_setting('app.workspace_id',true) THEN RAISE EXCEPTION 'Invalid sending scope'; END IF;
 SELECT d.mode INTO mode FROM public.customer_delivery_recipients p JOIN public.customer_deliveries d ON(d.workspace_id,d.id)=(p.workspace_id,p.delivery_id)
 WHERE p.workspace_id=target AND p.id=recipient AND p.state='prepared' AND d.state='queued';
 IF mode IS NULL THEN RAISE EXCEPTION 'Sending requires a prepared recipient'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('flockletter:sending-global',0));
 INSERT INTO flockletter_customer_jobs.sending_state(workspace_id) VALUES(target) ON CONFLICT DO NOTHING;
 DELETE FROM flockletter_customer_jobs.sending_admissions WHERE created_at<clock_timestamp()-interval '90 days';
 DELETE FROM flockletter_customer_jobs.sending_state WHERE NOT held AND last_activity_at<clock_timestamp()-interval '90 days';
 s:=flockletter_customer_jobs.sending_status(target);
 IF (s->>'held')::boolean THEN RETURN jsonb_build_object('allowed',false,'reason','sending_reputation_hold','retryAt',NULL); END IF;
 IF mode='resend' AND (s->'codes') ? 'sending_provider_backoff' THEN
  RETURN jsonb_build_object('allowed',false,'reason','sending_provider_backoff','retryAt',(SELECT resend_retry_at FROM flockletter_customer_jobs.sending_account WHERE singleton));
 END IF;
 IF mode='resend' AND (s->'codes') ?| ARRAY['sending_provider_usage_unavailable','sending_provider_capacity'] THEN
  RETURN jsonb_build_object('allowed',false,'reason',CASE WHEN (s->'codes') ? 'sending_provider_usage_unavailable' THEN 'sending_provider_usage_unavailable' ELSE 'sending_provider_capacity' END,'retryAt',now_at+interval '60 seconds'); END IF;
 -- Every prior unknown stays admitted, but is never submitted by this routine or the worker again.
 IF NOT EXISTS(SELECT FROM flockletter_customer_jobs.sending_admissions WHERE workspace_id=target AND recipient_id=recipient)
 AND (s->'codes') ? 'sending_daily_limit' THEN RETURN jsonb_build_object('allowed',false,'reason','sending_daily_limit','retryAt',(date_trunc('day',now_at AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC'); END IF;
 SELECT greatest(coalesce(a.next_at,now_at),coalesce(w.next_at,now_at)) INTO available
 FROM flockletter_customer_jobs.sending_account a CROSS JOIN flockletter_customer_jobs.sending_state w WHERE a.singleton AND w.workspace_id=target;
 IF available>now_at THEN RETURN jsonb_build_object('allowed',false,'reason','sending_rate_wait','retryAt',available); END IF;
 INSERT INTO flockletter_customer_jobs.sending_admissions(workspace_id,recipient_id,provider) VALUES(target,recipient,mode) ON CONFLICT DO NOTHING;
 UPDATE flockletter_customer_jobs.sending_state SET next_at=now_at+CASE WHEN mode='resend' THEN interval '250 milliseconds' ELSE interval '1 second' END,last_activity_at=now_at WHERE workspace_id=target;
 UPDATE flockletter_customer_jobs.sending_account SET next_at=now_at+CASE WHEN mode='resend' THEN interval '250 milliseconds' ELSE interval '500 milliseconds' END WHERE singleton;
 RETURN jsonb_build_object('allowed',true,'reason',NULL,'retryAt',NULL);
END $$;

-- A definitive throttling response applies to the Resend account, including its other workspaces.
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.sending_cooldown(target text,recipient uuid,seconds integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF target IS DISTINCT FROM current_setting('app.workspace_id',true) OR seconds IS NULL OR seconds NOT BETWEEN 1 AND 86400 OR NOT EXISTS(
  SELECT FROM public.customer_delivery_recipients p JOIN flockletter_customer_jobs.sending_admissions a ON a.workspace_id=p.workspace_id AND a.recipient_id=p.id
  WHERE p.workspace_id=target AND p.id=recipient AND p.state='submitting' AND p.attempts>0 AND a.provider='resend'
 ) THEN RAISE EXCEPTION 'Backoff requires an admitted Resend submission'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('flockletter:sending-global',0));
 UPDATE flockletter_customer_jobs.sending_account SET resend_retry_at=greatest(resend_retry_at,clock_timestamp()+make_interval(secs=>seconds)) WHERE singleton;
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.sending_outcome(target text,recipient uuid,outcome text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE fresh boolean;total integer;bounces integer;hours integer;incident boolean:=false;
BEGIN
 IF target IS DISTINCT FROM current_setting('app.workspace_id',true) OR outcome NOT IN('accepted','delivered','hard_bounce','temporary_bounce','complaint')
 OR NOT EXISTS(SELECT FROM public.customer_delivery_recipients WHERE workspace_id=target AND id=recipient AND attempts>0 AND state IN('accepted','submitting','uncertain')) THEN RAISE EXCEPTION 'Outcome requires a submitted recipient'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('flockletter:sending-global',0));
 INSERT INTO flockletter_customer_jobs.sending_state(workspace_id,first_sent_at)
 SELECT target,coalesce(d.approved_at,d.created_at) FROM public.customer_deliveries d JOIN public.customer_delivery_recipients p ON(p.workspace_id,p.delivery_id)=(d.workspace_id,d.id) WHERE p.workspace_id=target AND p.id=recipient ON CONFLICT DO NOTHING;
 INSERT INTO flockletter_customer_jobs.sending_admissions(workspace_id,recipient_id,provider,created_at)
 SELECT target,recipient,d.mode,coalesce(d.approved_at,d.created_at) FROM public.customer_deliveries d JOIN public.customer_delivery_recipients p ON(p.workspace_id,p.delivery_id)=(d.workspace_id,d.id) WHERE p.workspace_id=target AND p.id=recipient ON CONFLICT DO NOTHING;
 SELECT CASE WHEN outcome='complaint' THEN complained_at IS NULL WHEN outcome IN('hard_bounce','temporary_bounce') THEN bounced_at IS NULL ELSE false END INTO fresh
 FROM flockletter_customer_jobs.sending_admissions WHERE workspace_id=target AND recipient_id=recipient;
 UPDATE flockletter_customer_jobs.sending_admissions SET accepted_at=coalesce(accepted_at,clock_timestamp()),
 delivered_at=CASE WHEN outcome='delivered' THEN coalesce(delivered_at,clock_timestamp()) ELSE delivered_at END,
 bounced_at=CASE WHEN outcome IN('hard_bounce','temporary_bounce') THEN coalesce(bounced_at,clock_timestamp()) ELSE bounced_at END,
 complained_at=CASE WHEN outcome='complaint' THEN coalesce(complained_at,clock_timestamp()) ELSE complained_at END
 WHERE workspace_id=target AND recipient_id=recipient;
 IF fresh THEN
  incident:=outcome='complaint';
  FOREACH hours IN ARRAY ARRAY[24,168] LOOP
   SELECT count(*)::integer,count(*) FILTER(WHERE bounced_at IS NOT NULL)::integer INTO total,bounces
   FROM flockletter_customer_jobs.sending_admissions WHERE workspace_id=target AND accepted_at IS NOT NULL AND created_at>=clock_timestamp()-make_interval(hours=>hours);
   IF (total>=100 AND bounces*100>=total*2) OR (total<100 AND bounces>=2) THEN incident:=true; END IF;
  END LOOP;
  IF incident THEN UPDATE flockletter_customer_jobs.sending_state SET held=true,incident_revision=incident_revision+1,last_activity_at=clock_timestamp() WHERE workspace_id=target; END IF;
 END IF;
END $$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.sending_cooldown(text,uuid,integer),flockletter_customer_jobs.sending_usage(integer,integer,timestamptz,integer,integer,timestamptz,timestamptz),flockletter_customer_jobs.sending_status(text),flockletter_customer_jobs.sending_admit(text,uuid),flockletter_customer_jobs.sending_outcome(text,uuid,text) FROM PUBLIC;
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['sending_state','sending_admissions'] LOOP
 EXECUTE format('CREATE OR REPLACE TRIGGER flockletter_retention_insert_guard BEFORE INSERT ON flockletter_customer_jobs.%I FOR EACH ROW EXECUTE FUNCTION public.flockletter_retention_insert_guard()',table_name);
 EXECUTE format('ALTER TABLE flockletter_customer_jobs.%I ENABLE ALWAYS TRIGGER flockletter_retention_insert_guard',table_name);
 END LOOP;
END $$;
COMMIT;
