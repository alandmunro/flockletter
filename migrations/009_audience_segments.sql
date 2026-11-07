BEGIN;
CREATE TABLE IF NOT EXISTS audience_segments (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name=btrim(name) AND name !~ '[[:cntrl:]]'),
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 50),
  PRIMARY KEY (workspace_id,brand_id,id), UNIQUE (workspace_id,brand_id,slot),
  FOREIGN KEY (workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS audience_segments_name ON audience_segments(workspace_id,brand_id,lower(name));
CREATE TABLE IF NOT EXISTS audience_segment_members (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, segment_id uuid NOT NULL, subscriber_id uuid NOT NULL,
  PRIMARY KEY (workspace_id,brand_id,segment_id,subscriber_id),
  FOREIGN KEY (workspace_id,brand_id,segment_id) REFERENCES audience_segments(workspace_id,brand_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,brand_id,subscriber_id) REFERENCES subscribers(workspace_id,brand_id,id)
);
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['audience_segments','audience_segment_members'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename=tab AND policyname='segment_brand_boundary') THEN
      EXECUTE format('CREATE POLICY segment_brand_boundary ON %I USING (workspace_id=current_setting(''app.workspace_id'',true) AND brand_id::text=current_setting(''app.intake_brand_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true) AND brand_id::text=current_setting(''app.intake_brand_id'',true))',tab);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON audience_segments,audience_segment_members FROM PUBLIC;
-- The reviewed name and ID are historical facts. Group edits and deletion cannot change an existing review.
ALTER TABLE campaign_rehearsals ADD COLUMN IF NOT EXISTS segment_id uuid;
ALTER TABLE campaign_rehearsals ADD COLUMN IF NOT EXISTS segment_name text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='campaign_rehearsals'::regclass AND conname='rehearsal_segment_snapshot') THEN
    ALTER TABLE campaign_rehearsals ADD CONSTRAINT rehearsal_segment_snapshot CHECK (
      (segment_id IS NULL AND segment_name IS NULL) OR
      (audience='confirmed' AND segment_id IS NOT NULL AND segment_name IS NOT NULL AND char_length(segment_name) BETWEEN 1 AND 80)
    );
  END IF;
END $$;
COMMIT;
