BEGIN;
CREATE TABLE IF NOT EXISTS flockletter_customer_jobs.signup_routes (
  slug text NOT NULL, form_token text NOT NULL UNIQUE,
  workspace_id text NOT NULL, brand_id uuid NOT NULL, PRIMARY KEY(workspace_id,brand_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS signup_routes_slug ON flockletter_customer_jobs.signup_routes(lower(slug));
REVOKE ALL ON flockletter_customer_jobs.signup_routes FROM PUBLIC;

CREATE OR REPLACE FUNCTION flockletter_customer_jobs.reserve_signup(text,uuid,text,text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE base text:=coalesce(nullif(left(regexp_replace($4,'[^A-Za-z0-9]','','g'),100),''),'Newsletter'); candidate text:=base;
BEGIN
  LOOP
    INSERT INTO flockletter_customer_jobs.signup_routes VALUES(candidate,$3,$1,$2) ON CONFLICT DO NOTHING;
    IF FOUND OR EXISTS(SELECT FROM flockletter_customer_jobs.signup_routes WHERE workspace_id=$1 AND brand_id=$2) THEN RETURN; END IF;
    IF EXISTS(SELECT FROM flockletter_customer_jobs.signup_routes WHERE form_token=$3) THEN RAISE EXCEPTION 'Conflicting signup route'; END IF;
    candidate:=base||'-'||left(replace(gen_random_uuid()::text,'-',''),12);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.reserve_signup(text,uuid,text,text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.signup_route_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM flockletter_customer_jobs.reserve_signup(NEW.workspace_id,NEW.brand_id,NEW.form_token,
    (SELECT name FROM public.brands WHERE workspace_id=NEW.workspace_id AND id=NEW.brand_id));
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.signup_route_insert() FROM PUBLIC;
CREATE OR REPLACE TRIGGER signup_route_insert AFTER INSERT ON public.customer_audience_settings FOR EACH ROW EXECUTE FUNCTION flockletter_customer_jobs.signup_route_insert();

-- Keep erasure within its existing tenant-table deletion order; no cross-schema cascade.
CREATE OR REPLACE FUNCTION flockletter_customer_jobs.signup_route_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  DELETE FROM flockletter_customer_jobs.signup_routes WHERE workspace_id=OLD.workspace_id AND brand_id=OLD.brand_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION flockletter_customer_jobs.signup_route_delete() FROM PUBLIC;
CREATE OR REPLACE TRIGGER signup_route_delete AFTER DELETE ON public.customer_audience_settings FOR EACH ROW EXECUTE FUNCTION flockletter_customer_jobs.signup_route_delete();

CREATE POLICY signup_backfill ON public.customer_audience_settings FOR SELECT TO CURRENT_USER USING(true);
CREATE POLICY signup_backfill ON public.brands FOR SELECT TO CURRENT_USER USING(true);
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT s.*,b.name FROM public.customer_audience_settings s JOIN public.brands b ON b.workspace_id=s.workspace_id AND b.id=s.brand_id
    WHERE NOT EXISTS (SELECT FROM flockletter_customer_jobs.signup_routes m WHERE m.workspace_id=s.workspace_id AND m.brand_id=s.brand_id)
    ORDER BY s.updated_at,s.workspace_id,s.brand_id LOOP
    PERFORM flockletter_customer_jobs.reserve_signup(r.workspace_id,r.brand_id,r.form_token,r.name);
  END LOOP;
END $$;
DROP POLICY signup_backfill ON public.customer_audience_settings;
DROP POLICY signup_backfill ON public.brands;

-- Exact matches only. Returning a public form handle grants no access to confirmations or subscribers.
CREATE OR REPLACE FUNCTION public.flockletter_signup_token(text) RETURNS text LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT form_token FROM flockletter_customer_jobs.signup_routes WHERE lower(slug)=lower($1)
$$;
CREATE OR REPLACE FUNCTION public.flockletter_signup_slug(text) RETURNS text LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT slug FROM flockletter_customer_jobs.signup_routes WHERE form_token=$1
$$;
REVOKE ALL ON FUNCTION public.flockletter_signup_token(text),public.flockletter_signup_slug(text) FROM PUBLIC;
COMMIT;
