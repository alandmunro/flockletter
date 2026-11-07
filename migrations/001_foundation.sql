-- Run as the dedicated migration owner, never the runtime role.
BEGIN;
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS brands (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id), id uuid NOT NULL,
  name text NOT NULL, PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS campaigns (
  workspace_id text NOT NULL, id uuid NOT NULL, brand_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0), content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS assets (
  workspace_id text NOT NULL, id uuid NOT NULL, brand_id uuid NOT NULL,
  item_key text NOT NULL, name text NOT NULL, mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 5242880), sha256 text NOT NULL,
  width integer NOT NULL, height integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,brand_id,item_key),
  FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS connections (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id), id uuid NOT NULL,
  name text NOT NULL, issuer_id text NOT NULL, token_hash text NOT NULL,
  scopes text[] NOT NULL, brand_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz,
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,token_hash)
);
CREATE TABLE IF NOT EXISTS operations (
  workspace_id text NOT NULL, actor_id text NOT NULL, operation_key text NOT NULL,
  request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,actor_id,operation_key)
);
CREATE TABLE IF NOT EXISTS audit (
  workspace_id text NOT NULL, id uuid NOT NULL, actor_id text NOT NULL, action text NOT NULL,
  resource_id text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id)
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspaces','brands','campaigns','assets','connections','operations','audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='workspace_boundary') THEN
      EXECUTE format('CREATE POLICY workspace_boundary ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))', t);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
COMMIT;
