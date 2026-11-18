-- Texting add-on, phase 2 (D-063, FL-SMS-001–015). Additive only.
-- Public tables are tenant data under forced row-level security. Routing, provider credentials and
-- operator settings live in flockletter_customer_jobs and are reached only through the functions below.
BEGIN;

ALTER TABLE public.team_grants ADD COLUMN IF NOT EXISTS sms_send boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.sms_workspace_profile (
  workspace_id text PRIMARY KEY REFERENCES public.workspaces(workspace_id),
  short_name text UNIQUE CHECK(short_name ~ '^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$'),
  short_name_changed_at timestamptz,
  notification_email text CHECK(notification_email IS NULL OR char_length(notification_email) BETWEEN 3 AND 254),
  time_zone text NOT NULL DEFAULT 'America/New_York',
  phone_field boolean NOT NULL DEFAULT false, birthday_field boolean NOT NULL DEFAULT false,
  anniversary_field boolean NOT NULL DEFAULT false,
  anniversary_label text NOT NULL DEFAULT 'Anniversary' CHECK(char_length(anniversary_label) BETWEEN 1 AND 40),
  revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);

-- FL-SMS-002: a carrier brand belongs to exactly one company, and a company has at most one.
CREATE TABLE IF NOT EXISTS public.sms_carrier_brands (
  workspace_id text NOT NULL, id uuid NOT NULL, company_id uuid NOT NULL,
  legal_name text NOT NULL CHECK(char_length(btrim(legal_name)) BETWEEN 1 AND 200),
  dba_name text CHECK(dba_name IS NULL OR char_length(btrim(dba_name)) BETWEEN 1 AND 200),
  entity_type text NOT NULL CHECK(entity_type IN ('private_profit','public_profit','non_profit','sole_proprietor','government')),
  profile jsonb NOT NULL, help_contact text NOT NULL CHECK(char_length(help_contact) BETWEEN 3 AND 120),
  privacy_policy_confirmed_at timestamptz, sms_terms_confirmed_at timestamptz,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,company_id),
  FOREIGN KEY(workspace_id,company_id) REFERENCES public.companies(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS public.sms_registrations (
  workspace_id text NOT NULL, id uuid NOT NULL, carrier_brand_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('draft','provisioning','brand_pending','campaign_pending','approved','rejected','suspended')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0), rejection_reason text,
  account_sid text, customer_profile_sid text, brand_sid text, messaging_service_sid text, campaign_sid text,
  brand_status text, campaign_status text, status_checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,carrier_brand_id),
  FOREIGN KEY(workspace_id,carrier_brand_id) REFERENCES public.sms_carrier_brands(workspace_id,id)
);

-- One durable intent per provider call. The operation key is committed before the call.
CREATE TABLE IF NOT EXISTS public.sms_registration_steps (
  workspace_id text NOT NULL, registration_id uuid NOT NULL, revision integer NOT NULL,
  step text NOT NULL CHECK(step IN ('subaccount','customer_profile','brand','messaging_service','campaign','number')),
  operation_key text NOT NULL UNIQUE,
  state text NOT NULL CHECK(state IN ('queued','calling','done','uncertain','rejected','held')),
  attempts integer NOT NULL DEFAULT 0, next_check_at timestamptz, provider_sid text, reason text,
  facts jsonb NOT NULL DEFAULT '{}', operator_approval_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,registration_id,revision,step),
  FOREIGN KEY(workspace_id,registration_id) REFERENCES public.sms_registrations(workspace_id,id)
);

