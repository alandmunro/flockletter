BEGIN;
ALTER TABLE public.customer_deliveries ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'broadcast';
ALTER TABLE public.customer_deliveries ADD COLUMN IF NOT EXISTS test_day date;
ALTER TABLE public.customer_deliveries ADD COLUMN IF NOT EXISTS test_slot smallint;
ALTER TABLE public.customer_deliveries ADD COLUMN IF NOT EXISTS test_admitted_at timestamptz;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='public.customer_deliveries'::regclass AND conname='customer_test_send_snapshot') THEN
  ALTER TABLE public.customer_deliveries ADD CONSTRAINT customer_test_send_snapshot CHECK(
   (purpose='broadcast' AND test_day IS NULL AND test_slot IS NULL AND test_admitted_at IS NULL)
   OR (purpose='test' AND selected=1 AND (
    (test_day IS NULL AND test_slot IS NULL AND test_admitted_at IS NULL AND state IN('reviewed','cancelled') AND approved_at IS NULL AND reservation_key IS NULL)
    OR (test_day IS NOT NULL AND test_slot IS NOT NULL AND test_slot BETWEEN 1 AND 5 AND test_admitted_at IS NOT NULL
     AND test_day=(test_admitted_at AT TIME ZONE 'UTC')::date)
   ))
  );
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS customer_test_send_daily_slots ON public.customer_deliveries(workspace_id,test_day,test_slot) WHERE purpose='test' AND test_day IS NOT NULL;
CREATE OR REPLACE FUNCTION public.flockletter_customer_test_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.purpose='test' AND (NEW.test_day IS NOT NULL OR NEW.test_slot IS NOT NULL OR NEW.test_admitted_at IS NOT NULL) THEN RAISE EXCEPTION 'test_admission_must_start_empty'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.purpose IS DISTINCT FROM OLD.purpose THEN RAISE EXCEPTION 'test_purpose_immutable'; END IF;
 IF OLD.purpose='test' THEN
  IF ROW(NEW.workspace_id,NEW.brand_id,NEW.id,NEW.campaign_id,NEW.version,NEW.actor_id,NEW.creator_id,NEW.mode,NEW.content,NEW.rendered_html,NEW.rendered_text,NEW.asset_digests,NEW.provider_binding,NEW.sender_profile,NEW.due_at,NEW.selected,NEW.excluded)
   IS DISTINCT FROM ROW(OLD.workspace_id,OLD.brand_id,OLD.id,OLD.campaign_id,OLD.version,OLD.actor_id,OLD.creator_id,OLD.mode,OLD.content,OLD.rendered_html,OLD.rendered_text,OLD.asset_digests,OLD.provider_binding,OLD.sender_profile,OLD.due_at,OLD.selected,OLD.excluded)
   THEN RAISE EXCEPTION 'test_snapshot_immutable'; END IF;
  IF OLD.approved_at IS NOT NULL AND ROW(NEW.approved_at,NEW.reservation_key) IS DISTINCT FROM ROW(OLD.approved_at,OLD.reservation_key) THEN RAISE EXCEPTION 'test_approval_immutable'; END IF;
  IF OLD.test_day IS NOT NULL AND ROW(NEW.test_day,NEW.test_slot,NEW.test_admitted_at) IS DISTINCT FROM ROW(OLD.test_day,OLD.test_slot,OLD.test_admitted_at) THEN RAISE EXCEPTION 'test_admission_immutable'; END IF;
  IF OLD.test_day IS NULL AND NEW.test_day IS NOT NULL AND (OLD.state<>'reviewed' OR NEW.test_day<>(clock_timestamp() AT TIME ZONE 'UTC')::date) THEN RAISE EXCEPTION 'test_admission_invalid'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.flockletter_customer_test_snapshot_guard() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.flockletter_customer_test_dispatch_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE parent public.customer_deliveries%ROWTYPE; old_kind text;
