BEGIN;
CREATE TABLE IF NOT EXISTS customer_infrastructure_intents (
  workspace_id text NOT NULL,brand_id uuid NOT NULL,id uuid NOT NULL,created_by text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('capture','aws')),request jsonb NOT NULL,request_digest text NOT NULL,
  source_revision integer NOT NULL,source_kind text NOT NULL,
  state text NOT NULL CHECK(state IN ('reviewed','queued','provisioning','awaiting_dns','verified','captured','held','uncertain','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 27),
  step text NOT NULL DEFAULT 'tenant',step_attempts integer NOT NULL DEFAULT 0 CHECK(step_attempts BETWEEN 0 AND 1),
  reason text,cancel_requested boolean NOT NULL DEFAULT false,facts jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,brand_id,id),
  FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS customer_provider_routes (
  workspace_id text NOT NULL,brand_id uuid NOT NULL,intent_id uuid NOT NULL,provider_binding text NOT NULL,
  sender_revision integer NOT NULL,captured boolean NOT NULL,verified boolean NOT NULL,facts jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,brand_id),
  FOREIGN KEY(workspace_id,brand_id,intent_id) REFERENCES customer_infrastructure_intents(workspace_id,brand_id,id),
  CHECK(NOT captured OR NOT verified)
);
CREATE TABLE IF NOT EXISTS customer_infrastructure_events (
  workspace_id text NOT NULL,id uuid NOT NULL,intent_id uuid NOT NULL,actor_id text NOT NULL,
  event text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,intent_id) REFERENCES customer_infrastructure_intents(workspace_id,id)
);
ALTER TABLE customer_infrastructure_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_infrastructure_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_infrastructure_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_infrastructure_events FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_provider_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_provider_routes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_scope ON customer_infrastructure_intents;
CREATE POLICY workspace_scope ON customer_infrastructure_intents USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
DROP POLICY IF EXISTS workspace_scope ON customer_infrastructure_events;
CREATE POLICY workspace_scope ON customer_infrastructure_events USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
DROP POLICY IF EXISTS brand_scope ON customer_provider_routes;
CREATE POLICY brand_scope ON customer_provider_routes USING(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true));
REVOKE ALL ON customer_infrastructure_intents,customer_provider_routes,customer_infrastructure_events FROM PUBLIC;
COMMIT;
