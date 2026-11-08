BEGIN;
CREATE TABLE IF NOT EXISTS customer_subscriptions (
 workspace_id text PRIMARY KEY REFERENCES workspaces(workspace_id),
 id uuid NOT NULL UNIQUE, source text NOT NULL CHECK(source IN ('exercise','stripe')),
 state text NOT NULL CHECK(state IN ('preparation','trialing','active','past_due','suspended','canceled','closed')),
 plan text NOT NULL CHECK(plan IN ('starter','growth','pro')),
 pending_plan text CHECK(pending_plan IN ('starter','growth','pro')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 trial_started_at timestamptz, trial_end_at timestamptz,
 period_start_at timestamptz, period_end_at timestamptz,
 cancel_at timestamptz, failed_since timestamptz, effective_end_at timestamptz,
 clock_offset_days integer NOT NULL DEFAULT 0 CHECK(clock_offset_days BETWEEN 0 AND 3650),
 provider_account text, provider_customer text, provider_subscription text,
 observed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 risk_hold boolean NOT NULL DEFAULT false, risk_reason text,
 CHECK(source='exercise' OR (provider_account IS NOT NULL AND provider_customer IS NOT NULL AND provider_subscription IS NOT NULL)),
 UNIQUE(provider_account,provider_subscription), UNIQUE(provider_account,provider_customer)
);
CREATE TABLE IF NOT EXISTS customer_billing_events (
 workspace_id text NOT NULL REFERENCES workspaces(workspace_id), source text NOT NULL CHECK(source IN ('exercise','stripe')),
 event_id text NOT NULL, digest text NOT NULL, provider_account text, provider_subscription text,
 event_kind text NOT NULL, finished boolean NOT NULL DEFAULT false, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,source,event_id)
);
CREATE TABLE IF NOT EXISTS customer_billing_intents (
 workspace_id text NOT NULL REFERENCES workspaces(workspace_id), id uuid NOT NULL,
 actor_id text NOT NULL, operation_key uuid NOT NULL, command text NOT NULL, request_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','unknown','completed')),
 result jsonb, provider_account text, provider_reference text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,actor_id,operation_key)
);
CREATE TABLE IF NOT EXISTS customer_usage_reservations (
 workspace_id text NOT NULL REFERENCES workspaces(workspace_id), operation_key text NOT NULL,
 campaign_id uuid NOT NULL, brand_id uuid NOT NULL, period text NOT NULL,
 recipients integer NOT NULL CHECK(recipients BETWEEN 1 AND 10000),
 slots smallint NOT NULL DEFAULT 1 CHECK(slots BETWEEN 0 AND 1),
 accepted integer NOT NULL DEFAULT 0 CHECK(accepted>=0), excluded integer NOT NULL DEFAULT 0 CHECK(excluded>=0),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','released')),
 request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz,
 PRIMARY KEY(workspace_id,operation_key), FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id),
 CHECK(accepted+excluded<=recipients),
 CHECK(state<>'released' OR accepted=0)
);
ALTER TABLE customer_subscriptions ADD COLUMN IF NOT EXISTS risk_hold boolean NOT NULL DEFAULT false;
ALTER TABLE customer_subscriptions ADD COLUMN IF NOT EXISTS risk_reason text;
ALTER TABLE customer_usage_reservations ADD COLUMN IF NOT EXISTS slots smallint NOT NULL DEFAULT 1 CHECK(slots BETWEEN 0 AND 1);
CREATE INDEX IF NOT EXISTS customer_usage_period ON customer_usage_reservations(workspace_id,period);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['customer_subscriptions','customer_billing_events','customer_billing_intents','customer_usage_reservations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='workspace_boundary') THEN
   EXECUTE format('CREATE POLICY workspace_boundary ON %I USING (workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true))',t);
  END IF;
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
 END LOOP;
END $$;
COMMIT;
