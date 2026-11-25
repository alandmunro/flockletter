BEGIN;
ALTER TABLE public.date_occurrences NO FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT FROM public.date_occurrences WHERE delivery_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Keep automation delivery receipts and reconcile outstanding greetings before rollback';
  END IF;
END $$;
ALTER TABLE public.date_occurrences FORCE ROW LEVEL SECURITY;
DROP INDEX IF EXISTS public.date_occurrence_delivery;
ALTER TABLE public.date_occurrences DROP COLUMN IF EXISTS source_digest, DROP COLUMN IF EXISTS dispatched_contact, DROP COLUMN IF EXISTS retry_at;
ALTER TABLE public.sms_messages DROP COLUMN IF EXISTS date_brand_id;
ALTER TABLE public.customer_deliveries DROP COLUMN IF EXISTS date_automation;
ALTER TABLE public.date_automation_revisions DROP COLUMN IF EXISTS mailing_id;
COMMIT;
