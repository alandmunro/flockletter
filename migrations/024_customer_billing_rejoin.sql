BEGIN;
CREATE TABLE IF NOT EXISTS customer_subscription_history (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  provider_account text NOT NULL,provider_subscription text NOT NULL,revision integer NOT NULL CHECK(revision>0),
  provider_customer text NOT NULL,replaced_by text NOT NULL,snapshot jsonb NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,provider_account,provider_subscription,revision)
);
ALTER TABLE customer_subscription_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_subscription_history FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='customer_subscription_history' AND policyname='workspace_boundary') THEN
    CREATE POLICY workspace_boundary ON customer_subscription_history
      USING(workspace_id=current_setting('app.workspace_id',true))
      WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
  END IF;
END $$;
REVOKE ALL ON customer_subscription_history FROM PUBLIC;
COMMIT;