BEGIN
 IF TG_OP='UPDATE' THEN
  SELECT purpose INTO old_kind FROM public.customer_deliveries WHERE workspace_id=OLD.workspace_id AND brand_id=OLD.brand_id AND id=OLD.delivery_id;
  IF old_kind='test' AND ROW(NEW.workspace_id,NEW.brand_id,NEW.delivery_id,NEW.id,NEW.subscriber_id,NEW.email_digest,NEW.engine_reference)
   IS DISTINCT FROM ROW(OLD.workspace_id,OLD.brand_id,OLD.delivery_id,OLD.id,OLD.subscriber_id,OLD.email_digest,OLD.engine_reference)
   THEN RAISE EXCEPTION 'test_recipient_snapshot_immutable'; END IF;
 END IF;
 SELECT * INTO parent FROM public.customer_deliveries WHERE workspace_id=NEW.workspace_id AND brand_id=NEW.brand_id AND id=NEW.delivery_id;
 IF parent.purpose IS DISTINCT FROM 'test' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND old_kind IS DISTINCT FROM 'test' THEN RAISE EXCEPTION 'test_recipient_snapshot_immutable'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended(NEW.workspace_id,0)) THEN RAISE EXCEPTION USING ERRCODE='55P03',MESSAGE='workspace_retention_busy'; END IF;
 IF TG_OP='INSERT' AND EXISTS(SELECT FROM public.customer_delivery_recipients WHERE workspace_id=NEW.workspace_id AND brand_id=NEW.brand_id AND delivery_id=NEW.delivery_id) THEN RAISE EXCEPTION 'test_requires_one_recipient'; END IF;
 IF NEW.state='submitting' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM 'submitting' OR NEW.attempts>OLD.attempts) THEN
  IF current_setting('app.customer_test_dispatch',true) IS DISTINCT FROM 'v1' OR parent.selected<>1 OR parent.test_day IS NULL
   OR parent.state<>'queued' OR parent.approved_at IS NULL OR parent.reservation_key IS NULL
   OR NOT EXISTS(SELECT FROM public.customer_usage_reservations u WHERE u.workspace_id=NEW.workspace_id AND u.operation_key=parent.reservation_key
    AND u.campaign_id=parent.campaign_id AND u.brand_id=NEW.brand_id AND u.recipients=1 AND u.slots=0 AND u.state='reserved' AND u.accepted=0 AND u.excluded=0)
   OR parent.test_slot IS NULL OR parent.test_admitted_at IS NULL OR parent.test_day<>(clock_timestamp() AT TIME ZONE 'UTC')::date
   OR (SELECT count(*) FROM public.customer_delivery_recipients WHERE workspace_id=NEW.workspace_id AND brand_id=NEW.brand_id AND delivery_id=NEW.delivery_id)<>1
   THEN RAISE EXCEPTION 'test_dispatch_not_authorized'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.flockletter_customer_test_dispatch_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS flockletter_customer_test_snapshot_guard ON public.customer_deliveries;
CREATE TRIGGER flockletter_customer_test_snapshot_guard BEFORE INSERT OR UPDATE ON public.customer_deliveries FOR EACH ROW EXECUTE FUNCTION public.flockletter_customer_test_snapshot_guard();
ALTER TABLE public.customer_deliveries ENABLE ALWAYS TRIGGER flockletter_customer_test_snapshot_guard;
DROP TRIGGER IF EXISTS flockletter_customer_test_dispatch_guard ON public.customer_delivery_recipients;
CREATE TRIGGER flockletter_customer_test_dispatch_guard BEFORE INSERT OR UPDATE ON public.customer_delivery_recipients FOR EACH ROW EXECUTE FUNCTION public.flockletter_customer_test_dispatch_guard();
ALTER TABLE public.customer_delivery_recipients ENABLE ALWAYS TRIGGER flockletter_customer_test_dispatch_guard;
COMMIT;
