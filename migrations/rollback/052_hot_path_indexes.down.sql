BEGIN;
DROP INDEX IF EXISTS public.audit_workspace_created;
DROP INDEX IF EXISTS public.operations_workspace_actor_hash;
DROP INDEX IF EXISTS public.customer_audience_confirmations_subscriber;
DROP INDEX IF EXISTS public.subscribers_confirmed_brand;
DROP INDEX IF EXISTS flockletter_customer_jobs.sending_admissions_created;
DROP INDEX IF EXISTS flockletter_customer_jobs.sending_admissions_workspace_created;
DROP INDEX IF EXISTS flockletter_customer_jobs.customer_jobs_scopes_next_due;
COMMIT;
