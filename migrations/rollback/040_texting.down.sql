-- Rollback for 040_texting.sql (CHG-3). Drops only objects that migration created.
-- Run as the migration owner after stopping texting (FLOCKLETTER_TEXTING=off). Data in these tables is lost.
BEGIN;
DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['texting_setting(text,text)','texting_settings_list(text)',
    'texting_set_setting(text,text,jsonb,integer,text,text,text)','texting_setting_history(text,integer)',
    'texting_bind_account(text,text,text)','texting_account(text)','texting_route_account(text)',
    'texting_bind_number(text,text,uuid)','texting_route_number(text)','texting_claim_short_name(text,text,integer)',
    'texting_release_short_name(text,text)','texting_register_link(text,text,text)','texting_route_link(text,text)',
    'texting_mock_get(text)','texting_mock_put(text,jsonb)','texting_mock_list(text)','texting_require_tenant(text)'] LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS flockletter_customer_jobs.'||f;
  END LOOP;
END $$;
DROP TABLE IF EXISTS flockletter_customer_jobs.texting_mock_state, flockletter_customer_jobs.texting_link_routes,
  flockletter_customer_jobs.texting_short_names, flockletter_customer_jobs.texting_number_routes,
  flockletter_customer_jobs.texting_accounts, flockletter_customer_jobs.texting_setting_changes,
  flockletter_customer_jobs.texting_settings;
DROP TABLE IF EXISTS public.sms_audit, public.sms_links, public.sms_usage, public.sms_provider_events, public.sms_inbound,
  public.sms_messages, public.sms_sends, public.sms_member_phones, public.contact_dates, public.sms_consent_events,
  public.sms_consents, public.sms_contacts, public.sms_numbers, public.sms_operator_approvals,
  public.sms_registration_steps, public.sms_registrations, public.sms_carrier_brands, public.sms_workspace_profile;
ALTER TABLE public.team_grants DROP COLUMN IF EXISTS sms_send;
COMMIT;
