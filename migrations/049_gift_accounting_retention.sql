-- WA-14 / RET-3. Only the erasure executor archives reconciled WA-09 journal entries.
-- No tenant or provider keys, free text, gift recipient, or link can be stored here.
BEGIN;
CREATE TABLE IF NOT EXISTS flockletter_retention_control.gift_accounting (
  event_day date NOT NULL CHECK (isfinite(event_day)),
  kind text NOT NULL CHECK (kind IN ('purchased','reserved','claimed','expired','refunded',
    'dispute_warning_needs_response','dispute_warning_under_review','dispute_warning_closed',
    'dispute_needs_response','dispute_under_review','dispute_won','dispute_lost','dispute_prevented')),
  face_minor bigint NOT NULL CHECK (face_minor >= 0),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  currency text NOT NULL CHECK (currency = 'USD'),
  expires_on date GENERATED ALWAYS AS ((event_day + interval '7 years' + interval '1 day')::date) STORED
);
CREATE INDEX IF NOT EXISTS gift_accounting_expiry ON flockletter_retention_control.gift_accounting(expires_on);
REVOKE ALL ON flockletter_retention_control.gift_accounting FROM PUBLIC;

-- Maintenance can only remove records past the accounting window by the database's UTC clock.
CREATE OR REPLACE FUNCTION flockletter_retention_control.expire_gift_accounting() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed bigint;
BEGIN
  DELETE FROM flockletter_retention_control.gift_accounting WHERE expires_on <= (statement_timestamp() AT TIME ZONE 'UTC')::date;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION flockletter_retention_control.expire_gift_accounting() FROM PUBLIC;

-- Older executors that do not perform the archive must refuse deletion. Role grants and
-- signed authorization govern erasure; this transaction-local marker is a compatibility guard.
CREATE OR REPLACE FUNCTION flockletter_retention_control.guard_gift_purge() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF current_setting('app.gift_archive_workspace',true) IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION 'gift_retention_review_required';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION flockletter_retention_control.guard_gift_purge() FROM PUBLIC;
DROP TRIGGER IF EXISTS flockletter_gift_purge_guard ON public.operations;
CREATE TRIGGER flockletter_gift_purge_guard BEFORE DELETE ON public.operations
  FOR EACH ROW WHEN (starts_with(OLD.actor_id,'workspace-gifts:'))
  EXECUTE FUNCTION flockletter_retention_control.guard_gift_purge();
ALTER TABLE public.operations ENABLE ALWAYS TRIGGER flockletter_gift_purge_guard;
COMMIT;
