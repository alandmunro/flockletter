BEGIN;
CREATE TABLE IF NOT EXISTS customer_audience_settings (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT false,
  purpose text NOT NULL, policy_version text NOT NULL, consent_text text NOT NULL, source_domain text NOT NULL,
  form_token text NOT NULL, exercise_key bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,brand_id), UNIQUE(form_token),
  FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id),
  CHECK(octet_length(exercise_key)=32)
);
CREATE TABLE IF NOT EXISTS customer_audience_imports (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL, operation_key uuid NOT NULL,
  actor_id text NOT NULL, source text NOT NULL, file_digest text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,brand_id,id), UNIQUE(workspace_id,brand_id,actor_id,operation_key),
  FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS customer_audience_confirmations (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL, subscriber_id uuid NOT NULL,
  token_hash text NOT NULL, unsubscribe_hash text NOT NULL, mode text NOT NULL CHECK(mode IN ('exercise','live')),
  state text NOT NULL CHECK(state IN ('queued','submitting','captured','accepted','uncertain','confirmed','cancelled')),
  policy_snapshot jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1),
  provider_id text, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  consumed_at timestamptz, next_check_at timestamptz,
  PRIMARY KEY(workspace_id,brand_id,id),
  FOREIGN KEY(workspace_id,brand_id,subscriber_id) REFERENCES subscribers(workspace_id,brand_id,id)
);
CREATE INDEX IF NOT EXISTS customer_audience_confirmation_due ON customer_audience_confirmations(workspace_id,brand_id,state,created_at);
CREATE TABLE IF NOT EXISTS customer_audience_optouts (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL, subscriber_id uuid NOT NULL,
  token_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), used_at timestamptz,
  PRIMARY KEY(workspace_id,brand_id,id),
  FOREIGN KEY(workspace_id,brand_id,subscriber_id) REFERENCES subscribers(workspace_id,brand_id,id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['customer_audience_settings','customer_audience_imports','customer_audience_confirmations','customer_audience_optouts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='customer_audience_brand_boundary') THEN
      EXECUTE format('CREATE POLICY customer_audience_brand_boundary ON %I USING (workspace_id=current_setting(''app.workspace_id'',true) AND brand_id::text=current_setting(''app.intake_brand_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true) AND brand_id::text=current_setting(''app.intake_brand_id'',true))',t);
    END IF;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  END LOOP;
END $$;
COMMIT;
