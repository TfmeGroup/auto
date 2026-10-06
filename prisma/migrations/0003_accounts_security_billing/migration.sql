-- CreateEnum
CREATE TYPE "billing_interval" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "plan_status" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "export_status" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'EXPIRED');

-- AlterEnum (in place, so existing rows keep their meaning)
ALTER TYPE "user_status" RENAME VALUE 'DISABLED' TO 'SUSPENDED';
ALTER TYPE "user_status" ADD VALUE 'DEACTIVATED';

-- AlterEnum
ALTER TYPE "auth_token_type" ADD VALUE 'EMAIL_CHANGE';

-- AlterEnum
ALTER TYPE "business_status" ADD VALUE 'CLOSED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "subscription_status" ADD VALUE 'GRACE_PERIOD';
ALTER TYPE "subscription_status" ADD VALUE 'SUSPENDED';

-- AlterTable
ALTER TABLE "users" RENAME COLUMN "phone" TO "mobile";

ALTER TABLE "users"
ADD COLUMN     "deactivated_at" TIMESTAMPTZ(3),
ADD COLUMN     "first_name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "last_login_ip" TEXT,
ADD COLUMN     "last_login_user_agent" TEXT,
ADD COLUMN     "last_name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfa_enabled_at" TIMESTAMPTZ(3),
ADD COLUMN     "mfa_last_used_step" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mfa_pending_secret_enc" TEXT,
ADD COLUMN     "mfa_secret_enc" TEXT,
ADD COLUMN     "profile_photo_key" TEXT;

-- AlterTable
ALTER TABLE "auth_tokens" ADD COLUMN     "new_email" TEXT;

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "billing_address_line1" TEXT,
ADD COLUMN     "billing_address_line2" TEXT,
ADD COLUMN     "billing_city" TEXT,
ADD COLUMN     "billing_postal_code" TEXT,
ADD COLUMN     "billing_province" TEXT,
ADD COLUMN     "business_type" TEXT,
ADD COLUMN     "close_reason" TEXT,
ADD COLUMN     "closed_at" TIMESTAMPTZ(3),
ADD COLUMN     "closed_by_id" UUID,
ADD COLUMN     "logo_file_id" UUID,
ADD COLUMN     "require_mfa" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trading_name" TEXT,
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "archived_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "is_owner" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "billing_interval" "billing_interval" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "effective_from" TIMESTAMPTZ(3),
ADD COLUMN     "effective_to" TIMESTAMPTZ(3),
ADD COLUMN     "is_custom" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" "plan_status" NOT NULL DEFAULT 'ACTIVE',
ALTER COLUMN "price_cents" DROP NOT NULL;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "canceled_at" TIMESTAMPTZ(3),
ADD COLUMN     "canceled_by_id" UUID,
ADD COLUMN     "converted_at" TIMESTAMPTZ(3),
ADD COLUMN     "override_max_locations" INTEGER,
ADD COLUMN     "override_max_members" INTEGER,
ADD COLUMN     "override_max_storage_mb" INTEGER,
ADD COLUMN     "past_due_since" TIMESTAMPTZ(3),
ADD COLUMN     "payment_method_summary" TEXT,
ADD COLUMN     "pending_change_at" TIMESTAMPTZ(3),
ADD COLUMN     "pending_plan_id" UUID,
ADD COLUMN     "trial_started_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "mfa_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notification_preferences" (
    "user_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_notification_preferences_pkey" PRIMARY KEY ("user_id","category")
);

