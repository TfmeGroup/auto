-- CreateEnum
CREATE TYPE "document_visibility" AS ENUM ('INTERNAL', 'CUSTOMER', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "file_source" AS ENUM ('UPLOAD', 'GENERATED');

-- CreateEnum
CREATE TYPE "scan_status" AS ENUM ('NOT_SCANNED', 'PENDING', 'CLEAN', 'FLAGGED');

-- CreateEnum
CREATE TYPE "generation_status" AS ENUM ('QUEUED', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "comm_channel" AS ENUM ('EMAIL', 'SMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "comm_status" AS ENUM ('QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'VIEWED', 'FAILED', 'CANCELLED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "consent_status" AS ENUM ('GRANTED', 'WITHDRAWN');



-- AlterTable
ALTER TABLE "files" ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(3),
ADD COLUMN     "description" TEXT,
ADD COLUMN     "display_name" TEXT,
ADD COLUMN     "extension" TEXT,
ADD COLUMN     "generated_kind" TEXT,
ADD COLUMN     "generated_ref" TEXT,
ADD COLUMN     "is_current" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "is_financial" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "location_id" UUID,
ADD COLUMN     "retain_until" TIMESTAMPTZ(3),
ADD COLUMN     "scan_status" "scan_status" NOT NULL DEFAULT 'NOT_SCANNED',
ADD COLUMN     "scanned_at" TIMESTAMPTZ(3),
ADD COLUMN     "source" "file_source" NOT NULL DEFAULT 'UPLOAD',
ADD COLUMN     "thumbnail_key" TEXT,
ADD COLUMN     "trashed_at" TIMESTAMPTZ(3),
ADD COLUMN     "trashed_by_id" UUID,
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "version_group_id" UUID,
ADD COLUMN     "visibility" "document_visibility" NOT NULL DEFAULT 'INTERNAL';

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "entity_id" UUID,
ADD COLUMN     "entity_type" TEXT,
ADD COLUMN     "group_count" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "group_key" TEXT,
ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'NORMAL';

-- CreateTable
CREATE TABLE "document_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_settings" (
    "business_id" UUID NOT NULL,
    "trash_retention_days" INTEGER NOT NULL DEFAULT 30,
    "financial_retention_years" INTEGER NOT NULL DEFAULT 5,
    "max_upload_mb" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_settings_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "document_generations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "status" "generation_status" NOT NULL DEFAULT 'QUEUED',
    "file_id" UUID,
    "requested_by_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "document_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "customer_id" UUID,
    "channel" "comm_channel" NOT NULL,
    "event" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "transactional" BOOLEAN NOT NULL DEFAULT true,
    "recipient" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "location_id" UUID,
    "status" "comm_status" NOT NULL DEFAULT 'QUEUED',
    "status_detail" TEXT,
    "provider" TEXT,
    "provider_ref" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "template_key" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL DEFAULT 1,
    "dedupe_key" TEXT NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "viewed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "channel" "comm_channel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_settings" (
    "business_id" UUID NOT NULL,
    "sender_name" TEXT,
    "reply_to" TEXT,
    "signature" TEXT,
    "sms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "job_update_events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "booking_reminder_hours" INTEGER NOT NULL DEFAULT 24,
    "service_reminder_days" INTEGER NOT NULL DEFAULT 14,
    "service_reminder_km" INTEGER NOT NULL DEFAULT 1000,
    "service_reminders_on" BOOLEAN NOT NULL DEFAULT false,
    "booking_reminders_on" BOOLEAN NOT NULL DEFAULT true,
    "max_per_hour" INTEGER NOT NULL DEFAULT 300,
    "internal_rules" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "communication_settings_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "customer_comm_preferences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "preferred_channel" "comm_channel",
    "booking_reminders" BOOLEAN NOT NULL DEFAULT true,
    "job_updates" BOOLEAN NOT NULL DEFAULT true,
    "payment_reminders" BOOLEAN NOT NULL DEFAULT true,
    "service_reminders" BOOLEAN NOT NULL DEFAULT true,
    "sms_ok" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_ok" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_comm_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "consent_type" TEXT NOT NULL,
    "status" "consent_status" NOT NULL,
    "source" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "changed_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_reminder_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "interval_id" UUID NOT NULL,
    "customer_id" UUID,
    "due_key" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "communication_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_reminder_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_categories_business_id_key_key" ON "document_categories"("business_id", "key");

-- CreateIndex
CREATE INDEX "document_generations_business_id_kind_entity_id_idx" ON "document_generations"("business_id", "kind", "entity_id");

-- CreateIndex
CREATE INDEX "document_generations_business_id_status_created_at_idx" ON "document_generations"("business_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "document_generations_business_id_dedupe_key_key" ON "document_generations"("business_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "communications_business_id_created_at_idx" ON "communications"("business_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "communications_business_id_customer_id_created_at_idx" ON "communications"("business_id", "customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "communications_business_id_entity_type_entity_id_idx" ON "communications"("business_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "communications_business_id_status_created_at_idx" ON "communications"("business_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "communications_business_id_channel_event_idx" ON "communications"("business_id", "channel", "event");

-- CreateIndex
CREATE INDEX "communications_business_id_recipient_idx" ON "communications"("business_id", "recipient");

-- CreateIndex
CREATE INDEX "communications_channel_provider_ref_idx" ON "communications"("channel", "provider_ref");

-- CreateIndex
CREATE UNIQUE INDEX "communications_business_id_dedupe_key_key" ON "communications"("business_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_business_id_event_channel_key" ON "message_templates"("business_id", "event", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "customer_comm_preferences_business_id_customer_id_key" ON "customer_comm_preferences"("business_id", "customer_id");

-- CreateIndex
CREATE INDEX "consent_records_business_id_customer_id_consent_type_create_idx" ON "consent_records"("business_id", "customer_id", "consent_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "service_reminder_log_business_id_vehicle_id_created_at_idx" ON "service_reminder_log"("business_id", "vehicle_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "service_reminder_log_interval_id_due_key_key" ON "service_reminder_log"("interval_id", "due_key");

-- CreateIndex
CREATE INDEX "files_business_id_status_category_idx" ON "files"("business_id", "status", "category");

-- CreateIndex
CREATE INDEX "files_business_id_customer_id_created_at_idx" ON "files"("business_id", "customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "files_business_id_uploaded_by_id_created_at_idx" ON "files"("business_id", "uploaded_by_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "files_business_id_visibility_idx" ON "files"("business_id", "visibility");

-- CreateIndex
CREATE INDEX "files_business_id_version_group_id_version_idx" ON "files"("business_id", "version_group_id", "version");

-- CreateIndex
CREATE INDEX "notifications_business_id_user_id_group_key_idx" ON "notifications"("business_id", "user_id", "group_key");


-- ═════════════ Part 6 hand layer: integrity, triggers, row-level security, backfill ═════════════

-- ───────── Foreign keys (all composite with business_id so a record can never point at another tenant) ─────────
ALTER TABLE document_categories ADD CONSTRAINT document_categories_business_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE document_settings ADD CONSTRAINT document_settings_business_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE document_generations ADD CONSTRAINT document_generations_business_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE document_generations ADD CONSTRAINT document_generations_file_fkey FOREIGN KEY (file_id, business_id) REFERENCES files(id, business_id) ON DELETE RESTRICT;
ALTER TABLE communications ADD CONSTRAINT communications_business_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE communications ADD CONSTRAINT communications_customer_fkey FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id) ON DELETE RESTRICT;
ALTER TABLE communications ADD CONSTRAINT communications_location_fkey FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE message_templates ADD CONSTRAINT message_templates_business_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE communication_settings ADD CONSTRAINT communication_settings_business_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE customer_comm_preferences ADD CONSTRAINT customer_comm_preferences_customer_fkey FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id) ON DELETE RESTRICT;
ALTER TABLE consent_records ADD CONSTRAINT consent_records_customer_fkey FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id) ON DELETE RESTRICT;
ALTER TABLE service_reminder_log ADD CONSTRAINT service_reminder_log_vehicle_fkey FOREIGN KEY (vehicle_id, business_id) REFERENCES vehicles(id, business_id) ON DELETE RESTRICT;
ALTER TABLE service_reminder_log ADD CONSTRAINT service_reminder_log_interval_fkey FOREIGN KEY (interval_id) REFERENCES service_intervals(id) ON DELETE RESTRICT;
ALTER TABLE files ADD CONSTRAINT files_location_fkey FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE files ADD CONSTRAINT files_customer_fkey FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id) ON DELETE RESTRICT;

-- ───────── Checks ─────────
ALTER TABLE files ADD CONSTRAINT files_version_chk CHECK (version >= 1);
ALTER TABLE files ADD CONSTRAINT files_category_chk CHECK (length(category) BETWEEN 1 AND 60);
ALTER TABLE files ADD CONSTRAINT files_generated_chk CHECK ((source = 'GENERATED') = (generated_kind IS NOT NULL));
ALTER TABLE files ADD CONSTRAINT files_trashed_chk CHECK ((status = 'TRASHED') = (trashed_at IS NOT NULL) OR status = 'DELETED');
ALTER TABLE document_settings ADD CONSTRAINT document_settings_chk CHECK (trash_retention_days BETWEEN 1 AND 3650 AND financial_retention_years BETWEEN 1 AND 50 AND (max_upload_mb IS NULL OR max_upload_mb BETWEEN 1 AND 100));
ALTER TABLE communication_settings ADD CONSTRAINT communication_settings_chk CHECK (booking_reminder_hours BETWEEN 1 AND 336 AND service_reminder_days BETWEEN 0 AND 120 AND service_reminder_km BETWEEN 0 AND 20000 AND max_per_hour BETWEEN 1 AND 100000);
ALTER TABLE communications ADD CONSTRAINT communications_attempts_chk CHECK (attempts >= 0);
ALTER TABLE notifications ADD CONSTRAINT notifications_priority_chk CHECK (priority IN ('LOW', 'NORMAL', 'HIGH'));
ALTER TABLE notifications ADD CONSTRAINT notifications_group_chk CHECK (group_count >= 1);

-- Versions of one document are numbered once, and only one of them is current.
CREATE UNIQUE INDEX files_version_unique ON files (business_id, version_group_id, version) WHERE version_group_id IS NOT NULL;
CREATE INDEX files_generated_idx ON files (business_id, resource_type, resource_id, generated_kind, generated_ref) WHERE source = 'GENERATED';
-- The first stored copy of a generated document is made once, even if two requests race to make it.
CREATE UNIQUE INDEX files_generated_first ON files (business_id, resource_type, resource_id, generated_kind, coalesce(generated_ref, '')) WHERE source = 'GENERATED' AND version = 1;
CREATE UNIQUE INDEX files_one_current ON files (business_id, version_group_id) WHERE version_group_id IS NOT NULL AND is_current;
-- Search by name, and the trash / retention scans, stay quick on large libraries.
CREATE INDEX files_name_trgm ON files USING gin (lower(coalesce(display_name, original_name)) gin_trgm_ops);
CREATE INDEX files_trashed_idx ON files (business_id, trashed_at) WHERE trashed_at IS NOT NULL;
CREATE INDEX files_resource_status_idx ON files (business_id, resource_type, resource_id, status);
CREATE INDEX communications_queue_idx ON communications (business_id, queued_at) WHERE status IN ('QUEUED', 'PROCESSING');

-- ───────── Files: the stored object never changes; financial documents are never destroyed early ─────────
CREATE OR REPLACE FUNCTION files_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.storage_key <> OLD.storage_key OR NEW.sha256 <> OLD.sha256 OR NEW.size_bytes <> OLD.size_bytes
     OR NEW.mime_type <> OLD.mime_type OR NEW.business_id <> OLD.business_id OR NEW.source <> OLD.source
     OR NEW.version <> OLD.version OR NEW.generated_kind IS DISTINCT FROM OLD.generated_kind THEN
    RAISE EXCEPTION 'A stored file never changes; upload a new version instead' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'DELETED' AND NEW.status <> 'DELETED' THEN
    RAISE EXCEPTION 'A permanently deleted file cannot be restored' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'DELETED' AND OLD.status <> 'DELETED' THEN
    IF OLD.status <> 'TRASHED' THEN
      RAISE EXCEPTION 'A file must be in the trash before it can be permanently deleted' USING ERRCODE = '42501';
    END IF;
    IF OLD.is_financial AND (OLD.retain_until IS NULL OR OLD.retain_until > now()) THEN
      RAISE EXCEPTION 'This financial document is inside its retention period and cannot be permanently deleted' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.status = 'TRASHED' AND OLD.status <> 'TRASHED' AND OLD.is_financial THEN
    RAISE EXCEPTION 'Financial documents cannot be moved to the trash; archive them instead' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER files_guard_trg BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION files_guard();
CREATE TRIGGER files_no_delete BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ───────── Communications: content is fixed once written, and a sent message can never be "un-sent" and sent again ─────────
CREATE OR REPLACE FUNCTION communications_guard() RETURNS trigger AS $$
DECLARE
  o int; n int;
BEGIN
  IF NEW.business_id <> OLD.business_id OR NEW.channel <> OLD.channel OR NEW.recipient IS DISTINCT FROM OLD.recipient
     OR NEW.body <> OLD.body OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.dedupe_key <> OLD.dedupe_key
     OR NEW.event <> OLD.event OR NEW.entity_id IS DISTINCT FROM OLD.entity_id THEN
    RAISE EXCEPTION 'A recorded communication cannot be rewritten' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  o := CASE OLD.status WHEN 'QUEUED' THEN 0 WHEN 'PROCESSING' THEN 1 WHEN 'SENT' THEN 2 WHEN 'DELIVERED' THEN 3 WHEN 'VIEWED' THEN 4 ELSE 9 END;
  n := CASE NEW.status WHEN 'QUEUED' THEN 0 WHEN 'PROCESSING' THEN 1 WHEN 'SENT' THEN 2 WHEN 'DELIVERED' THEN 3 WHEN 'VIEWED' THEN 4 ELSE 9 END;
  -- Once handed to the provider the message only moves forward (or is reported undelivered by the provider).
  IF o BETWEEN 2 AND 4 AND NOT (n > o AND n <= 4) AND NOT (NEW.status = 'FAILED' AND OLD.status = 'SENT') THEN
    RAISE EXCEPTION 'A message that was sent cannot go back to % ', NEW.status USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('SKIPPED', 'CANCELLED') THEN
    RAISE EXCEPTION 'A % message is final', OLD.status USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'CANCELLED' AND OLD.status <> 'QUEUED' THEN
    RAISE EXCEPTION 'Only a queued message can be cancelled' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER communications_guard_trg BEFORE UPDATE ON communications FOR EACH ROW EXECUTE FUNCTION communications_guard();

CREATE TRIGGER communications_no_delete BEFORE DELETE ON communications FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER consent_records_append_only BEFORE UPDATE OR DELETE ON consent_records FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER service_reminder_log_append_only BEFORE UPDATE OR DELETE ON service_reminder_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER document_generations_no_delete BEFORE DELETE ON document_generations FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER message_templates_no_delete BEFORE DELETE ON message_templates FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ───────── Row-level security ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'document_categories','document_settings','document_generations','communications','message_templates',
    'communication_settings','customer_comm_preferences','consent_records','service_reminder_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (business_id = app_current_business())
      WITH CHECK (business_id = app_current_business())$p$, t);
  END LOOP;
END $$;

-- A provider's delivery report finds its message by the provider's own reference before any business is known. This policy lets
-- that one request see only the single row carrying the reference it presents (the reference is set transaction-locally).
CREATE POLICY comm_by_provider_ref ON communications FOR SELECT USING (provider_ref IS NOT NULL AND provider_ref = current_setting('app.provider_ref', true));

-- ───────── Backfill ─────────
INSERT INTO document_settings (business_id, updated_at) SELECT id, now() FROM businesses;
INSERT INTO communication_settings (business_id, updated_at) SELECT id, now() FROM businesses;

-- Existing files: carry over what Part 3 already knew about job photos, and the customer a file belongs to.
UPDATE files f SET visibility = CASE jp.visibility WHEN 'CUSTOMER' THEN 'CUSTOMER'::document_visibility ELSE 'INTERNAL'::document_visibility END,
  category = CASE
    WHEN jp.category::text LIKE 'CHECK_IN_%' THEN 'VEHICLE_PHOTO'
    WHEN jp.category::text = 'DIAGNOSTIC_EVIDENCE' THEN 'DIAGNOSTIC'
    WHEN jp.category::text = 'SIGNATURE' THEN 'JOB_DOCUMENT'
    ELSE 'VEHICLE_PHOTO' END
FROM job_photos jp WHERE jp.file_id = f.id AND jp.business_id = f.business_id;
UPDATE files SET category = 'CUSTOMER_DOCUMENT' WHERE resource_type = 'customer' AND category = 'OTHER';
UPDATE files SET category = 'SUPPLIER_DOCUMENT' WHERE resource_type = 'supplier' AND category = 'OTHER';
UPDATE files SET category = 'PURCHASE_ORDER' WHERE resource_type = 'purchase_order' AND category = 'OTHER';
UPDATE files SET category = 'EMPLOYEE_DOCUMENT' WHERE resource_type = 'employee' AND category = 'OTHER';
UPDATE files SET category = 'PART_DOCUMENT' WHERE resource_type = 'part' AND category = 'OTHER';
UPDATE files f SET customer_id = f.resource_id::uuid WHERE f.resource_type = 'customer' AND f.customer_id IS NULL;
UPDATE files f SET customer_id = j.customer_id FROM job_cards j WHERE f.resource_type = 'job' AND j.id = f.resource_id::uuid AND j.business_id = f.business_id;
UPDATE files f SET customer_id = v.customer_id FROM vehicles v WHERE f.resource_type = 'vehicle' AND v.id = f.resource_id::uuid AND v.business_id = f.business_id;
UPDATE files f SET extension = lower(substring(original_name from '\.([A-Za-z0-9]{1,8})$')) WHERE extension IS NULL;

-- Money messages that were logged by Part 4 move into the shared communication history. Their delivery outcome was
-- not tracked at the time, which the detail says plainly.
INSERT INTO communications (business_id, customer_id, channel, event, category, transactional, recipient, subject, body, entity_type, entity_id, status, status_detail, template_key, template_version, dedupe_key, queued_at, created_at)
SELECT business_id, customer_id, 'EMAIL', kind, 'FINANCIAL', true, recipient, NULL, '(The text of this message was not kept by the earlier system.)', entity_type, entity_id,
  CASE status WHEN 'QUEUED' THEN 'SENT'::comm_status WHEN 'SKIPPED' THEN 'SKIPPED'::comm_status ELSE 'FAILED'::comm_status END,
  coalesce(detail, CASE WHEN status = 'QUEUED' THEN 'Handed to the email queue (earlier record: the delivery outcome was not tracked)' END),
  template_key, template_version, dedupe_key, created_at, created_at
FROM finance_notifications;

-- Defence in depth: whatever the application does, a file can only be visible to customers if it sits on a kind of record a customer may see.
-- (Supplier, part, purchase order, employee, diagnostic and business files can never be shared.)
ALTER TABLE files ADD CONSTRAINT files_customer_visibility_chk CHECK (
  visibility <> 'CUSTOMER' OR resource_type IN ('customer', 'vehicle', 'job', 'inspection', 'booking', 'quote', 'invoice', 'receipt', 'credit_note', 'statement')
);
