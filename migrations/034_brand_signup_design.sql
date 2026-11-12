ALTER TABLE brands ADD COLUMN IF NOT EXISTS signup_design jsonb,
  ADD COLUMN IF NOT EXISTS signup_design_revision integer NOT NULL DEFAULT 0;
