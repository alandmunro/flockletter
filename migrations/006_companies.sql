-- Apply as the Flockletter migration owner. The upgrade also supports existing web releases.
BEGIN;
LOCK TABLE workspaces, brands IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS companies (
  workspace_id text NOT NULL REFERENCES workspaces(workspace_id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  is_default boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_one_default ON companies(workspace_id) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS companies_workspace_name ON companies(workspace_id, lower(btrim(name)));
CREATE TABLE IF NOT EXISTS company_brands (
  workspace_id text NOT NULL,
  brand_id uuid NOT NULL,
  company_id uuid NOT NULL,
  PRIMARY KEY (workspace_id,brand_id),
  FOREIGN KEY (workspace_id,brand_id) REFERENCES brands(workspace_id,id),
  FOREIGN KEY (workspace_id,company_id) REFERENCES companies(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS company_brands_by_company ON company_brands(workspace_id,company_id);
CREATE INDEX IF NOT EXISTS brands_workspace_name_lookup ON brands(workspace_id, lower(btrim(name)));

-- Version 8 UUIDs allow an application-defined, stable hash. Identity remains scoped by workspace.
CREATE OR REPLACE FUNCTION public.flockletter_default_company_id(text)
RETURNS uuid LANGUAGE SQL IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  WITH hashed AS (SELECT left(encode(sha256(convert_to('flockletter/default-company/v1/' || $1,'UTF8')),'hex'),32) AS value)
  SELECT overlay(overlay(value placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid FROM hashed
$$;

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
ALTER TABLE company_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_brands FORCE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['companies','company_brands'] LOOP
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='workspace_boundary') THEN
      EXECUTE format('CREATE POLICY workspace_boundary ON %I USING (workspace_id = current_setting(''app.workspace_id'',true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'',true))',t);
    END IF;
  END LOOP;
END $$;

-- FORCE RLS also applies to a non-superuser migration owner. These transaction-local
-- policies let only that owner perform the backfill; none exists at commit.
CREATE POLICY companies_migration_read ON workspaces FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY companies_migration_read ON brands FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY companies_migration ON companies TO CURRENT_USER USING (true) WITH CHECK (true);
CREATE POLICY companies_migration ON company_brands TO CURRENT_USER USING (true) WITH CHECK (true);
INSERT INTO companies(workspace_id,id,name,is_default)
  SELECT w.workspace_id, public.flockletter_default_company_id(w.workspace_id),
         left(coalesce(nullif(btrim(w.name),''),'Primary company'),100), true
  FROM workspaces w WHERE NOT EXISTS (
    SELECT FROM companies c WHERE c.workspace_id=w.workspace_id AND c.is_default
  );
INSERT INTO company_brands(workspace_id,brand_id,company_id)
  SELECT b.workspace_id,b.id,c.id FROM brands b
  JOIN companies c ON c.workspace_id=b.workspace_id AND c.is_default
  ON CONFLICT (workspace_id,brand_id) DO NOTHING;
DROP POLICY companies_migration ON company_brands;
DROP POLICY companies_migration ON companies;
DROP POLICY companies_migration_read ON brands;
DROP POLICY companies_migration_read ON workspaces;

-- The original workspace.initialize creates a workspace then its first brand. Hooks
-- keep the association atomic even across rollbacks to a compatible older web revision.
CREATE OR REPLACE FUNCTION public.flockletter_initialize_company()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.companies(workspace_id,id,name,is_default) VALUES (
    NEW.workspace_id, public.flockletter_default_company_id(NEW.workspace_id),
    left(coalesce(nullif(btrim(NEW.name),''),'Primary company'),100), true
  );
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER flockletter_initialize_company
AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION public.flockletter_initialize_company();

CREATE OR REPLACE FUNCTION public.flockletter_assign_company()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.company_brands(workspace_id,brand_id,company_id)
  VALUES (NEW.workspace_id,NEW.id,public.flockletter_default_company_id(NEW.workspace_id));
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER flockletter_assign_company
AFTER INSERT ON brands FOR EACH ROW EXECUTE FUNCTION public.flockletter_assign_company();

-- Old brands could already share a case-insensitive name. Preserve those names and
-- all their identities. New names reserve the normalized spelling in this workspace.
CREATE OR REPLACE FUNCTION public.flockletter_check_brand_name()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF lower(btrim(OLD.name))=lower(btrim(NEW.name)) THEN RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id,0));
  IF EXISTS (SELECT FROM public.brands WHERE workspace_id=NEW.workspace_id AND id<>NEW.id
             AND lower(btrim(name))=lower(btrim(NEW.name))) THEN
    RAISE unique_violation USING MESSAGE='This brand name already exists in the workspace.', CONSTRAINT='brands_workspace_name';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER flockletter_check_brand_name
BEFORE INSERT OR UPDATE OF name ON brands FOR EACH ROW EXECUTE FUNCTION public.flockletter_check_brand_name();
REVOKE ALL ON companies,company_brands FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.flockletter_default_company_id(text),public.flockletter_initialize_company(),
  public.flockletter_assign_company(),public.flockletter_check_brand_name() FROM PUBLIC;
COMMIT;
