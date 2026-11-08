BEGIN;
CREATE TABLE IF NOT EXISTS sender_domains (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, domain text NOT NULL, challenge uuid NOT NULL,
  checked_at timestamptz, verified_at timestamptz,
  PRIMARY KEY(workspace_id,brand_id), FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
ALTER TABLE sender_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE sender_domains FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='sender_domains' AND policyname='sender_boundary') THEN
    CREATE POLICY sender_boundary ON sender_domains
      USING (workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true))
      WITH CHECK (workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true));
  END IF;
END $$;
REVOKE ALL ON sender_domains FROM PUBLIC;
COMMIT;
