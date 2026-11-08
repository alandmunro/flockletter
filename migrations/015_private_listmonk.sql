BEGIN;
ALTER TABLE campaign_rehearsals DROP CONSTRAINT IF EXISTS campaign_rehearsals_transport_check;
ALTER TABLE campaign_rehearsals ADD CONSTRAINT campaign_rehearsals_transport_check CHECK
  (transport IN ('capture','provider_test','feedback_test','ses_simulator','listmonk_test','listmonk_ses'));
ALTER TABLE campaign_rehearsals DROP CONSTRAINT IF EXISTS campaign_provider_binding_check;
ALTER TABLE campaign_rehearsals ADD CONSTRAINT campaign_provider_binding_check CHECK(
  (transport IN ('capture','provider_test') AND provider_binding IS NULL) OR
  (transport='feedback_test' AND provider_binding IS NOT NULL AND provider_binding='local-feedback-v1') OR
  (transport IN ('ses_simulator','listmonk_test','listmonk_ses') AND provider_binding IS NOT NULL AND provider_binding ~ '^[a-f0-9]{64}$'));
CREATE TABLE IF NOT EXISTS listmonk_handoffs (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, rehearsal_id uuid NOT NULL, operation_key uuid NOT NULL,
  reference text NOT NULL CHECK(reference ~ '^fl-[a-f0-9]{56}@receipt[.]test$'),
  reviewed_address text NOT NULL CHECK(length(reviewed_address) BETWEEN 3 AND 254),
  render_attempts smallint NOT NULL CHECK(render_attempts BETWEEN 1 AND 3), callback_at timestamptz,
  provider_claim uuid, started_at timestamptz,
  PRIMARY KEY(workspace_id,brand_id,operation_key), UNIQUE(workspace_id,brand_id,reference),
  CHECK((provider_claim IS NULL)=(started_at IS NULL) AND (provider_claim IS NULL OR callback_at IS NOT NULL)),
  FOREIGN KEY(workspace_id,brand_id,rehearsal_id,operation_key) REFERENCES rehearsal_recipients(workspace_id,brand_id,rehearsal_id,id)
);
ALTER TABLE listmonk_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE listmonk_handoffs FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='listmonk_handoffs' AND policyname='engine_brand_boundary') THEN
    CREATE POLICY engine_brand_boundary ON listmonk_handoffs
      USING (workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true))
      WITH CHECK (workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true));
  END IF;
END $$;
REVOKE ALL ON listmonk_handoffs FROM PUBLIC;
COMMIT;
