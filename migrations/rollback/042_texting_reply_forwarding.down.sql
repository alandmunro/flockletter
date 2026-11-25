BEGIN;
ALTER TABLE public.sms_inbound NO FORCE ROW LEVEL SECURITY;
UPDATE public.sms_inbound SET forward_state = 'failed' WHERE forward_state = 'uncertain';
ALTER TABLE public.sms_inbound DROP CONSTRAINT IF EXISTS sms_inbound_forward_state_check;
ALTER TABLE public.sms_inbound ADD CONSTRAINT sms_inbound_forward_state_check
  CHECK (forward_state IN ('none','queued','forwarded','captured','failed'));
ALTER TABLE public.sms_inbound FORCE ROW LEVEL SECURITY;
COMMIT;
