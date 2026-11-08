BEGIN;
-- Existing operator-only schema; the tenant runtime receives no grants.
CREATE TABLE IF NOT EXISTS flockletter_retention_control.operations (
 operation_key text PRIMARY KEY CHECK(operation_key ~ '^[a-f0-9]{64}$'),
 workspace_id text NOT NULL,job_id uuid NOT NULL,approval_digest text NOT NULL,
 target_digest text NOT NULL,target jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','submitting','unknown','complete','blocked')),
 result_digest text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retention_operations_target ON flockletter_retention_control.operations(workspace_id,job_id);
CREATE TABLE IF NOT EXISTS flockletter_retention_control.approvals (
 nonce uuid PRIMARY KEY,workspace_id text NOT NULL,job_id uuid NOT NULL,approval_digest text NOT NULL,
 payload jsonb NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,job_id)
);
CREATE TABLE IF NOT EXISTS flockletter_retention_control.approval_history (nonce uuid PRIMARY KEY,workspace_id text NOT NULL,job_id uuid NOT NULL,approval_digest text NOT NULL,payload jsonb NOT NULL,expires_at timestamptz NOT NULL,superseded_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON flockletter_retention_control.approval_history FROM PUBLIC;
CREATE TABLE IF NOT EXISTS flockletter_retention_control.restore_quarantines (workspace_id text PRIMARY KEY,checkpoint_digest text NOT NULL,checkpoint_version text NOT NULL,protected_phase text NOT NULL CHECK(protected_phase IN ('quarantined','erased','released')),blocked boolean NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON flockletter_retention_control.restore_quarantines FROM PUBLIC;
REVOKE ALL ON flockletter_retention_control.operations,flockletter_retention_control.approvals FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.flockletter_restore_blocked() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT EXISTS(SELECT 1 FROM flockletter_retention_control.restore_quarantines WHERE blocked) $$;
REVOKE ALL ON FUNCTION public.flockletter_restore_blocked() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.flockletter_retention_blocked(target text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT target IS DISTINCT FROM current_setting('app.workspace_id',true) OR (EXISTS(SELECT 1 FROM flockletter_retention_control.receipts WHERE workspace_id=target) OR EXISTS(SELECT 1 FROM flockletter_retention_control.restore_quarantines WHERE workspace_id=target AND blocked)) $$;
REVOKE ALL ON FUNCTION public.flockletter_retention_blocked(text) FROM PUBLIC;
COMMIT;
