BEGIN;
-- Capacity receipts contain only opaque operation IDs and a one-way scope digest.
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.provisioning_budget (
  operation_id uuid PRIMARY KEY,scope_hash bytea NOT NULL,period date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON flockletter_customer_jobs.provisioning_budget FROM PUBLIC;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.claim_provisioning_budget(
  workspace text,brand uuid,operation uuid,monthly_limit integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  scope bytea; previous bytea; period_start date; used integer;
BEGIN
  IF workspace IS DISTINCT FROM current_setting('app.workspace_id',true) OR
     NOT EXISTS(SELECT FROM public.brands b WHERE b.workspace_id=workspace AND b.id=brand) OR
     operation IS NULL OR monthly_limit IS NULL OR monthly_limit<1 OR monthly_limit>20 THEN
    RETURN false;
  END IF;
  period_start=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date;
  scope=sha256(convert_to(workspace||'/'||brand::text,'UTF8'));
  PERFORM pg_advisory_xact_lock(hashtextextended('flockletter:provisioning-budget',0));
  SELECT scope_hash INTO previous FROM flockletter_customer_jobs.provisioning_budget WHERE operation_id=operation;
  IF FOUND THEN RETURN previous=scope; END IF;
  SELECT count(*) INTO used FROM flockletter_customer_jobs.provisioning_budget WHERE period=period_start;
  IF used>=monthly_limit THEN RETURN false; END IF;
  INSERT INTO flockletter_customer_jobs.provisioning_budget(operation_id,scope_hash,period) VALUES(operation,scope,period_start);
  DELETE FROM flockletter_customer_jobs.provisioning_budget WHERE created_at<clock_timestamp()-interval '90 days';
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.claim_provisioning_budget(text,uuid,uuid,integer) FROM PUBLIC;
COMMIT;
