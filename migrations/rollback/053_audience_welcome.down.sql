BEGIN;
-- A welcome already handed to the provider must stay reconcilable until it settles.
DO $$ BEGIN
  IF EXISTS (SELECT FROM public.customer_audience_welcomes WHERE state IN ('submitting','uncertain')) THEN
    RAISE EXCEPTION 'Settle submitted welcome messages before rollback';
  END IF;
END $$;
DROP TABLE IF EXISTS public.customer_audience_welcomes;
COMMIT;
