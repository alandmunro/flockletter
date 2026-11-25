BEGIN;
ALTER TABLE public.customer_deliveries NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audience_segments NO FORCE ROW LEVEL SECURITY;
-- A queued preference-managed send must retain membership checks until it is settled.
DO $$ BEGIN
  IF EXISTS (SELECT FROM public.customer_deliveries WHERE preference_segment_id IS NOT NULL
      AND state IN ('reviewed','queued','paused')) THEN
    RAISE EXCEPTION 'Resolve preference-managed deliveries before rollback';
  END IF;
  IF EXISTS (SELECT FROM public.audience_segments WHERE subscriber_selectable) THEN
    RAISE EXCEPTION 'Retire subscriber-managed groups before rollback';
  END IF;
END $$;
ALTER TABLE public.customer_deliveries DROP COLUMN IF EXISTS preference_segment_id;
ALTER TABLE public.customer_audience_optouts DROP COLUMN IF EXISTS preference_hash;
ALTER TABLE public.audience_segments DROP COLUMN IF EXISTS subscriber_selectable;
ALTER TABLE public.customer_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audience_segments FORCE ROW LEVEL SECURITY;
COMMIT;