-- Live mode only: a separate operator approval for each real-cost or carrier-facing action.
CREATE TABLE IF NOT EXISTS public.sms_operator_approvals (
  workspace_id text NOT NULL, id uuid NOT NULL, registration_id uuid NOT NULL, revision integer NOT NULL,
  step text NOT NULL CHECK(step IN ('brand','campaign','number')),
  cost_note text NOT NULL CHECK(char_length(cost_note) BETWEEN 1 AND 200),
  approved_by text NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(), used_at timestamptz,
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,registration_id,revision,step),
  FOREIGN KEY(workspace_id,registration_id) REFERENCES public.sms_registrations(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS public.sms_numbers (
  workspace_id text NOT NULL, id uuid NOT NULL, carrier_brand_id uuid NOT NULL,
  e164 text NOT NULL UNIQUE CHECK(e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  provider_sid text NOT NULL, messaging_service_sid text NOT NULL,
  state text NOT NULL CHECK(state IN ('reserved','active','released')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,carrier_brand_id) REFERENCES public.sms_carrier_brands(workspace_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sms_numbers_one_active ON public.sms_numbers(workspace_id,carrier_brand_id) WHERE state<>'released';

CREATE TABLE IF NOT EXISTS public.sms_contacts (
  workspace_id text NOT NULL, id uuid NOT NULL,
  phone_e164 text NOT NULL CHECK(phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  brand_id uuid, subscriber_id uuid, name text CHECK(name IS NULL OR char_length(name)<=100),
  time_zone text, textable boolean NOT NULL DEFAULT true,
  not_textable_reason text CHECK(not_textable_reason IS NULL OR not_textable_reason IN ('invalid','landline','permanent_failure','repeated_failures')),
  consecutive_temp_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,phone_e164),
  FOREIGN KEY(workspace_id,brand_id) REFERENCES public.brands(workspace_id,id)
);

-- Current state per company number. STOP applies to the number that received it.
CREATE TABLE IF NOT EXISTS public.sms_consents (
  workspace_id text NOT NULL, company_id uuid NOT NULL, contact_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('none','pending_confirmation','opted_in','opted_out','pending_reenrollment')),
  pending_expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,company_id,contact_id),
  FOREIGN KEY(workspace_id,company_id) REFERENCES public.companies(workspace_id,id),
  FOREIGN KEY(workspace_id,contact_id) REFERENCES public.sms_contacts(workspace_id,id)
);
-- Append-only: the runtime role has SELECT and INSERT only (see runtime-tables.json).
CREATE TABLE IF NOT EXISTS public.sms_consent_events (
  workspace_id text NOT NULL, id uuid NOT NULL, company_id uuid NOT NULL, contact_id uuid NOT NULL,
  event text NOT NULL CHECK(event IN ('checkbox_opt_in','confirmed','expired','opted_out','help','opted_in_start','reenrollment_pending','not_textable')),
  source text NOT NULL CHECK(source IN ('signup_page','inbound_sms','owner','worker','delivery_status')),
  wording text, wording_digest text CHECK(wording_digest IS NULL OR wording_digest ~ '^[a-f0-9]{64}$'),
  policy_version text, evidence_message_id text, recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,contact_id) REFERENCES public.sms_contacts(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS public.contact_dates (
  workspace_id text NOT NULL, id uuid NOT NULL, contact_id uuid, brand_id uuid, subscriber_id uuid,
  type text NOT NULL CHECK(type IN ('birthday','anniversary')),
  label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 40),
  month smallint NOT NULL CHECK(month BETWEEN 1 AND 12), day smallint NOT NULL CHECK(day BETWEEN 1 AND 31),
  year smallint CHECK(year IS NULL OR year BETWEEN 1900 AND 2100),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  CHECK(contact_id IS NOT NULL OR (brand_id IS NOT NULL AND subscriber_id IS NOT NULL)),
  FOREIGN KEY(workspace_id,contact_id) REFERENCES public.sms_contacts(workspace_id,id),
  FOREIGN KEY(workspace_id,brand_id,subscriber_id) REFERENCES public.subscribers(workspace_id,brand_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS contact_dates_subscriber_type ON public.contact_dates(workspace_id,brand_id,subscriber_id,type) WHERE subscriber_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contact_dates_contact_type ON public.contact_dates(workspace_id,contact_id,type) WHERE subscriber_id IS NULL;

CREATE TABLE IF NOT EXISTS public.sms_member_phones (
  workspace_id text NOT NULL, user_id text NOT NULL,
  phone_e164 text NOT NULL CHECK(phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  code_digest text, code_expires_at timestamptz, code_attempts integer NOT NULL DEFAULT 0, verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id)
);

CREATE TABLE IF NOT EXISTS public.sms_sends (
  workspace_id text NOT NULL, id uuid NOT NULL, company_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('broadcast','test')),
  body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 1600),
  state text NOT NULL CHECK(state IN ('draft','confirmed','scheduled','running','paused','completed','cancelled')),
  revision integer NOT NULL DEFAULT 1, scheduled_at timestamptz, confirmation jsonb, confirmed_by text, confirmed_at timestamptz,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  test_day date, test_slot smallint,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,company_id) REFERENCES public.companies(workspace_id,id)
);
-- The D-047 pattern: one admitted test per slot per day.
CREATE UNIQUE INDEX IF NOT EXISTS sms_sends_test_slots ON public.sms_sends(workspace_id,test_day,test_slot) WHERE kind='test' AND test_day IS NOT NULL;

-- The id is the stable operation key for the provider call.
CREATE TABLE IF NOT EXISTS public.sms_messages (
  workspace_id text NOT NULL, id uuid NOT NULL, send_id uuid, company_id uuid NOT NULL, contact_id uuid,
  purpose text NOT NULL CHECK(purpose IN ('broadcast','test','confirmation','help','verification')),
  to_e164 text NOT NULL CHECK(to_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  rendered_body text NOT NULL, body_digest text NOT NULL,
  encoding text NOT NULL CHECK(encoding IN ('gsm7','ucs2')), segments integer NOT NULL CHECK(segments BETWEEN 1 AND 10),
  state text NOT NULL CHECK(state IN ('pending','admitted','calling','accepted','delivered','undelivered','failed','uncertain','skipped','cancelled')),
  reason text, provider_sid text, send_day date, next_check_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0, submitted_at timestamptz, reserved_segments integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,send_id) REFERENCES public.sms_sends(workspace_id,id),
  FOREIGN KEY(workspace_id,contact_id) REFERENCES public.sms_contacts(workspace_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_one_per_send ON public.sms_messages(workspace_id,send_id,contact_id) WHERE send_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_messages_due ON public.sms_messages(workspace_id,next_check_at) WHERE state IN ('pending','admitted','calling','uncertain');
CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_provider_sid ON public.sms_messages(workspace_id,provider_sid) WHERE provider_sid IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.sms_inbound (
  workspace_id text NOT NULL, id uuid NOT NULL, number_id uuid NOT NULL, from_e164 text NOT NULL,
  contact_id uuid, body text NOT NULL CHECK(char_length(body)<=1600), provider_sid text NOT NULL,
  classification text NOT NULL CHECK(classification IN ('stop','help','start','confirm','other','unknown_number')),
  forward_state text NOT NULL DEFAULT 'none' CHECK(forward_state IN ('none','queued','forwarded','captured','failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,provider_sid),
  FOREIGN KEY(workspace_id,number_id) REFERENCES public.sms_numbers(workspace_id,id),
  FOREIGN KEY(workspace_id,contact_id) REFERENCES public.sms_contacts(workspace_id,id)
);

CREATE TABLE IF NOT EXISTS public.sms_provider_events (
  workspace_id text NOT NULL, event_key text NOT NULL, digest text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,event_key)
);

CREATE TABLE IF NOT EXISTS public.sms_usage (
  workspace_id text NOT NULL, period_month date NOT NULL,
  segments_reserved integer NOT NULL DEFAULT 0 CHECK(segments_reserved>=0),
  segments_used integer NOT NULL DEFAULT 0 CHECK(segments_used>=0),
  PRIMARY KEY(workspace_id,period_month)
);

CREATE TABLE IF NOT EXISTS public.sms_links (
  workspace_id text NOT NULL, code text COLLATE "C" NOT NULL CHECK(code ~ '^[A-Za-z0-9]{7}$'),
  destination text NOT NULL CHECK(char_length(destination)<=2048), expires_at timestamptz,
  clicks integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,code)
);

-- Append-only, with old value, new value, actor and interface (FL-SMS-013/015).
CREATE TABLE IF NOT EXISTS public.sms_audit (
  workspace_id text NOT NULL, id uuid NOT NULL, actor_id text NOT NULL,
  interface text NOT NULL CHECK(interface IN ('ui','api','mcp','worker','webhook','signup_page','operator_ui','operator_api','operator_mcp')),
  action text NOT NULL, target text, old_value jsonb, new_value jsonb, at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sms_workspace_profile','sms_carrier_brands','sms_registrations','sms_registration_steps','sms_operator_approvals',
    'sms_numbers','sms_contacts','sms_consents','sms_consent_events','contact_dates','sms_member_phones','sms_sends','sms_messages',
    'sms_inbound','sms_provider_events','sms_usage','sms_links','sms_audit'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='workspace_boundary') THEN
      EXECUTE format('CREATE POLICY workspace_boundary ON public.%I USING(workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''app.workspace_id'',true))',t);
    END IF;
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  END LOOP;
END $$;

-- ---------- Private, server-owned state ----------

-- Operator settings. workspace_id NULL holds the platform value; a row with a workspace overrides it.
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.texting_settings (
  key text NOT NULL CHECK(key ~ '^[a-z][a-z0-9_]{2,60}$'), workspace_id text CHECK(workspace_id IS NULL OR workspace_id ~ '^org_[A-Za-z0-9_-]{1,120}$'),
  value jsonb NOT NULL, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS texting_settings_scope ON flockletter_customer_jobs.texting_settings(key,coalesce(workspace_id,''));
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.texting_setting_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL, workspace_id text,
  old_value jsonb, new_value jsonb, actor_id text NOT NULL,
  interface text NOT NULL CHECK(interface IN ('operator_ui','operator_api','operator_mcp','migration')),
  reason text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
-- FL-SMS-003: per-workspace provider account; credentials are AES-256-GCM ciphertext.
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.texting_accounts (
  workspace_id text PRIMARY KEY CHECK(workspace_id ~ '^org_[A-Za-z0-9_-]{1,120}$'),
  account_sid text NOT NULL UNIQUE CHECK(account_sid ~ '^AC[0-9a-f]{32}$'),
  credentials text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.texting_number_routes (
  e164 text PRIMARY KEY, workspace_id text NOT NULL, number_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.texting_short_names (
  short_name text PRIMARY KEY, workspace_id text NOT NULL, released_at timestamptz
);
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.texting_link_routes (
  short_name text NOT NULL, code text COLLATE "C" NOT NULL, workspace_id text NOT NULL,
  PRIMARY KEY(short_name,code)
);
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.texting_mock_state (
  key text PRIMARY KEY CHECK(char_length(key)<=200), value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['texting_settings','texting_setting_changes','texting_accounts','texting_number_routes','texting_short_names','texting_link_routes','texting_mock_state'] LOOP
    EXECUTE format('REVOKE ALL ON flockletter_customer_jobs.%I FROM PUBLIC',t);
  END LOOP;
END $$;

-- The erasure insert guard (028) covers every tenant and private routing table that names a workspace.
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['public.sms_workspace_profile','public.sms_carrier_brands','public.sms_registrations','public.sms_registration_steps',
    'public.sms_operator_approvals','public.sms_numbers','public.sms_contacts','public.sms_consents','public.sms_consent_events','public.contact_dates',
    'public.sms_member_phones','public.sms_sends','public.sms_messages','public.sms_inbound','public.sms_provider_events','public.sms_usage',
    'public.sms_links','public.sms_audit','flockletter_customer_jobs.texting_accounts','flockletter_customer_jobs.texting_number_routes',
    'flockletter_customer_jobs.texting_short_names','flockletter_customer_jobs.texting_link_routes'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS flockletter_retention_insert_guard ON %s',target);
    EXECUTE format('CREATE TRIGGER flockletter_retention_insert_guard BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION public.flockletter_retention_insert_guard()',target);
    EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER flockletter_retention_insert_guard',target);
  END LOOP;
END $$;

-- Tenant callers may act only on the workspace set for their transaction.
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_require_tenant(text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
BEGIN
  IF $1 IS NULL OR $1 IS DISTINCT FROM current_setting('app.workspace_id',true) THEN RAISE EXCEPTION 'texting_workspace_mismatch'; END IF;
END $$;

CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_setting(workspace text, setting text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT coalesce(
    (SELECT value FROM flockletter_customer_jobs.texting_settings WHERE key=setting AND workspace_id=workspace),
    (SELECT value FROM flockletter_customer_jobs.texting_settings WHERE key=setting AND workspace_id IS NULL))
$$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_settings_list(workspace text)
RETURNS TABLE(key text, workspace_id text, value jsonb, revision integer, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT key,workspace_id,value,revision,updated_at FROM flockletter_customer_jobs.texting_settings
  WHERE workspace_id IS NULL OR workspace_id=workspace ORDER BY key,workspace_id NULLS FIRST
$$;
-- Bounds are checked by the operator service before this call; the revision prevents lost updates.
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_set_setting(setting text, workspace text, new_value jsonb,
  expected_revision integer, actor text, via text, why text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous flockletter_customer_jobs.texting_settings%ROWTYPE; next_revision integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('texting-setting:'||setting||':'||coalesce(workspace,''),0));
  SELECT * INTO previous FROM flockletter_customer_jobs.texting_settings WHERE key=setting AND workspace_id IS NOT DISTINCT FROM workspace;
  IF coalesce(previous.revision,0)<>expected_revision THEN RAISE EXCEPTION 'texting_setting_revision_conflict'; END IF;
  IF new_value IS NULL THEN
    DELETE FROM flockletter_customer_jobs.texting_settings WHERE key=setting AND workspace_id IS NOT DISTINCT FROM workspace;
    next_revision:=0;
  ELSIF previous.key IS NULL THEN
    INSERT INTO flockletter_customer_jobs.texting_settings(key,workspace_id,value) VALUES(setting,workspace,new_value);
    next_revision:=1;
  ELSE
    UPDATE flockletter_customer_jobs.texting_settings SET value=new_value,revision=revision+1,updated_at=clock_timestamp()
      WHERE key=setting AND workspace_id IS NOT DISTINCT FROM workspace RETURNING revision INTO next_revision;
  END IF;
  INSERT INTO flockletter_customer_jobs.texting_setting_changes(key,workspace_id,old_value,new_value,actor_id,interface,reason)
    VALUES(setting,workspace,previous.value,new_value,actor,via,why);
  RETURN next_revision;
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_setting_history(workspace text, max_rows integer)
RETURNS TABLE(key text, workspace_id text, old_value jsonb, new_value jsonb, actor_id text, interface text, reason text, at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT key,workspace_id,old_value,new_value,actor_id,interface,reason,at FROM flockletter_customer_jobs.texting_setting_changes
  WHERE workspace_id IS NULL OR workspace_id=workspace ORDER BY at DESC LIMIT least(greatest(max_rows,1),200)
$$;

CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_bind_account(workspace text, sid text, sealed text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM flockletter_customer_jobs.texting_require_tenant(workspace);
  INSERT INTO flockletter_customer_jobs.texting_accounts(workspace_id,account_sid,credentials) VALUES(workspace,sid,sealed)
  ON CONFLICT(workspace_id) DO UPDATE SET credentials=EXCLUDED.credentials,updated_at=clock_timestamp()
    WHERE flockletter_customer_jobs.texting_accounts.account_sid=EXCLUDED.account_sid;
  IF NOT EXISTS(SELECT FROM flockletter_customer_jobs.texting_accounts WHERE workspace_id=workspace AND account_sid=sid) THEN
    RAISE EXCEPTION 'texting_account_conflict';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_account(workspace text)
RETURNS TABLE(account_sid text, credentials text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM flockletter_customer_jobs.texting_require_tenant(workspace);
  RETURN QUERY SELECT a.account_sid,a.credentials FROM flockletter_customer_jobs.texting_accounts a WHERE a.workspace_id=workspace;
END $$;
-- Webhook routing: the AccountSid and the receiving number each name at most one workspace.
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_route_account(sid text) RETURNS text
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT workspace_id FROM flockletter_customer_jobs.texting_accounts WHERE account_sid=sid
$$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_bind_number(workspace text, number text, number_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM flockletter_customer_jobs.texting_require_tenant(workspace);
  INSERT INTO flockletter_customer_jobs.texting_number_routes VALUES(number,workspace,number_id) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT FROM flockletter_customer_jobs.texting_number_routes r WHERE r.e164=number AND r.workspace_id=workspace AND r.number_id=$3) THEN
    RAISE EXCEPTION 'texting_number_conflict';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_route_number(number text)
RETURNS TABLE(workspace_id text, number_id uuid)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT workspace_id,number_id FROM flockletter_customer_jobs.texting_number_routes WHERE e164=number
$$;

-- Short names are unique across workspaces and held after release (SLG-5; the hold period is a setting).
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_claim_short_name(workspace text, name text, hold_days integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM flockletter_customer_jobs.texting_require_tenant(workspace);
  DELETE FROM flockletter_customer_jobs.texting_short_names
    WHERE short_name=name AND workspace_id<>workspace AND released_at IS NOT NULL AND released_at<clock_timestamp()-make_interval(days=>hold_days);
  INSERT INTO flockletter_customer_jobs.texting_short_names VALUES(name,workspace,NULL)
    ON CONFLICT(short_name) DO UPDATE SET released_at=NULL WHERE flockletter_customer_jobs.texting_short_names.workspace_id=workspace;
  RETURN EXISTS(SELECT FROM flockletter_customer_jobs.texting_short_names WHERE short_name=name AND workspace_id=workspace);
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_release_short_name(workspace text, name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM flockletter_customer_jobs.texting_require_tenant(workspace);
  UPDATE flockletter_customer_jobs.texting_short_names SET released_at=clock_timestamp() WHERE short_name=name AND workspace_id=workspace;
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_register_link(workspace text, name text, link_code text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM flockletter_customer_jobs.texting_require_tenant(workspace);
  IF NOT EXISTS(SELECT FROM flockletter_customer_jobs.texting_short_names WHERE short_name=name AND workspace_id=workspace) THEN
    RAISE EXCEPTION 'texting_short_name_not_owned';
  END IF;
  INSERT INTO flockletter_customer_jobs.texting_link_routes VALUES(name,link_code,workspace);
END $$;
-- Exact, case-sensitive match. A released name keeps resolving for its own workspace only.
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_route_link(name text, link_code text) RETURNS text
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT workspace_id FROM flockletter_customer_jobs.texting_link_routes WHERE short_name=name AND code=link_code
$$;

CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_mock_get(state_key text) RETURNS jsonb
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT value FROM flockletter_customer_jobs.texting_mock_state WHERE key=state_key
$$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_mock_put(state_key text, state_value jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  INSERT INTO flockletter_customer_jobs.texting_mock_state(key,value) VALUES(state_key,state_value)
  ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()
$$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.texting_mock_list(prefix text) RETURNS TABLE(key text, value jsonb)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT key,value FROM flockletter_customer_jobs.texting_mock_state WHERE starts_with(key,prefix) ORDER BY key LIMIT 1000
$$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['texting_require_tenant(text)','texting_setting(text,text)','texting_settings_list(text)',
    'texting_set_setting(text,text,jsonb,integer,text,text,text)','texting_setting_history(text,integer)',
    'texting_bind_account(text,text,text)','texting_account(text)','texting_route_account(text)',
    'texting_bind_number(text,text,uuid)','texting_route_number(text)','texting_claim_short_name(text,text,integer)',
    'texting_release_short_name(text,text)','texting_register_link(text,text,text)','texting_route_link(text,text)',
    'texting_mock_get(text)','texting_mock_put(text,jsonb)','texting_mock_list(text)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION flockletter_customer_jobs.'||f||' FROM PUBLIC';
  END LOOP;
END $$;

-- Only defaults already public in the texting requirements. Fraud-control values (carrier daily
-- limit, allowance, test texts per day, live-recipient allow-list) are deliberately left unset.
DO $$ DECLARE d record; BEGIN
  FOR d IN SELECT * FROM (VALUES
    ('send_window_start_hour','9'::jsonb),('send_window_end_hour','20'),
    ('contact_monthly_limit','4'),('link_life_days','60'),('unconfirmed_expiry_days','7'),
    ('consecutive_failure_limit','3'),('short_name_change_days','90'),('short_name_hold_days','365'),
    ('opt_out_words','["STOP","STOPALL","UNSUBSCRIBE","CANCEL","END","QUIT","OPTOUT","REVOKE","PARAR","CANCELAR","DETENER"]'),
    ('help_words','["HELP","INFO"]'),('start_words','["START","UNSTOP"]'),('confirm_words','["YES","Y"]')
  ) AS v(key,value) LOOP
    IF NOT EXISTS(SELECT FROM flockletter_customer_jobs.texting_settings s WHERE s.key=d.key AND s.workspace_id IS NULL) THEN
      INSERT INTO flockletter_customer_jobs.texting_settings(key,workspace_id,value) VALUES(d.key,NULL,d.value);
      INSERT INTO flockletter_customer_jobs.texting_setting_changes(key,workspace_id,old_value,new_value,actor_id,interface,reason)
        VALUES(d.key,NULL,NULL,d.value,'migration:040','migration','Public default from the texting requirements (D-063).');
    END IF;
  END LOOP;
END $$;
COMMIT;
