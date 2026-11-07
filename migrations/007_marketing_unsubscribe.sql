BEGIN;
CREATE TABLE IF NOT EXISTS subscriber_marketing_links (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL, subscriber_id uuid NOT NULL,
  signer_fingerprint text NOT NULL CHECK (signer_fingerprint ~ '^[a-f0-9]{64}$'),
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id,brand_id,id),
  UNIQUE (workspace_id,brand_id,subscriber_id,signer_fingerprint),
  FOREIGN KEY (workspace_id,brand_id,subscriber_id) REFERENCES subscribers(workspace_id,brand_id,id) ON DELETE CASCADE
);
ALTER TABLE subscriber_marketing_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriber_marketing_links FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='subscriber_marketing_links'
    AND policyname='subscriber_brand_boundary') THEN
    CREATE POLICY subscriber_brand_boundary ON subscriber_marketing_links
      USING (workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true))
      WITH CHECK (workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true));
  END IF;
END $$;
REVOKE ALL ON subscriber_marketing_links FROM PUBLIC;
COMMIT;
