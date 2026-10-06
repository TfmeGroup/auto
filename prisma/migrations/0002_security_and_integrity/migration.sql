-- TFME Auto — integrity constraints, search indexes, append-only audit log,
-- restricted application role, and row-level security (RLS).
--
-- Two connection identities exist:
--   * the schema OWNER   (MIGRATE_DATABASE_URL) — runs migrations, bypasses RLS
--   * tfme_app           (DATABASE_URL)         — what the running app uses;
--                                                 subject to RLS and grants.
-- Tenant context is set per transaction with
--   select set_config('app.business_id', '<uuid>', true);
-- If it is not set, tenant tables return no rows and reject writes (fail closed).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- --------------- CHECK constraints ---------------

ALTER TABLE "users"
  ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  ADD CONSTRAINT users_failed_login_nonneg CHECK (failed_login_count >= 0);

ALTER TABLE "memberships"
  ADD CONSTRAINT memberships_invited_email_lowercase
    CHECK (invited_email IS NULL OR invited_email = lower(invited_email)),
  -- An ACTIVE or SUSPENDED membership always belongs to a real user.
  ADD CONSTRAINT memberships_active_has_user
    CHECK (status = 'INVITED' OR status = 'ARCHIVED' OR user_id IS NOT NULL),
  -- An unclaimed invitation must be redeemable (token) and addressed (email).
  ADD CONSTRAINT memberships_invited_unclaimed_has_token
    CHECK (NOT (status = 'INVITED' AND user_id IS NULL)
           OR (invite_token_hash IS NOT NULL AND invited_email IS NOT NULL));

ALTER TABLE "businesses"
  ADD CONSTRAINT businesses_vat_rate_range CHECK (vat_rate_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT businesses_currency_upper CHECK (currency = upper(currency)),
  ADD CONSTRAINT businesses_country_upper CHECK (country_code = upper(country_code));

ALTER TABLE "files"
  ADD CONSTRAINT files_size_nonneg CHECK (size_bytes >= 0);

ALTER TABLE "number_sequences"
  ADD CONSTRAINT number_sequences_positive CHECK (next_value >= 1);

ALTER TABLE "plans"
  ADD CONSTRAINT plans_nonneg CHECK (price_cents >= 0 AND max_members >= 1
    AND max_locations >= 1 AND max_storage_mb >= 0);

ALTER TABLE "subscription_payments"
  ADD CONSTRAINT subscription_payments_amount_nonneg CHECK (amount_cents >= 0);

ALTER TABLE "jobs"
  ADD CONSTRAINT jobs_attempts_nonneg CHECK (attempts >= 0 AND max_attempts >= 1);

-- --------------- Partial unique indexes ---------------

-- System role keys are unique globally; custom role keys unique per business.
CREATE UNIQUE INDEX roles_system_key_uniq ON "roles" (key) WHERE business_id IS NULL;
CREATE UNIQUE INDEX roles_business_key_uniq ON "roles" (business_id, key) WHERE business_id IS NOT NULL;
ALTER TABLE "roles"
  ADD CONSTRAINT roles_system_has_no_business CHECK (NOT is_system OR business_id IS NULL);

-- At most one outstanding invitation per (business, email).
CREATE UNIQUE INDEX memberships_one_open_invite_uniq
  ON "memberships" (business_id, invited_email)
  WHERE status = 'INVITED' AND user_id IS NULL;

-- Exactly one default location per business.
CREATE UNIQUE INDEX locations_one_default_uniq ON "locations" (business_id) WHERE is_default;

-- --------------- Tenant-integrity trigger ---------------

-- A membership may only use a system role or a custom role of its OWN business.
CREATE FUNCTION membership_role_scope_check() RETURNS trigger AS $$
DECLARE r_business uuid;
BEGIN
  SELECT business_id INTO r_business FROM roles WHERE id = NEW.role_id;
  IF r_business IS NOT NULL AND r_business <> NEW.business_id THEN
    RAISE EXCEPTION 'role % does not belong to business %', NEW.role_id, NEW.business_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER memberships_role_scope
  BEFORE INSERT OR UPDATE OF role_id, business_id ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION membership_role_scope_check();

-- A membership may only be granted locations of its own business.
CREATE FUNCTION membership_location_scope_check() RETURNS trigger AS $$
DECLARE m_business uuid; l_business uuid;
BEGIN
  SELECT business_id INTO m_business FROM memberships WHERE id = NEW.membership_id;
  SELECT business_id INTO l_business FROM locations WHERE id = NEW.location_id;
  IF m_business IS DISTINCT FROM l_business THEN
    RAISE EXCEPTION 'location and membership belong to different businesses'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER membership_locations_scope
  BEFORE INSERT OR UPDATE ON "membership_locations"
  FOR EACH ROW EXECUTE FUNCTION membership_location_scope_check();

-- --------------- Search indexes (trigram) ---------------

CREATE INDEX customers_name_trgm ON "customers" USING gin (name gin_trgm_ops);
CREATE INDEX customers_company_trgm ON "customers" USING gin (company_name gin_trgm_ops);
CREATE INDEX customers_email_trgm ON "customers" USING gin (email gin_trgm_ops);
CREATE INDEX customers_number_trgm ON "customers" USING gin (customer_number gin_trgm_ops);
CREATE INDEX customers_phone_digits_trgm ON "customers"
  USING gin ((regexp_replace(phone, '\D', '', 'g')) gin_trgm_ops);

-- --------------- Append-only audit log ---------------

CREATE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% not permitted)', TG_OP
    USING ERRCODE = '42501';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- --------------- Application role ---------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tfme_app') THEN
    -- Password is set by scripts/migrate.ts from DATABASE_URL; never in SQL.
    CREATE ROLE tfme_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO tfme_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tfme_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tfme_app;

