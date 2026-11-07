BEGIN;
-- Remove the membership link when a contact is removed by an authorized lifecycle operation.
-- Scope remains the same brand and workspace. Never cascade a group change into a contact.
DO $$
DECLARE
  current_fk record;
BEGIN
  SELECT conname,confdeltype INTO STRICT current_fk FROM pg_constraint
    WHERE conrelid='audience_segment_members'::regclass AND confrelid='subscribers'::regclass AND contype='f';
  IF current_fk.confdeltype <> 'c' THEN
    EXECUTE format('ALTER TABLE audience_segment_members DROP CONSTRAINT %I',current_fk.conname);
    ALTER TABLE audience_segment_members ADD CONSTRAINT segment_contact_membership
      FOREIGN KEY (workspace_id,brand_id,subscriber_id) REFERENCES subscribers(workspace_id,brand_id,id) ON DELETE CASCADE;
  END IF;
END $$;
COMMIT;
