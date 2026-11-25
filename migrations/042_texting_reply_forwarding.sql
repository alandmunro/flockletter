BEGIN;
ALTER TABLE public.sms_inbound DROP CONSTRAINT IF EXISTS sms_inbound_forward_state_check;
ALTER TABLE public.sms_inbound ADD CONSTRAINT sms_inbound_forward_state_check
  CHECK (forward_state IN ('none','queued','forwarded','captured','failed','uncertain'));
COMMIT;