-- Tables created by future migrations are granted automatically. Any new
-- tenant table MUST also enable RLS (tests/db/rls-coverage.test.ts enforces it).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tfme_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tfme_app;

-- Authorization and pricing reference data is owner-managed: written only by
-- migrations / scripts/migrate.ts, so a compromised app cannot edit system roles,
-- grant itself permissions, or change plan limits. (Custom roles, a later
-- feature, will add narrowly-scoped grants in their own migration.)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "roles", "role_permissions", "plans" FROM tfme_app;

-- Audit log: the application can read and append, never rewrite.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs" FROM tfme_app;

DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON "_prisma_migrations" FROM tfme_app;
  END IF;
END $$;

-- --------------- Row-level security ---------------

CREATE FUNCTION app_current_business() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.business_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app_current_business() TO tfme_app;

-- Standard tenant policy for data-plane tables.
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "customers"
  USING (business_id = app_current_business())
  WITH CHECK (business_id = app_current_business());

ALTER TABLE "files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "files" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "files"
  USING (business_id = app_current_business())
  WITH CHECK (business_id = app_current_business());

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notifications"
  USING (business_id = app_current_business())
  WITH CHECK (business_id = app_current_business());

ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "locations"
  USING (business_id = app_current_business())
  WITH CHECK (business_id = app_current_business());

ALTER TABLE "number_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "number_sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "number_sequences"
  USING (business_id = app_current_business())
  WITH CHECK (business_id = app_current_business());

-- Audit log: reads are tenant-scoped. Inserts are allowed with no business
-- (account-level events such as login) or for the current tenant only.
-- The app inserts with createMany (no RETURNING), so NULL-business rows are
-- never exposed to tenants via the SELECT policy.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_select_tenant ON "audit_logs" FOR SELECT
  USING (business_id = app_current_business());
CREATE POLICY audit_insert ON "audit_logs" FOR INSERT
  WITH CHECK (business_id IS NULL OR business_id = app_current_business());
