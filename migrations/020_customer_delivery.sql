BEGIN;
CREATE TABLE IF NOT EXISTS customer_sender_profiles (
  workspace_id text NOT NULL,brand_id uuid NOT NULL,profile jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,brand_id),FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id)
);
ALTER TABLE customer_sender_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_sender_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON customer_sender_profiles;
CREATE POLICY tenant_scope ON customer_sender_profiles USING(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true) AND brand_id::text=current_setting('app.intake_brand_id',true));
REVOKE ALL ON customer_sender_profiles FROM PUBLIC;
CREATE TABLE IF NOT EXISTS customer_deliveries (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, id uuid NOT NULL,
  campaign_id uuid NOT NULL, version integer NOT NULL, actor_id text NOT NULL, creator_id text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('capture','ses')), state text NOT NULL CHECK(state IN ('reviewed','queued','paused','completed','cancelled','blocked')),
  content jsonb NOT NULL, rendered_html text NOT NULL, rendered_text text NOT NULL, asset_digests jsonb NOT NULL, sender_profile jsonb,
  provider_binding text NOT NULL, due_at timestamptz NOT NULL, selected integer NOT NULL CHECK(selected>0),
  excluded integer NOT NULL CHECK(excluded>=0), reason text, reservation_key text,
  created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz, finished_at timestamptz,
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,brand_id,id),
  FOREIGN KEY(workspace_id,brand_id) REFERENCES brands(workspace_id,id),
  FOREIGN KEY(workspace_id,campaign_id) REFERENCES campaigns(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS customer_delivery_recipients (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, delivery_id uuid NOT NULL, id uuid NOT NULL,
  subscriber_id uuid NOT NULL, email_digest text NOT NULL, engine_reference text NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','preparing','prepared','submitting','uncertain','accepted','rejected','excluded','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  render_attempts integer NOT NULL DEFAULT 0 CHECK(render_attempts BETWEEN 0 AND 3),
  render_claim uuid, render_received_at timestamptz, next_check_at timestamptz, reason text,
  feedback text CHECK(feedback IN ('delivered','hard_bounce','complaint','temporary_bounce')), message_id text,
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,brand_id,delivery_id,id), UNIQUE(workspace_id,engine_reference),
  UNIQUE(workspace_id,delivery_id,subscriber_id),
  FOREIGN KEY(workspace_id,brand_id,delivery_id) REFERENCES customer_deliveries(workspace_id,brand_id,id),
  FOREIGN KEY(workspace_id,brand_id,subscriber_id) REFERENCES subscribers(workspace_id,brand_id,id)
);
CREATE TABLE IF NOT EXISTS customer_delivery_captures (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, delivery_id uuid NOT NULL, recipient_id uuid NOT NULL,
  payload jsonb NOT NULL, message_digest text NOT NULL, captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,recipient_id),
  FOREIGN KEY(workspace_id,brand_id,delivery_id,recipient_id)
    REFERENCES customer_delivery_recipients(workspace_id,brand_id,delivery_id,id)
);
CREATE TABLE IF NOT EXISTS customer_delivery_events (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, delivery_id uuid NOT NULL, recipient_id uuid NOT NULL,
  event_id text NOT NULL, kind text NOT NULL, evidence text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,event_id),
  FOREIGN KEY(workspace_id,brand_id,delivery_id,recipient_id)
    REFERENCES customer_delivery_recipients(workspace_id,brand_id,delivery_id,id)
);
CREATE TABLE IF NOT EXISTS customer_delivery_payloads (
  workspace_id text NOT NULL, brand_id uuid NOT NULL, delivery_id uuid NOT NULL, recipient_id uuid NOT NULL,
  envelope jsonb NOT NULL, message_digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,recipient_id),
  FOREIGN KEY(workspace_id,brand_id,delivery_id,recipient_id)
    REFERENCES customer_delivery_recipients(workspace_id,brand_id,delivery_id,id)
);
CREATE INDEX IF NOT EXISTS customer_deliveries_due ON customer_deliveries(workspace_id,state,due_at);
CREATE INDEX IF NOT EXISTS customer_delivery_work ON customer_delivery_recipients(workspace_id,state,next_check_at);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['customer_deliveries','customer_delivery_recipients','customer_delivery_captures','customer_delivery_payloads','customer_delivery_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',name);
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename=name AND policyname='workspace_boundary') THEN
      EXECUTE format('CREATE POLICY workspace_boundary ON %I USING(workspace_id=current_setting(''app.workspace_id'',true)) WITH CHECK(workspace_id=current_setting(''app.workspace_id'',true))',name);
    END IF;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',name);
  END LOOP;
END $$;
COMMIT;
