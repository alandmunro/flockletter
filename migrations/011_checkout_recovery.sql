BEGIN;
CREATE TABLE IF NOT EXISTS sandbox_expired_checkouts (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id), id uuid NOT NULL, operation_key uuid NOT NULL,
  actor_id text NOT NULL, plan text NOT NULL, sandbox_account text NOT NULL, provider_price text NOT NULL,
  session_id text NOT NULL, observed_at timestamptz NOT NULL, archived_at timestamptz NOT NULL DEFAULT now(),
  replacement_id uuid NOT NULL, restart_key uuid NOT NULL, restart_actor text NOT NULL, restart_plan text NOT NULL,
  PRIMARY KEY (workspace_id,id), UNIQUE(workspace_id,restart_key), UNIQUE(workspace_id,replacement_id),
  CHECK (plan IN ('starter','growth','pro') AND restart_plan IN ('starter','growth','pro'))
);
ALTER TABLE sandbox_expired_checkouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_expired_checkouts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='sandbox_expired_checkouts' AND policyname='workspace_boundary') THEN
    CREATE POLICY workspace_boundary ON sandbox_expired_checkouts
      USING (workspace_id=current_setting('app.workspace_id',true)) WITH CHECK (workspace_id=current_setting('app.workspace_id',true));
  END IF;
END $$;
REVOKE ALL ON sandbox_expired_checkouts FROM PUBLIC;
COMMIT;
