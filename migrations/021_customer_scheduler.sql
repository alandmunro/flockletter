BEGIN;
-- Server-owned routing metadata. Customer content remains behind its tenant policies.
DO $$ BEGIN
  IF to_regnamespace('flockletter_customer_jobs') IS NULL THEN
    IF NOT has_database_privilege(current_user,current_database(),'CREATE') THEN
      RAISE EXCEPTION 'Database owner must prepare the customer schemas before migrations; staging uses scripts/prepare-customer-schemas.mjs';
    END IF;
    CREATE SCHEMA flockletter_customer_jobs;
  END IF;
END $$;
REVOKE ALL ON SCHEMA flockletter_customer_jobs FROM PUBLIC;
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.scopes (
  workspace_id text PRIMARY KEY CHECK(workspace_id ~ '^org_[A-Za-z0-9_-]{1,120}$'),
  next_due_at timestamptz NOT NULL, touched_at timestamptz NOT NULL DEFAULT now(),
  last_pass_at timestamptz,last_failure_at timestamptz,last_failure_code text
);
REVOKE ALL ON flockletter_customer_jobs.scopes FROM PUBLIC;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.wake(workspace text, due timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF workspace IS DISTINCT FROM current_setting('app.workspace_id',true) OR due IS NULL OR
     NOT EXISTS(SELECT FROM public.workspaces w WHERE w.workspace_id=workspace) THEN
    RAISE EXCEPTION 'Invalid customer scheduler scope';
  END IF;
  INSERT INTO flockletter_customer_jobs.scopes(workspace_id,next_due_at) VALUES(workspace,due)
    ON CONFLICT(workspace_id) DO UPDATE SET next_due_at=least(flockletter_customer_jobs.scopes.next_due_at,excluded.next_due_at),touched_at=now();
  PERFORM pg_notify('flockletter_customer_jobs',workspace);
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.due_scopes()
RETURNS TABLE(workspace_id text) LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
  SELECT s.workspace_id FROM flockletter_customer_jobs.scopes s
    WHERE s.next_due_at<=now() ORDER BY s.next_due_at,s.workspace_id LIMIT 100
$$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.snooze(workspace text, due timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF workspace IS DISTINCT FROM current_setting('app.workspace_id',true) OR due IS NULL THEN
    RAISE EXCEPTION 'Invalid customer scheduler scope';
  END IF;
  UPDATE flockletter_customer_jobs.scopes SET next_due_at=due,touched_at=now() WHERE workspace_id=workspace;
END $$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.wake(text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.due_scopes() FROM PUBLIC;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.snooze(text,timestamptz) FROM PUBLIC;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.record_pass(workspace text, failure text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF workspace IS DISTINCT FROM current_setting('app.workspace_id',true) OR
     (failure IS NOT NULL AND failure NOT IN ('workspace_job_requires_review','delivery_job_requires_review')) THEN
    RAISE EXCEPTION 'Invalid customer worker receipt';
  END IF;
  UPDATE flockletter_customer_jobs.scopes SET last_pass_at=now(),
    last_failure_at=CASE WHEN failure IS NOT NULL THEN now() ELSE last_failure_at END,
    last_failure_code=failure WHERE workspace_id=workspace;
END $$;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.scope_status(workspace text)
RETURNS TABLE(last_pass_at timestamptz,last_failure_at timestamptz,last_failure_code text)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
  SELECT s.last_pass_at,s.last_failure_at,s.last_failure_code FROM flockletter_customer_jobs.scopes s
  WHERE s.workspace_id=workspace AND workspace=current_setting('app.workspace_id',true)
$$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.record_pass(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.scope_status(text) FROM PUBLIC;
COMMIT;
