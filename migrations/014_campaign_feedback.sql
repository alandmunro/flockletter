BEGIN;
ALTER TABLE campaign_rehearsals DROP CONSTRAINT IF EXISTS campaign_rehearsals_transport_check;
ALTER TABLE campaign_rehearsals ADD CONSTRAINT campaign_rehearsals_transport_check
  CHECK(transport IN ('capture','provider_test','feedback_test','ses_simulator'));
ALTER TABLE campaign_rehearsals ADD COLUMN IF NOT EXISTS provider_binding text;
-- Old reviews cannot acquire new privileges when an operator changes configuration.
ALTER TABLE campaign_rehearsals DROP CONSTRAINT IF EXISTS campaign_provider_binding_check;
ALTER TABLE campaign_rehearsals ADD CONSTRAINT campaign_provider_binding_check CHECK(
  (transport IN ('capture','provider_test') AND provider_binding IS NULL) OR
  (transport='feedback_test' AND provider_binding IS NOT NULL AND provider_binding='local-feedback-v1') OR
  (transport='ses_simulator' AND provider_binding IS NOT NULL AND provider_binding ~ '^[a-f0-9]{64}$'));
CREATE TABLE IF NOT EXISTS campaign_provider_receipts (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, rehearsal_id uuid NOT NULL, operation_key uuid NOT NULL,
  provider_binding text NOT NULL, message_id text NOT NULL CHECK(length(message_id) BETWEEN 1 AND 256),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,brand_id,operation_key), UNIQUE(workspace_id,brand_id,provider_binding,message_id),
  FOREIGN KEY(workspace_id,brand_id,rehearsal_id,operation_key) REFERENCES rehearsal_recipients(workspace_id,brand_id,rehearsal_id,id)
);
CREATE TABLE IF NOT EXISTS campaign_provider_events (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, operation_key uuid NOT NULL,
  event_id text NOT NULL CHECK(length(event_id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK(kind IN ('delivered','temporary_bounce','permanent_bounce','complaint')),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,brand_id,event_id),
  FOREIGN KEY(workspace_id,brand_id,operation_key) REFERENCES campaign_provider_receipts(workspace_id,brand_id,operation_key)
);
CREATE INDEX IF NOT EXISTS campaign_provider_events_operation ON campaign_provider_events(workspace_id,brand_id,operation_key);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['campaign_provider_receipts','campaign_provider_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='feedback_boundary') THEN
      EXECUTE format('CREATE POLICY feedback_boundary ON %I USING (workspace_id=current_setting(''app.workspace_id'',true) AND brand_id::text=current_setting(''app.intake_brand_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true) AND brand_id::text=current_setting(''app.intake_brand_id'',true))',t);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON campaign_provider_receipts,campaign_provider_events FROM PUBLIC;
COMMIT;
