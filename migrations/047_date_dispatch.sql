BEGIN;
ALTER TABLE public.date_automation_revisions ADD COLUMN IF NOT EXISTS mailing_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.date_occurrences ADD COLUMN IF NOT EXISTS source_digest text,
  ADD COLUMN IF NOT EXISTS dispatched_contact uuid, ADD COLUMN IF NOT EXISTS retry_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS date_occurrence_delivery ON public.date_occurrences(workspace_id,brand_id,channel,delivery_id) WHERE delivery_id IS NOT NULL;
ALTER TABLE public.sms_messages ADD COLUMN IF NOT EXISTS date_brand_id uuid;
ALTER TABLE public.customer_deliveries ADD COLUMN IF NOT EXISTS date_automation boolean NOT NULL DEFAULT false;
COMMIT;
