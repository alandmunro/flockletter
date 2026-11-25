BEGIN;
ALTER TABLE public.audience_segments
  ADD COLUMN IF NOT EXISTS subscriber_selectable boolean NOT NULL DEFAULT false;
ALTER TABLE public.customer_audience_optouts
  ADD COLUMN IF NOT EXISTS preference_hash text;
ALTER TABLE public.customer_deliveries
  ADD COLUMN IF NOT EXISTS preference_segment_id uuid;
COMMIT;
