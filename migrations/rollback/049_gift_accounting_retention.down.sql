-- Keep 048 installed across a code rollback while gift activity or accounting remains.
BEGIN;
LOCK TABLE public.operations,flockletter_retention_control.gift_accounting IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.operations NO FORCE ROW LEVEL SECURITY;
SET LOCAL row_security=off;
DO $$ BEGIN
  IF EXISTS (SELECT FROM public.operations WHERE starts_with(actor_id,'workspace-gifts:'))
    OR EXISTS (SELECT FROM flockletter_retention_control.gift_accounting) THEN
    RAISE EXCEPTION 'Gift journal or retained accounting requires migration 048';
  END IF;
END $$;
ALTER TABLE public.operations FORCE ROW LEVEL SECURITY;
DROP TRIGGER flockletter_gift_purge_guard ON public.operations;
DROP FUNCTION flockletter_retention_control.guard_gift_purge();
DROP FUNCTION flockletter_retention_control.expire_gift_accounting();
DROP TABLE flockletter_retention_control.gift_accounting;
COMMIT;