-- CreateTable
CREATE TABLE "platform_admins" (
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "data_exports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "requested_by_id" UUID,
    "status" "export_status" NOT NULL DEFAULT 'PENDING',
    "scope" TEXT[],
    "storage_key" TEXT,
    "size_bytes" INTEGER,
    "sha256" TEXT,
    "error" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "data_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_features" (
    "plan_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("plan_id","feature_key")
);

-- CreateTable
CREATE TABLE "subscription_invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "subtotal_cents" INTEGER NOT NULL,
    "vat_cents" INTEGER NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "vat_rate_bps" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'ZAR',
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mfa_challenges_token_hash_key" ON "mfa_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "mfa_challenges_user_id_idx" ON "mfa_challenges"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_codes_user_id_code_hash_key" ON "mfa_recovery_codes"("user_id", "code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "data_exports_storage_key_key" ON "data_exports"("storage_key");

-- CreateIndex
CREATE INDEX "data_exports_business_id_requested_at_idx" ON "data_exports"("business_id", "requested_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoices_payment_id_key" ON "subscription_invoices"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoices_number_key" ON "subscription_invoices"("number");

-- CreateIndex
CREATE INDEX "subscription_invoices_business_id_issued_at_idx" ON "subscription_invoices"("business_id", "issued_at" DESC);

-- AddForeignKey
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_pending_plan_id_fkey" FOREIGN KEY ("pending_plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- =====================================================================
-- Part 2: hand-written integrity, security and data migration
-- =====================================================================

ALTER TABLE "subscriptions" ADD COLUMN "recurring_amount_cents" INTEGER;

-- ---------- backfill ----------
UPDATE "users" SET
  first_name = split_part(name, ' ', 1),
  last_name  = btrim(substr(name, length(split_part(name, ' ', 1)) + 1))
WHERE first_name = '';

-- Plans from Part 1 are superseded by Solo / Team / Business / Custom (synced by npm run db:migrate).
UPDATE "plans" SET status = 'ARCHIVED', is_public = false WHERE key IN ('starter', 'professional', 'enterprise');

-- ---------- exactly one active owner per business ----------
CREATE FUNCTION memberships_set_owner_flag() RETURNS trigger AS $$
BEGIN
  NEW.is_owner := EXISTS (SELECT 1 FROM roles WHERE id = NEW.role_id AND key = 'owner' AND business_id IS NULL);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER memberships_owner_flag
  BEFORE INSERT OR UPDATE OF role_id ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION memberships_set_owner_flag();

UPDATE "memberships" m SET is_owner = EXISTS (SELECT 1 FROM roles r WHERE r.id = m.role_id AND r.key = 'owner' AND r.business_id IS NULL);

-- Ownership changes only by deliberate transfer: the database refuses a second active owner.
CREATE UNIQUE INDEX memberships_one_active_owner_uniq ON "memberships" (business_id) WHERE is_owner AND status = 'ACTIVE';

-- ---------- custom roles: app may manage a business's own roles, never system roles ----------
GRANT INSERT, UPDATE, DELETE ON "roles", "role_permissions" TO tfme_app;

CREATE FUNCTION protect_system_roles() RETURNS trigger AS $$
BEGIN
  IF current_user = 'tfme_app' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.is_system THEN
      RAISE EXCEPTION 'system roles are managed by migrations only' USING ERRCODE = '42501';
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND (NEW.is_system OR NEW.business_id IS NULL) THEN
      RAISE EXCEPTION 'the application may only create business-owned custom roles' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER roles_protect_system BEFORE INSERT OR UPDATE OR DELETE ON "roles"
  FOR EACH ROW EXECUTE FUNCTION protect_system_roles();

CREATE FUNCTION protect_system_role_permissions() RETURNS trigger AS $$
DECLARE target uuid; sys boolean;
BEGIN
  IF current_user = 'tfme_app' THEN
    target := COALESCE(NEW.role_id, OLD.role_id);
    SELECT (is_system OR business_id IS NULL) INTO sys FROM roles WHERE id = target;
    IF sys THEN
      RAISE EXCEPTION 'system role permissions are managed by migrations only' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER role_permissions_protect_system BEFORE INSERT OR UPDATE OR DELETE ON "role_permissions"
  FOR EACH ROW EXECUTE FUNCTION protect_system_role_permissions();

-- Pricing, entitlements, platform tunables and platform-admin membership are owner/platform-managed.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "plan_features", "platform_settings", "platform_admins" FROM tfme_app;

-- ---------- constraints ----------
ALTER TABLE "businesses"
  ADD CONSTRAINT businesses_closed_has_timestamp CHECK (status <> 'CLOSED' OR closed_at IS NOT NULL);
ALTER TABLE "subscriptions"
  ADD CONSTRAINT subscriptions_overrides_positive CHECK (
    (override_max_members IS NULL OR override_max_members >= 1) AND
    (override_max_locations IS NULL OR override_max_locations >= 1) AND
    (override_max_storage_mb IS NULL OR override_max_storage_mb >= 0));
ALTER TABLE "subscription_invoices"
  ADD CONSTRAINT subscription_invoices_totals CHECK (subtotal_cents >= 0 AND vat_cents >= 0 AND total_cents = subtotal_cents + vat_cents);
ALTER TABLE "users" ADD CONSTRAINT users_mfa_secret_when_enabled CHECK (NOT mfa_enabled OR mfa_secret_enc IS NOT NULL);

-- Gapless-enough, platform-wide subscription invoice numbers.
CREATE SEQUENCE subscription_invoice_seq START 1;
GRANT USAGE ON SEQUENCE subscription_invoice_seq TO tfme_app;

-- ---------- row-level security ----------
CREATE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app_current_user() TO tfme_app;

ALTER TABLE "data_exports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_exports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "data_exports"
  USING (business_id = app_current_business())
  WITH CHECK (business_id = app_current_business());

ALTER TABLE "subscription_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription_invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "subscription_invoices"
  USING (business_id = app_current_business())
  WITH CHECK (business_id = app_current_business());

-- A person can read their own account-level security events (login, MFA, password...), which
-- have no business. Business-scoped rows remain visible only inside that business.
CREATE POLICY audit_select_own_account ON "audit_logs" FOR SELECT
  USING (business_id IS NULL AND user_id = app_current_user());
