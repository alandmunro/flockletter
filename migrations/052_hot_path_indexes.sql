BEGIN;
CREATE INDEX IF NOT EXISTS customer_jobs_scopes_next_due
  ON flockletter_customer_jobs.scopes (next_due_at);
CREATE INDEX IF NOT EXISTS sending_admissions_workspace_created
  ON flockletter_customer_jobs.sending_admissions (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS sending_admissions_created
  ON flockletter_customer_jobs.sending_admissions (created_at);
-- Partial index accelerates confirmed-subscriber counts/selection without competing with FK identity lookups.
CREATE INDEX IF NOT EXISTS subscribers_confirmed_brand
  ON public.subscribers (workspace_id, brand_id, id)
  WHERE state = 'confirmed';
CREATE INDEX IF NOT EXISTS customer_audience_confirmations_subscriber
  ON public.customer_audience_confirmations (workspace_id, brand_id, subscriber_id);
CREATE INDEX IF NOT EXISTS operations_workspace_actor_hash
  ON public.operations (workspace_id, actor_id, request_hash);
CREATE INDEX IF NOT EXISTS audit_workspace_created
  ON public.audit (workspace_id, created_at DESC);
COMMIT;
