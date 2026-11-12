BEGIN;
ALTER TABLE customer_deliveries DROP CONSTRAINT IF EXISTS customer_deliveries_mode_check;
ALTER TABLE customer_deliveries ADD CONSTRAINT customer_deliveries_mode_check CHECK(mode IN ('capture','ses','resend'));
ALTER TABLE customer_deliveries ADD COLUMN IF NOT EXISTS provider_revision integer NOT NULL DEFAULT 0 CHECK(provider_revision>=0);
CREATE TABLE IF NOT EXISTS customer_delivery_providers (
 workspace_id text NOT NULL,brand_id uuid NOT NULL,provider text NOT NULL CHECK(provider IN ('ses','resend')),
 revision integer NOT NULL CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,brand_id),FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
ALTER TABLE customer_delivery_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_delivery_providers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS brand_boundary ON customer_delivery_providers;
CREATE POLICY brand_boundary ON customer_delivery_providers USING(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true));
REVOKE ALL ON customer_delivery_providers FROM PUBLIC;
DROP TRIGGER IF EXISTS flockletter_retention_insert_guard ON public.customer_delivery_providers;
CREATE TRIGGER flockletter_retention_insert_guard BEFORE INSERT ON public.customer_delivery_providers FOR EACH ROW EXECUTE FUNCTION public.flockletter_retention_insert_guard();
ALTER TABLE public.customer_delivery_providers ENABLE ALWAYS TRIGGER flockletter_retention_insert_guard;
-- Runtime grants are made by the separately reviewed role-release tooling, never PUBLIC.
CREATE OR REPLACE FUNCTION public.flockletter_delivery_provider_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF ROW(NEW.mode,NEW.provider_binding,NEW.provider_revision) IS DISTINCT FROM ROW(OLD.mode,OLD.provider_binding,OLD.provider_revision)
 THEN RAISE EXCEPTION 'delivery_provider_snapshot_immutable'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.flockletter_delivery_provider_snapshot_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS flockletter_delivery_provider_snapshot_guard ON public.customer_deliveries;
CREATE TRIGGER flockletter_delivery_provider_snapshot_guard BEFORE UPDATE ON public.customer_deliveries FOR EACH ROW EXECUTE FUNCTION public.flockletter_delivery_provider_snapshot_guard();
ALTER TABLE public.customer_deliveries ENABLE ALWAYS TRIGGER flockletter_delivery_provider_snapshot_guard;
COMMIT;
