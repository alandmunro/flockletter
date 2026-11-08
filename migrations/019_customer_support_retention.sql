BEGIN;
CREATE TABLE IF NOT EXISTS customer_support_tickets (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id), id uuid NOT NULL,
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 160), topic text NOT NULL,
  state text NOT NULL CHECK(state IN ('open','review','escalated','queued','replied','closed')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), reply_to text, requester_id text NOT NULL,
  draft text, draft_provenance text CHECK(draft_provenance IN ('approved_guidance','ai_assisted','human')),
  escalation_reason text, mode text NOT NULL CHECK(mode IN ('capture','live')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS customer_support_messages (
  workspace_id text NOT NULL, id uuid NOT NULL, ticket_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('incoming','draft','captured_reply','sent_reply')),
  text text NOT NULL CHECK(length(text) BETWEEN 1 AND 8000), provenance text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,ticket_id) REFERENCES customer_support_tickets(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS customer_support_dispatches (
  workspace_id text NOT NULL, id uuid NOT NULL, ticket_id uuid NOT NULL, ticket_version integer NOT NULL,
  operation_key uuid NOT NULL, body text NOT NULL, body_digest text NOT NULL,
  state text NOT NULL CHECK(state IN ('queued','submitting','accepted','uncertain','rejected','cancelled')),
  mode text NOT NULL CHECK(mode IN ('capture','live')), attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1),
  provider_id text, reason text, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,ticket_id,ticket_version), UNIQUE(workspace_id,operation_key),
  FOREIGN KEY(workspace_id,ticket_id) REFERENCES customer_support_tickets(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS customer_support_events (
  workspace_id text NOT NULL, event_id text NOT NULL, digest text NOT NULL, ticket_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,event_id)
);
CREATE TABLE IF NOT EXISTS customer_retention_cases (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id), id uuid NOT NULL,
  source text NOT NULL CHECK(source IN ('stripe','exercise','complimentary')), source_version text NOT NULL,
  effective_end_at timestamptz NOT NULL, due_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('retained','due','held','awaiting_operator','captured','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0), hold_reason text,
  inventory jsonb NOT NULL DEFAULT '{}'::jsonb, inventory_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,source_version)
);
CREATE TABLE IF NOT EXISTS customer_retention_jobs (
  workspace_id text NOT NULL,id uuid NOT NULL,case_id uuid NOT NULL,case_version integer NOT NULL,
  state text NOT NULL CHECK(state IN ('awaiting_operator','captured','authorized','completed','failed','cancelled')),
  requested_by text NOT NULL, authorization_digest text, checkpoint_digest text, manifest_digest text NOT NULL,
  result jsonb, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,case_id,case_version),
  FOREIGN KEY(workspace_id,case_id) REFERENCES customer_retention_cases(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS customer_retention_receipts (
  workspace_id text NOT NULL,job_id uuid NOT NULL,effective_end_at timestamptz NOT NULL,
  erased_at timestamptz NOT NULL,manifest_digest text NOT NULL,checkpoint_digest text NOT NULL,
  PRIMARY KEY(workspace_id,job_id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['customer_support_tickets','customer_support_messages','customer_support_dispatches',
    'customer_support_events','customer_retention_cases','customer_retention_jobs','customer_retention_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='workspace_boundary') THEN
      EXECUTE format('CREATE POLICY workspace_boundary ON %I USING (workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true))',t);
    END IF;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  END LOOP;
END $$;
DO $$ BEGIN
  IF to_regnamespace('flockletter_retention_control') IS NULL THEN
    IF NOT has_database_privilege(current_user,current_database(),'CREATE') THEN
      RAISE EXCEPTION 'Database owner must prepare the customer schemas before migrations; staging uses scripts/prepare-customer-schemas.mjs';
    END IF;
    CREATE SCHEMA flockletter_retention_control;
  END IF;
END $$;
REVOKE ALL ON SCHEMA flockletter_retention_control FROM PUBLIC;
CREATE TABLE IF NOT EXISTS flockletter_retention_control.authorizations (
  workspace_id text NOT NULL,job_id uuid NOT NULL,source_version text NOT NULL,database_name text NOT NULL,
  manifest_digest text NOT NULL,checkpoint_digest text NOT NULL,authorized_by text NOT NULL,
  expires_at timestamptz NOT NULL,completed_at timestamptz,
  PRIMARY KEY(workspace_id,job_id)
);
CREATE TABLE IF NOT EXISTS flockletter_retention_control.receipts (
  workspace_id text NOT NULL,job_id uuid NOT NULL,source_version text NOT NULL,erased_at timestamptz NOT NULL,
  manifest_digest text NOT NULL,checkpoint_digest text NOT NULL,
  PRIMARY KEY(workspace_id,job_id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA flockletter_retention_control FROM PUBLIC;
COMMIT;
