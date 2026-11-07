BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='connections'::regclass AND conname='subscriber_signup_only') THEN
    ALTER TABLE connections ADD CONSTRAINT subscriber_signup_only CHECK (NOT ('subscriber:signup'=ANY(scopes))
      OR (scopes=ARRAY['subscriber:signup']::text[] AND cardinality(brand_ids)=1));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS subscriber_intake_settings (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT false,
  heartbeat_at timestamptz, worker_mode text CHECK(worker_mode IN ('capture','live')), worker_fingerprint text,
  accepted bigint NOT NULL DEFAULT 0, replays bigint NOT NULL DEFAULT 0, throttled bigint NOT NULL DEFAULT 0, rejected bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(workspace_id,brand_id), FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS subscribers (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL, email_normalized text NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','confirmed','unsubscribed','hard_bounced','complained')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz,
  PRIMARY KEY(workspace_id,brand_id,id), UNIQUE(workspace_id,brand_id,email_normalized),
  FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS subscriber_consent_events (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL, subscriber_id uuid NOT NULL,
  event text NOT NULL CHECK(event IN ('signup_requested','confirmed','unsubscribed','suppressed')),
  purpose text NOT NULL, policy_version text NOT NULL, text_digest text NOT NULL, source text NOT NULL, source_domain text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,brand_id,id), UNIQUE(workspace_id,brand_id,subscriber_id,id),
  FOREIGN KEY(workspace_id,brand_id,subscriber_id) REFERENCES subscribers(workspace_id,brand_id,id)
);
CREATE TABLE IF NOT EXISTS subscriber_confirmation_tokens (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL, subscriber_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('confirm','unsubscribe')), token_hash text NOT NULL, request_event_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  PRIMARY KEY(workspace_id,brand_id,id), UNIQUE(workspace_id,brand_id,subscriber_id,id),
  FOREIGN KEY(workspace_id,brand_id,subscriber_id) REFERENCES subscribers(workspace_id,brand_id,id),
  FOREIGN KEY(workspace_id,brand_id,subscriber_id,request_event_id) REFERENCES subscriber_consent_events(workspace_id,brand_id,subscriber_id,id),
  CHECK(action='unsubscribe' OR expires_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS subscriber_token_history ON subscriber_confirmation_tokens(workspace_id,brand_id,subscriber_id,action,issued_at DESC);
CREATE TABLE IF NOT EXISTS subscriber_outbox (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL, subscriber_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  token_id uuid NOT NULL, unsubscribe_id uuid NOT NULL, mode text NOT NULL CHECK(mode IN ('capture','live')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','delivered_to_provider','captured','failed','unknown','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), next_attempt_at timestamptz NOT NULL DEFAULT now(),
  first_attempt_at timestamptz, attempts integer NOT NULL DEFAULT 0, lease_id uuid, lease_until timestamptz,
  provider_id text, payload_digest text, error_category text, uncertain boolean NOT NULL DEFAULT false,
  PRIMARY KEY(workspace_id,brand_id,id), UNIQUE(workspace_id,brand_id,token_id), UNIQUE(workspace_id,brand_id,provider_id),
  FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id),
  FOREIGN KEY(workspace_id,brand_id,subscriber_id,token_id) REFERENCES subscriber_confirmation_tokens(workspace_id,brand_id,subscriber_id,id),
  FOREIGN KEY(workspace_id,brand_id,subscriber_id,unsubscribe_id) REFERENCES subscriber_confirmation_tokens(workspace_id,brand_id,subscriber_id,id)
);
CREATE INDEX IF NOT EXISTS subscriber_outbox_due ON subscriber_outbox(workspace_id,brand_id,next_attempt_at) WHERE state IN ('pending','leased');
CREATE TABLE IF NOT EXISTS subscriber_signup_operations (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, connection_id uuid NOT NULL, operation_key text NOT NULL,
  request_digest text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,brand_id,connection_id,operation_key),
  FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id),
  FOREIGN KEY(workspace_id,connection_id) REFERENCES connections(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS subscriber_operation_retention ON subscriber_signup_operations(workspace_id,brand_id,created_at);
CREATE TABLE IF NOT EXISTS subscriber_rate_buckets (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, bucket text NOT NULL, window_at timestamptz NOT NULL, requests integer NOT NULL,
  PRIMARY KEY(workspace_id,brand_id,bucket), FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS subscriber_feedback (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, event_id text NOT NULL, job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,brand_id,event_id),
  FOREIGN KEY(workspace_id,brand_id,job_id) REFERENCES subscriber_outbox(workspace_id,brand_id,id)
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriber_intake_settings','subscribers','subscriber_consent_events','subscriber_confirmation_tokens',
    'subscriber_outbox','subscriber_signup_operations','subscriber_rate_buckets','subscriber_feedback'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='subscriber_brand_boundary') THEN
      EXECUTE format('CREATE POLICY subscriber_brand_boundary ON %I USING (workspace_id=current_setting(''app.workspace_id'',true) AND brand_id::text=current_setting(''app.intake_brand_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true) AND brand_id::text=current_setting(''app.intake_brand_id'',true))',t);
    END IF;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  END LOOP;
END $$;
COMMIT;
