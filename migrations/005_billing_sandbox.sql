BEGIN;
CREATE TABLE IF NOT EXISTS sandbox_checkouts (
  workspace_id text PRIMARY KEY REFERENCES workspaces(workspace_id), id uuid NOT NULL, operation_key uuid NOT NULL,
  actor_id text NOT NULL, plan text NOT NULL CHECK(plan IN ('starter','growth','pro')), sandbox_account text NOT NULL,
  provider_price text NOT NULL, session_id text, customer_id text, subscription_id text, status text NOT NULL DEFAULT 'pending',
  trial_end timestamptz, created_at timestamptz NOT NULL DEFAULT now(), observed_at timestamptz,
  UNIQUE(id), UNIQUE(sandbox_account,session_id), UNIQUE(sandbox_account,subscription_id), UNIQUE(sandbox_account,customer_id)
);
CREATE TABLE IF NOT EXISTS sandbox_events (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id), event_id text NOT NULL, kind text NOT NULL,
  digest text NOT NULL, finished boolean NOT NULL DEFAULT false, received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,event_id)
);
CREATE TABLE IF NOT EXISTS sandbox_portal_intents (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id), operation_key uuid NOT NULL, actor_id text NOT NULL, customer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,operation_key)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sandbox_checkouts','sandbox_events','sandbox_portal_intents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='workspace_boundary') THEN
      EXECUTE format('CREATE POLICY workspace_boundary ON %I USING (workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true))',t);
    END IF;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  END LOOP;
END $$;
COMMIT;
