BEGIN;
CREATE TABLE IF NOT EXISTS customer_team_scenarios (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),user_id text NOT NULL,email text NOT NULL,
  role text NOT NULL CHECK(role IN ('owner','member')),created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id),UNIQUE(workspace_id,email)
);
CREATE TABLE IF NOT EXISTS customer_team_invites (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),id uuid NOT NULL,email text NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','accepted','revoked')),reference text NOT NULL,
  member_id text,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,reference)
);
CREATE TABLE IF NOT EXISTS customer_team_intents (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),id uuid NOT NULL,operation_key uuid NOT NULL,
  actor_id text NOT NULL,issuer_id text NOT NULL,action text NOT NULL,payload jsonb NOT NULL,request_hash text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('exercise','clerk')),
  seat_limit integer CHECK(seat_limit IS NULL OR seat_limit>0),
  state text NOT NULL CHECK(state IN ('prepared','submitting','uncertain','completed','rejected')),
  phase text NOT NULL DEFAULT 'initial',reference text NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,actor_id,operation_key)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['customer_team_scenarios','customer_team_invites','customer_team_intents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='customer_team_workspace_boundary') THEN
      EXECUTE format('CREATE POLICY customer_team_workspace_boundary ON %I USING (workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true))',t);
    END IF;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  END LOOP;
END $$;
COMMIT;
