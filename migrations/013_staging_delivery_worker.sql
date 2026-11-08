BEGIN;
-- Existing approvals always authorize the original capture path.
ALTER TABLE campaign_rehearsals ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'capture'
  CHECK (transport IN ('capture','provider_test'));
ALTER TABLE rehearsal_recipients
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS next_check_at timestamptz;
ALTER TABLE rehearsal_recipients DROP CONSTRAINT IF EXISTS rehearsal_recipients_state_check;
ALTER TABLE rehearsal_recipients ADD CONSTRAINT rehearsal_recipients_state_check
  CHECK (state IN ('pending','submitting','uncertain','accepted','rejected','captured','excluded','cancelled'));
CREATE INDEX IF NOT EXISTS delivery_work_due ON rehearsal_recipients
  (workspace_id,brand_id,rehearsal_id,state,next_check_at) WHERE state IN ('pending','submitting','uncertain');

-- This is the isolated staging provider's receipt, independent of the worker's decision to retry.
CREATE TABLE IF NOT EXISTS delivery_test_receipts (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, rehearsal_id uuid NOT NULL, operation_key uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), message_digest text NOT NULL,
  PRIMARY KEY(workspace_id,brand_id,operation_key),
  FOREIGN KEY(workspace_id,brand_id,rehearsal_id,operation_key)
    REFERENCES rehearsal_recipients(workspace_id,brand_id,rehearsal_id,id)
);
ALTER TABLE delivery_test_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_test_receipts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename='delivery_test_receipts' AND policyname='delivery_boundary') THEN
    CREATE POLICY delivery_boundary ON delivery_test_receipts
      USING (workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true))
      WITH CHECK (workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true));
  END IF;
END $$;
REVOKE ALL ON delivery_test_receipts FROM PUBLIC;
COMMIT;
