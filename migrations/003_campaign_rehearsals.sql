-- Apply through the protected Flockletter migrator. All rehearsal deliveries stay in Postgres.
BEGIN;
CREATE TABLE IF NOT EXISTS workspace_access_events (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id), revision integer NOT NULL CHECK(revision>0),
  operation_key uuid NOT NULL, plan text CHECK(plan IN ('starter','growth','pro')),
  operator_name text NOT NULL, reason text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,revision), UNIQUE(workspace_id,operation_key)
);
ALTER TABLE workspace_access_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_access_events FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='workspace_access_events' AND policyname='workspace_boundary') THEN
    CREATE POLICY workspace_boundary ON workspace_access_events
      USING(workspace_id=current_setting('app.workspace_id',true))
      WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS campaign_brand_identity ON campaigns(workspace_id,brand_id,id);
CREATE TABLE IF NOT EXISTS campaign_rehearsals (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL, campaign_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), content jsonb NOT NULL, render_html text NOT NULL, render_text text NOT NULL,
  creator_id text NOT NULL, actor_id text NOT NULL,
  audience text NOT NULL CHECK(audience IN ('test','confirmed')),
  state text NOT NULL DEFAULT 'reviewed' CHECK(state IN ('reviewed','queued','completed','cancelled','blocked')),
  access_revision integer NOT NULL, selected integer NOT NULL CHECK(selected BETWEEN 1 AND 25),
  excluded integer NOT NULL CHECK(excluded>=0), due_at timestamptz NOT NULL, period date NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz, finished_at timestamptz, reason text,
  PRIMARY KEY(workspace_id,brand_id,id),
  FOREIGN KEY(workspace_id,brand_id,campaign_id) REFERENCES campaigns(workspace_id,brand_id,id)
);
CREATE INDEX IF NOT EXISTS rehearsal_due ON campaign_rehearsals(workspace_id,brand_id,due_at,id) WHERE state='queued';
CREATE INDEX IF NOT EXISTS rehearsal_period ON campaign_rehearsals(workspace_id,period) WHERE approved_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS rehearsal_recipients (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, rehearsal_id uuid NOT NULL, id uuid NOT NULL,
  subscriber_id uuid, email_digest text, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','captured','excluded','cancelled')),
  captured_at timestamptz, PRIMARY KEY(workspace_id,brand_id,rehearsal_id,id),
  UNIQUE(workspace_id,brand_id,rehearsal_id,subscriber_id),
  FOREIGN KEY(workspace_id,brand_id,rehearsal_id) REFERENCES campaign_rehearsals(workspace_id,brand_id,id),
  FOREIGN KEY(workspace_id,brand_id,subscriber_id) REFERENCES subscribers(workspace_id,brand_id,id),
  CHECK ((subscriber_id IS NULL)=(email_digest IS NULL))
);
-- Workspace-wide quota reservations contain counts only. Contact identities stay in brand-protected rows.
CREATE TABLE IF NOT EXISTS rehearsal_reservations (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, rehearsal_id uuid NOT NULL, period date NOT NULL,
  slots integer NOT NULL CHECK(slots IN (0,1)), messages integer NOT NULL CHECK(messages BETWEEN 0 AND 25),
  settled boolean NOT NULL DEFAULT false, PRIMARY KEY(workspace_id,brand_id,rehearsal_id),
  FOREIGN KEY(workspace_id,brand_id,rehearsal_id) REFERENCES campaign_rehearsals(workspace_id,brand_id,id)
);
CREATE INDEX IF NOT EXISTS rehearsal_usage ON rehearsal_reservations(workspace_id,period);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['campaign_rehearsals','rehearsal_recipients','rehearsal_reservations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='rehearsal_boundary') THEN
      IF t='rehearsal_reservations' THEN
        EXECUTE format('CREATE POLICY rehearsal_boundary ON %I USING (workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true))',t);
      ELSE
        EXECUTE format('CREATE POLICY rehearsal_boundary ON %I USING (workspace_id=current_setting(''app.workspace_id'',true) AND brand_id::text=current_setting(''app.intake_brand_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true) AND brand_id::text=current_setting(''app.intake_brand_id'',true))',t);
      END IF;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON workspace_access_events,campaign_rehearsals,rehearsal_recipients,rehearsal_reservations FROM PUBLIC;
COMMIT;
