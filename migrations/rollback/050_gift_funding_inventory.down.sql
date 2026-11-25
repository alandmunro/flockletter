BEGIN;
LOCK TABLE public.operations,flockletter_retention_control.gift_funding_lots,
  flockletter_retention_control.platform_records IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT FROM flockletter_retention_control.gift_funding_lots WHERE reserved_cents<>0)
    OR EXISTS (SELECT FROM flockletter_retention_control.platform_records
      WHERE workspace_id='_platform_gift_funding_sandbox' AND kind='ack' AND id ~ '^gift-funding:[0-9a-f-]{36}$'
      AND coalesce(body->>'state','unknown') NOT IN ('fully_credited','rejected','reversed')) THEN
    RAISE EXCEPTION 'Retain the gift funding monitor and reconcile outstanding liability and top-ups';
  END IF;
END $$;
DROP TRIGGER gift_funding_insert ON public.operations;
DROP TRIGGER gift_funding_delete ON public.operations;
DROP FUNCTION flockletter_retention_control.project_gift_funding_lot();
DROP FUNCTION flockletter_retention_control.gift_funding_liability();
DROP TABLE flockletter_retention_control.gift_funding_lots;
COMMIT;
