-- Rollback for 041_audience_people.sql. Drops only objects that migration created. Names and phone links are lost.
BEGIN;
DROP TABLE IF EXISTS public.sms_contact_subscribers;
-- Cleared dates would reappear after rollback, so remove them first.
DELETE FROM public.contact_dates WHERE cleared_at IS NOT NULL;
ALTER TABLE public.contact_dates DROP COLUMN IF EXISTS cleared_at;
ALTER TABLE public.sms_contacts DROP COLUMN IF EXISTS first_name, DROP COLUMN IF EXISTS last_name;
ALTER TABLE public.subscribers DROP COLUMN IF EXISTS first_name, DROP COLUMN IF EXISTS last_name;
ALTER TABLE public.sms_workspace_profile DROP COLUMN IF EXISTS name_field, DROP COLUMN IF EXISTS phone_only_signup;
COMMIT;
