BEGIN;
-- A fresh brand may have no planner statistics yet. An ID-leading index gives
-- consent and delivery foreign-key probes a direct lookup for each subscriber.
-- The original primary key and email uniqueness stay scoped to workspace and brand.
CREATE INDEX IF NOT EXISTS subscribers_id_workspace_brand
  ON public.subscribers(id, workspace_id, brand_id);
COMMIT;
