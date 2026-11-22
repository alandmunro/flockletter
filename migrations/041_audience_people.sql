-- Audience people (FL-AUD-020). Additive only.
-- Names on email subscribers and text contacts, a phone shared by several subscribers (D2), the per-workspace
-- name and text-only sign-up options (D1, D3), and removable special dates.
BEGIN;

ALTER TABLE public.subscribers
  ADD COLUMN IF NOT EXISTS first_name text CHECK(first_name IS NULL OR char_length(first_name) BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS last_name text CHECK(last_name IS NULL OR char_length(last_name) BETWEEN 1 AND 60);
ALTER TABLE public.sms_contacts
  ADD COLUMN IF NOT EXISTS first_name text CHECK(first_name IS NULL OR char_length(first_name) BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS last_name text CHECK(last_name IS NULL OR char_length(last_name) BETWEEN 1 AND 60);
ALTER TABLE public.sms_workspace_profile
  ADD COLUMN IF NOT EXISTS name_field boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS phone_only_signup boolean NOT NULL DEFAULT false;

-- One phone can belong to several subscribers of a brand (a household); each subscriber has at most one phone.
-- Rows written before this migration keep their link in sms_contacts.subscriber_id, which readers also honour.
CREATE TABLE IF NOT EXISTS public.sms_contact_subscribers (
  workspace_id text NOT NULL, contact_id uuid NOT NULL, brand_id uuid NOT NULL, subscriber_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,brand_id,subscriber_id),
  FOREIGN KEY(workspace_id,contact_id) REFERENCES public.sms_contacts(workspace_id,id),
  FOREIGN KEY(workspace_id,brand_id,subscriber_id) REFERENCES public.subscribers(workspace_id,brand_id,id)
);
CREATE INDEX IF NOT EXISTS sms_contact_subscribers_contact ON public.sms_contact_subscribers(workspace_id,contact_id);

ALTER TABLE public.sms_contact_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_contact_subscribers FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='sms_contact_subscribers' AND policyname='workspace_boundary') THEN
    CREATE POLICY workspace_boundary ON public.sms_contact_subscribers USING(workspace_id=current_setting('app.workspace_id',true))
      WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
  END IF;
END $$;
REVOKE ALL ON public.sms_contact_subscribers FROM PUBLIC;
DROP TRIGGER IF EXISTS flockletter_retention_insert_guard ON public.sms_contact_subscribers;
CREATE TRIGGER flockletter_retention_insert_guard BEFORE INSERT ON public.sms_contact_subscribers FOR EACH ROW EXECUTE FUNCTION public.flockletter_retention_insert_guard();
ALTER TABLE public.sms_contact_subscribers ENABLE ALWAYS TRIGGER flockletter_retention_insert_guard;
COMMIT;
