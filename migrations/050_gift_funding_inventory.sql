BEGIN;
-- One metadata row per actual workspace purchase lot. Only the aggregate is exposed to the operator role.
LOCK TABLE public.operations IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE IF NOT EXISTS flockletter_retention_control.gift_funding_lots (
  workspace_id text NOT NULL, lot_key text NOT NULL, revision text NOT NULL,
  reserved_cents bigint NOT NULL CHECK (reserved_cents >= 0),
  expected_lots bigint CHECK (expected_lots >= 0),
  CHECK ((workspace_id='') = (expected_lots IS NOT NULL)),
  PRIMARY KEY (workspace_id,lot_key)
);
REVOKE ALL ON flockletter_retention_control.gift_funding_lots FROM PUBLIC;

CREATE OR REPLACE FUNCTION flockletter_retention_control.project_gift_funding_lot()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT FROM flockletter_retention_control.gift_funding_lots WHERE workspace_id=OLD.workspace_id
               AND lot_key=OLD.request_hash AND revision=OLD.operation_key AND reserved_cents>0) THEN
      RAISE EXCEPTION 'gift_funding_liability_open';
    END IF;
    DELETE FROM flockletter_retention_control.gift_funding_lots WHERE workspace_id=OLD.workspace_id
      AND lot_key=OLD.request_hash AND revision=OLD.operation_key;
    IF FOUND THEN
      UPDATE flockletter_retention_control.gift_funding_lots SET expected_lots=expected_lots-1 WHERE workspace_id='' AND lot_key='baseline';
      IF NOT FOUND THEN RAISE EXCEPTION 'gift_funding_inventory_unverified'; END IF;
    END IF;
  ELSE
    INSERT INTO flockletter_retention_control.gift_funding_lots(workspace_id,lot_key,revision,reserved_cents)
      VALUES(NEW.workspace_id,NEW.request_hash,NEW.operation_key,(NEW.result->>'reserved')::bigint)
      ON CONFLICT(workspace_id,lot_key) DO NOTHING;
    IF FOUND THEN
      UPDATE flockletter_retention_control.gift_funding_lots SET expected_lots=expected_lots+1 WHERE workspace_id='' AND lot_key='baseline';
      IF NOT FOUND THEN RAISE EXCEPTION 'gift_funding_inventory_unverified'; END IF;
    ELSE
      UPDATE flockletter_retention_control.gift_funding_lots SET revision=NEW.operation_key,reserved_cents=(NEW.result->>'reserved')::bigint
        WHERE workspace_id=NEW.workspace_id AND lot_key=NEW.request_hash AND revision<NEW.operation_key;
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION flockletter_retention_control.project_gift_funding_lot() FROM PUBLIC;
DROP TRIGGER IF EXISTS gift_funding_insert ON public.operations;
CREATE TRIGGER gift_funding_insert AFTER INSERT ON public.operations FOR EACH ROW
  WHEN (NEW.actor_id='workspace-gifts:v1:lot' AND NOT starts_with(NEW.workspace_id,'fixture:') AND NOT starts_with(NEW.workspace_id,'system:'))
  EXECUTE FUNCTION flockletter_retention_control.project_gift_funding_lot();
DROP TRIGGER IF EXISTS gift_funding_delete ON public.operations;
CREATE TRIGGER gift_funding_delete AFTER DELETE ON public.operations FOR EACH ROW
  WHEN (OLD.actor_id='workspace-gifts:v1:lot' AND NOT starts_with(OLD.workspace_id,'fixture:') AND NOT starts_with(OLD.workspace_id,'system:'))
  EXECUTE FUNCTION flockletter_retention_control.project_gift_funding_lot();
ALTER TABLE public.operations ENABLE ALWAYS TRIGGER gift_funding_insert;
ALTER TABLE public.operations ENABLE ALWAYS TRIGGER gift_funding_delete;

-- The migration owner's temporary SELECT policy is created and removed in the same locked transaction.
-- FORCE RLS stays on. Existing operations from before this migration are included, even for closed tenants.
CREATE POLICY gift_funding_backfill ON public.operations FOR SELECT TO CURRENT_USER USING(actor_id='workspace-gifts:v1:lot');
DELETE FROM flockletter_retention_control.gift_funding_lots;
INSERT INTO flockletter_retention_control.gift_funding_lots(workspace_id,lot_key,revision,reserved_cents)
  SELECT DISTINCT ON (workspace_id,request_hash) workspace_id,request_hash,operation_key,(result->>'reserved')::bigint
  FROM public.operations WHERE actor_id='workspace-gifts:v1:lot'
    AND NOT starts_with(workspace_id,'fixture:') AND NOT starts_with(workspace_id,'system:')
  ORDER BY workspace_id,request_hash,operation_key DESC;
DROP POLICY gift_funding_backfill ON public.operations;
INSERT INTO flockletter_retention_control.gift_funding_lots
  SELECT '','baseline','v1',0,count(*) FROM flockletter_retention_control.gift_funding_lots;

CREATE OR REPLACE FUNCTION flockletter_retention_control.gift_funding_liability()
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.operations'::regclass AND tgenabled='A'
      AND tgfoid='flockletter_retention_control.project_gift_funding_lot()'::regprocedure
      AND tgname IN ('gift_funding_insert','gift_funding_delete')) <> 2
    OR NOT EXISTS (SELECT FROM flockletter_retention_control.gift_funding_lots WHERE workspace_id='' AND lot_key='baseline' AND revision='v1'
      AND expected_lots=(SELECT count(*) FROM flockletter_retention_control.gift_funding_lots WHERE workspace_id<>''))
    OR EXISTS (SELECT FROM flockletter_retention_control.gift_funding_lots WHERE workspace_id !~ '^org_[A-Za-z0-9_-]{1,120}$'
               AND (workspace_id,lot_key,revision) <> ('','baseline','v1'))
    OR public.flockletter_restore_blocked() THEN
    RAISE EXCEPTION 'gift_funding_inventory_unverified';
  END IF;
  RETURN (SELECT sum(reserved_cents)::bigint FROM flockletter_retention_control.gift_funding_lots);
END $$;
REVOKE ALL ON FUNCTION flockletter_retention_control.gift_funding_liability() FROM PUBLIC;
COMMIT;
