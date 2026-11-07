BEGIN;
CREATE TABLE IF NOT EXISTS team_grants (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id), user_id text NOT NULL, permission text NOT NULL CHECK(permission IN('viewer','editor')),
  updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS team_grant_brands (
  workspace_id text NOT NULL, user_id text NOT NULL, brand_id uuid NOT NULL, PRIMARY KEY(workspace_id,user_id,brand_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES team_grants(workspace_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['team_grants','team_grant_brands'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='workspace_boundary') THEN
      EXECUTE format('CREATE POLICY workspace_boundary ON %I USING (workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true))',t);
    END IF;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  END LOOP;
END $$;
COMMIT;
