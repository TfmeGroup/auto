-- CreateEnum
CREATE TYPE "quote_status" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'APPROVED', 'DECLINED', 'EXPIRED', 'CONVERTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'ISSUED', 'SENT', 'VIEWED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "invoice_payment_status" AS ENUM ('DRAFT', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "fin_line_type" AS ENUM ('PART', 'LABOUR', 'SERVICE', 'CHARGE', 'OTHER');

-- CreateEnum
CREATE TYPE "tax_treatment" AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT');

-- CreateEnum
CREATE TYPE "discount_type" AS ENUM ('NONE', 'PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CARD', 'EFT', 'CASH', 'ONLINE', 'OTHER');

-- CreateEnum
CREATE TYPE "payment_purpose" AS ENUM ('INVOICE', 'DEPOSIT');

-- CreateEnum
CREATE TYPE "credit_note_status" AS ENUM ('DRAFT', 'ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "credit_entry_kind" AS ENUM ('DEPOSIT', 'OVERPAYMENT', 'CREDIT_NOTE', 'APPLIED', 'REFUND');

-- CreateEnum
CREATE TYPE "doc_link_kind" AS ENUM ('QUOTE', 'INVOICE');

-- CreateEnum
CREATE TYPE "fin_notify_status" AS ENUM ('QUEUED', 'SKIPPED', 'FAILED');

-- AlterEnum
ALTER TYPE "approval_method" ADD VALUE 'ELECTRONIC';

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "doc_code" TEXT;

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "labour_cost_cents_per_hour" INTEGER;

-- CreateTable
CREATE TABLE "finance_settings" (
    "business_id" UUID NOT NULL,
    "quote_prefix" TEXT NOT NULL DEFAULT 'QUO',
    "invoice_prefix" TEXT NOT NULL DEFAULT 'INV',
    "payment_prefix" TEXT NOT NULL DEFAULT 'PAY',
    "receipt_prefix" TEXT NOT NULL DEFAULT 'RCT',
    "credit_note_prefix" TEXT NOT NULL DEFAULT 'CN',
    "refund_prefix" TEXT NOT NULL DEFAULT 'RFD',
    "number_padding" INTEGER NOT NULL DEFAULT 6,
    "quote_validity_days" INTEGER NOT NULL DEFAULT 14,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 14,
    "prices_include_vat" BOOLEAN NOT NULL DEFAULT false,
    "quote_terms" TEXT,
    "invoice_terms" TEXT,
    "invoice_footer" TEXT,
    "payment_instructions" TEXT,
    "enabled_methods" "payment_method"[],
    "deposits_enabled" BOOLEAN NOT NULL DEFAULT true,
    "reminders_enabled" BOOLEAN NOT NULL DEFAULT false,
    "reminder_offsets" INTEGER[],
    "reminder_repeat_days" INTEGER NOT NULL DEFAULT 0,
    "online_provider" TEXT,
    "online_credentials_enc" TEXT,
    "online_sandbox" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "job_id" UUID,
    "location_id" UUID,
    "status" "quote_status" NOT NULL DEFAULT 'DRAFT',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "approved_version" INTEGER,
    "internal_notes" TEXT,
    "changes_requested_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),
    "declined_at" TIMESTAMPTZ(3),
    "expired_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "job_converted_at" TIMESTAMPTZ(3),
    "invoiced_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "quote_date" DATE NOT NULL,
    "valid_until" DATE,
    "terms" TEXT,
    "customer_notes" TEXT,
    "change_note" TEXT,
    "vat_registered" BOOLEAN NOT NULL,
    "vat_rate_bps" INTEGER NOT NULL,
    "prices_include_vat" BOOLEAN NOT NULL,
    "discount_type" "discount_type" NOT NULL DEFAULT 'NONE',
    "discount_value" INTEGER NOT NULL DEFAULT 0,
    "subtotal_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "taxable_cents" INTEGER NOT NULL DEFAULT 0,
    "vat_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(3),
    "sent_by_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quote_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "line_type" "fin_line_type" NOT NULL,
    "description" TEXT NOT NULL,
    "sku" TEXT,
    "unit" TEXT,
    "quantity_milli" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "discount_type" "discount_type" NOT NULL DEFAULT 'NONE',
    "discount_value" INTEGER NOT NULL DEFAULT 0,
    "tax_treatment" "tax_treatment" NOT NULL DEFAULT 'STANDARD',
    "vat_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "base_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "taxable_cents" INTEGER NOT NULL DEFAULT 0,
    "vat_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "unit_cost_cents" INTEGER,
    "inventory_item_id" UUID,
    "job_part_id" UUID,
    "job_labour_id" UUID,
    "recommended_work_id" UUID,
    "technician_membership_id" UUID,
    "minutes" INTEGER,

    CONSTRAINT "quote_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "number" TEXT,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "job_id" UUID,
    "quote_id" UUID,
    "quote_version" INTEGER,
    "location_id" UUID,
    "status" "invoice_status" NOT NULL DEFAULT 'DRAFT',
    "payment_status" "invoice_payment_status" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT,
    "invoice_date" DATE,
    "due_date" DATE,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 0,
    "terms" TEXT,
    "customer_notes" TEXT,
    "internal_notes" TEXT,
    "vat_registered" BOOLEAN NOT NULL,
    "vat_rate_bps" INTEGER NOT NULL,
    "prices_include_vat" BOOLEAN NOT NULL,
    "discount_type" "discount_type" NOT NULL DEFAULT 'NONE',
    "discount_value" INTEGER NOT NULL DEFAULT 0,
    "subtotal_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "taxable_cents" INTEGER NOT NULL DEFAULT 0,
    "vat_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,
    "credit_applied_cents" INTEGER NOT NULL DEFAULT 0,
    "credit_noted_cents" INTEGER NOT NULL DEFAULT 0,
    "written_off_cents" INTEGER NOT NULL DEFAULT 0,
    "outstanding_cents" INTEGER NOT NULL DEFAULT 0,
    "business_snapshot" JSONB,
    "customer_snapshot" JSONB,
    "pdf_file_id" UUID,
    "finalised_at" TIMESTAMPTZ(3),
    "finalised_by_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "viewed_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "written_off_at" TIMESTAMPTZ(3),
    "write_off_reason" TEXT,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "line_type" "fin_line_type" NOT NULL,
    "description" TEXT NOT NULL,
    "sku" TEXT,
    "unit" TEXT,
    "quantity_milli" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "discount_type" "discount_type" NOT NULL DEFAULT 'NONE',
    "discount_value" INTEGER NOT NULL DEFAULT 0,
    "tax_treatment" "tax_treatment" NOT NULL DEFAULT 'STANDARD',
    "vat_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "base_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "taxable_cents" INTEGER NOT NULL DEFAULT 0,
    "vat_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "unit_cost_cents" INTEGER,
    "inventory_item_id" UUID,
    "job_part_id" UUID,
    "job_labour_id" UUID,
    "recommended_work_id" UUID,
    "quote_line_id" UUID,
    "technician_membership_id" UUID,
    "minutes" INTEGER,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "invoice_id" UUID,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "job_id" UUID,
    "quote_id" UUID,
    "purpose" "payment_purpose" NOT NULL DEFAULT 'INVOICE',
    "method" "payment_method" NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'COMPLETED',
    "amount_cents" INTEGER NOT NULL,
    "applied_cents" INTEGER NOT NULL DEFAULT 0,
    "credited_cents" INTEGER NOT NULL DEFAULT 0,
    "refunded_applied_cents" INTEGER NOT NULL DEFAULT 0,
    "refunded_credit_cents" INTEGER NOT NULL DEFAULT 0,
    "reference" TEXT,
    "provider" TEXT,
    "provider_reference" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "failure_reason" TEXT,
    "idempotency_key" TEXT,
    "recorded_by_id" UUID,
    "reconciled_at" TIMESTAMPTZ(3),
    "reconciled_by_id" UUID,
    "reconciliation_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID,
    "customer_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "from_invoice_cents" INTEGER NOT NULL,
    "from_credit_cents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "provider_reference" TEXT,
    "idempotency_key" TEXT,
    "refunded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID,
    "customer_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "method" "payment_method" NOT NULL,
    "reference" TEXT,
    "invoice_total_cents" INTEGER,
    "invoice_paid_cents" INTEGER,
    "remaining_cents" INTEGER,
    "file_id" UUID,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_credit_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "kind" "credit_entry_kind" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "invoice_id" UUID,
    "payment_id" UUID,
    "credit_note_id" UUID,
    "refund_id" UUID,
    "job_id" UUID,
    "quote_id" UUID,
    "note" TEXT,
    "idempotency_key" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "number" TEXT,
    "invoice_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "status" "credit_note_status" NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "vat_registered" BOOLEAN NOT NULL,
    "vat_rate_bps" INTEGER NOT NULL,
    "prices_include_vat" BOOLEAN NOT NULL,
    "subtotal_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "taxable_cents" INTEGER NOT NULL DEFAULT 0,
    "vat_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "applied_cents" INTEGER NOT NULL DEFAULT 0,
    "credited_cents" INTEGER NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMPTZ(3),
    "authorised_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "credit_note_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "line_type" "fin_line_type" NOT NULL,
    "description" TEXT NOT NULL,
    "sku" TEXT,
    "unit" TEXT,
    "quantity_milli" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "discount_type" "discount_type" NOT NULL DEFAULT 'NONE',
    "discount_value" INTEGER NOT NULL DEFAULT 0,
    "tax_treatment" "tax_treatment" NOT NULL DEFAULT 'STANDARD',
    "vat_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "base_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "taxable_cents" INTEGER NOT NULL DEFAULT 0,
    "vat_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "unit_cost_cents" INTEGER,

    CONSTRAINT "credit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "version" INTEGER,
    "type" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_user_id" UUID,
    "actor_name" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "kind" "doc_link_kind" NOT NULL,
    "document_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "last_viewed_at" TIMESTAMPTZ(3),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "customer_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "recipient" TEXT,
    "status" "fin_notify_status" NOT NULL DEFAULT 'QUEUED',
    "detail" TEXT,
    "template_key" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL DEFAULT 1,
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotes_business_id_status_created_at_idx" ON "quotes"("business_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "quotes_business_id_customer_id_idx" ON "quotes"("business_id", "customer_id");

-- CreateIndex
CREATE INDEX "quotes_business_id_vehicle_id_idx" ON "quotes"("business_id", "vehicle_id");

-- CreateIndex
CREATE INDEX "quotes_business_id_job_id_idx" ON "quotes"("business_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_id_business_id_key" ON "quotes"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_business_id_number_key" ON "quotes"("business_id", "number");

-- CreateIndex
CREATE INDEX "quote_versions_business_id_quote_id_idx" ON "quote_versions"("business_id", "quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_versions_id_business_id_key" ON "quote_versions"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_versions_quote_id_version_key" ON "quote_versions"("quote_id", "version");

-- CreateIndex
CREATE INDEX "quote_lines_business_id_version_id_position_idx" ON "quote_lines"("business_id", "version_id", "position");

-- CreateIndex
CREATE INDEX "invoices_business_id_status_due_date_idx" ON "invoices"("business_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "invoices_business_id_customer_id_idx" ON "invoices"("business_id", "customer_id");

-- CreateIndex
CREATE INDEX "invoices_business_id_vehicle_id_idx" ON "invoices"("business_id", "vehicle_id");

-- CreateIndex
CREATE INDEX "invoices_business_id_job_id_idx" ON "invoices"("business_id", "job_id");

-- CreateIndex
CREATE INDEX "invoices_business_id_invoice_date_idx" ON "invoices"("business_id", "invoice_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_id_business_id_key" ON "invoices"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_business_id_number_key" ON "invoices"("business_id", "number");

-- CreateIndex
CREATE INDEX "invoice_lines_business_id_invoice_id_position_idx" ON "invoice_lines"("business_id", "invoice_id", "position");

-- CreateIndex
CREATE INDEX "payments_business_id_status_paid_at_idx" ON "payments"("business_id", "status", "paid_at" DESC);

-- CreateIndex
CREATE INDEX "payments_business_id_invoice_id_idx" ON "payments"("business_id", "invoice_id");

-- CreateIndex
CREATE INDEX "payments_business_id_customer_id_idx" ON "payments"("business_id", "customer_id");

-- CreateIndex
CREATE INDEX "payments_business_id_reference_idx" ON "payments"("business_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "payments_id_business_id_key" ON "payments"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_business_id_number_key" ON "payments"("business_id", "number");

-- CreateIndex
CREATE INDEX "refunds_business_id_payment_id_idx" ON "refunds"("business_id", "payment_id");

-- CreateIndex
CREATE INDEX "refunds_business_id_customer_id_idx" ON "refunds"("business_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_id_business_id_key" ON "refunds"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_business_id_number_key" ON "refunds"("business_id", "number");

-- CreateIndex
CREATE INDEX "receipts_business_id_customer_id_issued_at_idx" ON "receipts"("business_id", "customer_id", "issued_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "receipts_payment_id_business_id_key" ON "receipts"("payment_id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_business_id_number_key" ON "receipts"("business_id", "number");

-- CreateIndex
CREATE INDEX "customer_credit_entries_business_id_customer_id_created_at_idx" ON "customer_credit_entries"("business_id", "customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "customer_credit_entries_business_id_invoice_id_idx" ON "customer_credit_entries"("business_id", "invoice_id");

-- CreateIndex
CREATE INDEX "credit_notes_business_id_invoice_id_idx" ON "credit_notes"("business_id", "invoice_id");

-- CreateIndex
CREATE INDEX "credit_notes_business_id_customer_id_idx" ON "credit_notes"("business_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_id_business_id_key" ON "credit_notes"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_business_id_number_key" ON "credit_notes"("business_id", "number");

-- CreateIndex
CREATE INDEX "credit_note_lines_business_id_credit_note_id_position_idx" ON "credit_note_lines"("business_id", "credit_note_id", "position");

-- CreateIndex
CREATE INDEX "finance_events_business_id_entity_type_entity_id_created_at_idx" ON "finance_events"("business_id", "entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_links_token_hash_key" ON "document_links"("token_hash");

-- CreateIndex
CREATE INDEX "document_links_business_id_kind_document_id_idx" ON "document_links"("business_id", "kind", "document_id");

-- CreateIndex
CREATE INDEX "finance_notifications_business_id_entity_type_entity_id_idx" ON "finance_notifications"("business_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_notifications_business_id_dedupe_key_key" ON "finance_notifications"("business_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_business_id_fkey" FOREIGN KEY ("customer_id", "business_id") REFERENCES "customers"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_vehicle_id_business_id_fkey" FOREIGN KEY ("vehicle_id", "business_id") REFERENCES "vehicles"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_job_id_business_id_fkey" FOREIGN KEY ("job_id", "business_id") REFERENCES "job_cards"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_quote_id_business_id_fkey" FOREIGN KEY ("quote_id", "business_id") REFERENCES "quotes"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_version_id_business_id_fkey" FOREIGN KEY ("version_id", "business_id") REFERENCES "quote_versions"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_business_id_fkey" FOREIGN KEY ("customer_id", "business_id") REFERENCES "customers"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vehicle_id_business_id_fkey" FOREIGN KEY ("vehicle_id", "business_id") REFERENCES "vehicles"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_job_id_business_id_fkey" FOREIGN KEY ("job_id", "business_id") REFERENCES "job_cards"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quote_id_business_id_fkey" FOREIGN KEY ("quote_id", "business_id") REFERENCES "quotes"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_business_id_fkey" FOREIGN KEY ("invoice_id", "business_id") REFERENCES "invoices"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_business_id_fkey" FOREIGN KEY ("customer_id", "business_id") REFERENCES "customers"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_business_id_fkey" FOREIGN KEY ("invoice_id", "business_id") REFERENCES "invoices"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_business_id_fkey" FOREIGN KEY ("payment_id", "business_id") REFERENCES "payments"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payment_id_business_id_fkey" FOREIGN KEY ("payment_id", "business_id") REFERENCES "payments"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_customer_id_business_id_fkey" FOREIGN KEY ("customer_id", "business_id") REFERENCES "customers"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_id_business_id_fkey" FOREIGN KEY ("customer_id", "business_id") REFERENCES "customers"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_business_id_fkey" FOREIGN KEY ("invoice_id", "business_id") REFERENCES "invoices"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_business_id_fkey" FOREIGN KEY ("credit_note_id", "business_id") REFERENCES "credit_notes"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ═════════════════════ Part 4 integrity layer (hand-written) ═════════════════════

-- ───────── Extra composite foreign keys: a document can never point at another business's record ─────────
ALTER TABLE quotes ADD CONSTRAINT quotes_location_fk FOREIGN KEY (location_id, business_id) REFERENCES locations (id, business_id) ON DELETE RESTRICT;
ALTER TABLE invoices ADD CONSTRAINT invoices_location_fk FOREIGN KEY (location_id, business_id) REFERENCES locations (id, business_id) ON DELETE RESTRICT;
ALTER TABLE payments ADD CONSTRAINT payments_vehicle_fk FOREIGN KEY (vehicle_id, business_id) REFERENCES vehicles (id, business_id) ON DELETE RESTRICT;
ALTER TABLE payments ADD CONSTRAINT payments_job_fk FOREIGN KEY (job_id, business_id) REFERENCES job_cards (id, business_id) ON DELETE RESTRICT;
ALTER TABLE payments ADD CONSTRAINT payments_quote_fk FOREIGN KEY (quote_id, business_id) REFERENCES quotes (id, business_id) ON DELETE RESTRICT;
ALTER TABLE refunds ADD CONSTRAINT refunds_invoice_fk FOREIGN KEY (invoice_id, business_id) REFERENCES invoices (id, business_id) ON DELETE RESTRICT;
ALTER TABLE refunds ADD CONSTRAINT refunds_customer_fk FOREIGN KEY (customer_id, business_id) REFERENCES customers (id, business_id) ON DELETE RESTRICT;
ALTER TABLE receipts ADD CONSTRAINT receipts_invoice_fk FOREIGN KEY (invoice_id, business_id) REFERENCES invoices (id, business_id) ON DELETE RESTRICT;
ALTER TABLE receipts ADD CONSTRAINT receipts_customer_fk FOREIGN KEY (customer_id, business_id) REFERENCES customers (id, business_id) ON DELETE RESTRICT;
ALTER TABLE receipts ADD CONSTRAINT receipts_file_fk FOREIGN KEY (file_id, business_id) REFERENCES files (id, business_id) ON DELETE RESTRICT;
ALTER TABLE invoices ADD CONSTRAINT invoices_pdf_file_fk FOREIGN KEY (pdf_file_id, business_id) REFERENCES files (id, business_id) ON DELETE RESTRICT;
ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_vehicle_fk FOREIGN KEY (vehicle_id, business_id) REFERENCES vehicles (id, business_id) ON DELETE RESTRICT;
ALTER TABLE customer_credit_entries ADD CONSTRAINT credit_entries_invoice_fk FOREIGN KEY (invoice_id, business_id) REFERENCES invoices (id, business_id) ON DELETE RESTRICT;
ALTER TABLE customer_credit_entries ADD CONSTRAINT credit_entries_payment_fk FOREIGN KEY (payment_id, business_id) REFERENCES payments (id, business_id) ON DELETE RESTRICT;
ALTER TABLE customer_credit_entries ADD CONSTRAINT credit_entries_credit_note_fk FOREIGN KEY (credit_note_id, business_id) REFERENCES credit_notes (id, business_id) ON DELETE RESTRICT;
ALTER TABLE customer_credit_entries ADD CONSTRAINT credit_entries_refund_fk FOREIGN KEY (refund_id, business_id) REFERENCES refunds (id, business_id) ON DELETE RESTRICT;
ALTER TABLE finance_notifications ADD CONSTRAINT finance_notifications_business_fk FOREIGN KEY (business_id) REFERENCES businesses (id) ON DELETE RESTRICT;
ALTER TABLE finance_events ADD CONSTRAINT finance_events_business_fk FOREIGN KEY (business_id) REFERENCES businesses (id) ON DELETE RESTRICT;
ALTER TABLE document_links ADD CONSTRAINT document_links_business_fk FOREIGN KEY (business_id) REFERENCES businesses (id) ON DELETE RESTRICT;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_work_fk FOREIGN KEY (recommended_work_id, business_id) REFERENCES recommended_work_items (id, business_id) ON DELETE RESTRICT;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_work_fk FOREIGN KEY (recommended_work_id, business_id) REFERENCES recommended_work_items (id, business_id) ON DELETE RESTRICT;

-- ───────── Value rules the application also enforces ─────────
ALTER TABLE finance_settings ADD CONSTRAINT finance_settings_chk CHECK (
  number_padding BETWEEN 3 AND 9 AND quote_validity_days BETWEEN 1 AND 365 AND payment_terms_days BETWEEN 0 AND 365
  AND reminder_repeat_days BETWEEN 0 AND 365 AND quote_prefix ~ '^[A-Z0-9]{1,8}$' AND invoice_prefix ~ '^[A-Z0-9]{1,8}$'
  AND payment_prefix ~ '^[A-Z0-9]{1,8}$' AND receipt_prefix ~ '^[A-Z0-9]{1,8}$' AND credit_note_prefix ~ '^[A-Z0-9]{1,8}$' AND refund_prefix ~ '^[A-Z0-9]{1,8}$');
ALTER TABLE locations ADD CONSTRAINT locations_doc_code_chk CHECK (doc_code IS NULL OR doc_code ~ '^[A-Z0-9]{1,6}$');
ALTER TABLE memberships ADD CONSTRAINT memberships_labour_cost_chk CHECK (labour_cost_cents_per_hour IS NULL OR labour_cost_cents_per_hour BETWEEN 0 AND 10000000);

ALTER TABLE quote_versions ADD CONSTRAINT quote_versions_chk CHECK (
  version >= 1 AND vat_rate_bps BETWEEN 0 AND 10000 AND subtotal_cents >= 0 AND discount_cents >= 0 AND taxable_cents >= 0 AND vat_cents >= 0 AND total_cents >= 0
  AND taxable_cents = subtotal_cents - discount_cents AND total_cents = taxable_cents + vat_cents AND discount_value >= 0);
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_chk CHECK (
  quantity_milli > 0 AND unit_price_cents >= 0 AND discount_value >= 0 AND vat_rate_bps BETWEEN 0 AND 10000 AND base_cents >= 0 AND discount_cents >= 0
  AND taxable_cents >= 0 AND vat_cents >= 0 AND total_cents >= 0 AND (unit_cost_cents IS NULL OR unit_cost_cents >= 0)
  AND taxable_cents = base_cents - discount_cents AND total_cents = taxable_cents + vat_cents);
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_chk CHECK (
  quantity_milli > 0 AND unit_price_cents >= 0 AND discount_value >= 0 AND vat_rate_bps BETWEEN 0 AND 10000 AND base_cents >= 0 AND discount_cents >= 0
  AND taxable_cents >= 0 AND vat_cents >= 0 AND total_cents >= 0 AND (unit_cost_cents IS NULL OR unit_cost_cents >= 0)
  AND taxable_cents = base_cents - discount_cents AND total_cents = taxable_cents + vat_cents);
ALTER TABLE credit_note_lines ADD CONSTRAINT credit_note_lines_chk CHECK (
  quantity_milli > 0 AND unit_price_cents >= 0 AND discount_value >= 0 AND vat_rate_bps BETWEEN 0 AND 10000 AND base_cents >= 0 AND discount_cents >= 0
  AND taxable_cents >= 0 AND vat_cents >= 0 AND total_cents >= 0 AND taxable_cents = base_cents - discount_cents AND total_cents = taxable_cents + vat_cents);

-- An invoice's balance is always exactly what its payments, credits, credit notes and write-off leave: the
-- cached columns can be recomputed from the rows but can never drift into an impossible state.
ALTER TABLE invoices ADD CONSTRAINT invoices_chk CHECK (
  vat_rate_bps BETWEEN 0 AND 10000 AND subtotal_cents >= 0 AND discount_cents >= 0 AND taxable_cents >= 0 AND vat_cents >= 0 AND total_cents >= 0
  AND taxable_cents = subtotal_cents - discount_cents AND total_cents = taxable_cents + vat_cents
  AND paid_cents >= 0 AND credit_applied_cents >= 0 AND credit_noted_cents >= 0 AND written_off_cents >= 0 AND outstanding_cents >= 0
  AND outstanding_cents = total_cents - paid_cents - credit_applied_cents - credit_noted_cents - written_off_cents
  AND (status <> 'PAID' OR outstanding_cents = 0)
  AND (status <> 'DRAFT' OR (finalised_at IS NULL AND number IS NULL))
  AND (status = 'DRAFT' OR status = 'CANCELLED' OR (finalised_at IS NOT NULL AND number IS NOT NULL AND invoice_date IS NOT NULL AND due_date IS NOT NULL))
  AND (due_date IS NULL OR invoice_date IS NULL OR due_date >= invoice_date));
ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_chk CHECK (
  vat_rate_bps BETWEEN 0 AND 10000 AND subtotal_cents >= 0 AND discount_cents >= 0 AND taxable_cents >= 0 AND vat_cents >= 0 AND total_cents >= 0
  AND taxable_cents = subtotal_cents - discount_cents AND total_cents = taxable_cents + vat_cents
  AND applied_cents >= 0 AND credited_cents >= 0 AND (status <> 'ISSUED' OR (number IS NOT NULL AND issued_at IS NOT NULL AND applied_cents + credited_cents = total_cents)));

ALTER TABLE payments ADD CONSTRAINT payments_chk CHECK (
  amount_cents > 0 AND applied_cents >= 0 AND credited_cents >= 0 AND refunded_applied_cents >= 0 AND refunded_credit_cents >= 0
  AND refunded_applied_cents <= applied_cents AND refunded_credit_cents <= credited_cents
  AND (status NOT IN ('COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED') OR applied_cents + credited_cents = amount_cents)
  AND (status IN ('COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED') OR (applied_cents = 0 AND credited_cents = 0))
  AND (applied_cents = 0 OR invoice_id IS NOT NULL)
  AND (purpose <> 'DEPOSIT' OR invoice_id IS NULL)
  AND (purpose <> 'INVOICE' OR invoice_id IS NOT NULL));
ALTER TABLE refunds ADD CONSTRAINT refunds_chk CHECK (amount_cents > 0 AND from_invoice_cents >= 0 AND from_credit_cents >= 0 AND from_invoice_cents + from_credit_cents = amount_cents);
ALTER TABLE receipts ADD CONSTRAINT receipts_chk CHECK (amount_cents > 0);
ALTER TABLE customer_credit_entries ADD CONSTRAINT credit_entries_chk CHECK (
  amount_cents <> 0 AND ((kind IN ('DEPOSIT', 'OVERPAYMENT', 'CREDIT_NOTE') AND amount_cents > 0) OR (kind IN ('APPLIED', 'REFUND') AND amount_cents < 0)));
ALTER TABLE document_links ADD CONSTRAINT document_links_chk CHECK (expires_at > created_at);

-- ───────── Uniqueness that stops accidents (double clicks, replays, two people at once) ─────────
CREATE UNIQUE INDEX invoices_one_live_per_quote ON invoices (business_id, quote_id) WHERE quote_id IS NOT NULL AND status <> 'CANCELLED';
CREATE UNIQUE INDEX invoices_one_live_per_job ON invoices (business_id, job_id) WHERE job_id IS NOT NULL AND status <> 'CANCELLED';
CREATE UNIQUE INDEX payments_idempotency ON payments (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX payments_provider_ref ON payments (business_id, provider, provider_reference) WHERE provider_reference IS NOT NULL;
CREATE UNIQUE INDEX refunds_idempotency ON refunds (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX credit_entries_idempotency ON customer_credit_entries (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- A customer decides on a given version of a quote exactly once (approve OR decline).
CREATE UNIQUE INDEX finance_events_quote_decision ON finance_events (entity_id, version) WHERE type IN ('quote.approved', 'quote.declined');

-- ───────── Search & list indexes ─────────
CREATE INDEX quotes_number_trgm ON quotes USING gin (number gin_trgm_ops);
CREATE INDEX invoices_number_trgm ON invoices USING gin (number gin_trgm_ops);
CREATE INDEX payments_number_trgm ON payments USING gin (number gin_trgm_ops);
CREATE INDEX payments_reference_trgm ON payments USING gin (reference gin_trgm_ops);
CREATE INDEX receipts_number_trgm ON receipts USING gin (number gin_trgm_ops);
CREATE INDEX credit_notes_number_trgm ON credit_notes USING gin (number gin_trgm_ops);
CREATE INDEX invoices_open_idx ON invoices (business_id, due_date) WHERE outstanding_cents > 0 AND status NOT IN ('DRAFT', 'CANCELLED', 'WRITTEN_OFF', 'PAID');
CREATE INDEX quotes_expiry_idx ON quotes (business_id, status) WHERE status IN ('SENT', 'VIEWED');
CREATE INDEX payments_paid_at_idx ON payments (business_id, paid_at DESC) WHERE status IN ('COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED');
CREATE INDEX credit_notes_issued_idx ON credit_notes (business_id, issued_at DESC) WHERE status = 'ISSUED';

-- ───────── History is never edited or deleted ─────────
CREATE TRIGGER finance_events_append_only BEFORE UPDATE OR DELETE ON finance_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER customer_credit_entries_append_only BEFORE UPDATE OR DELETE ON customer_credit_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER refunds_append_only BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted; cancel or correct them instead', TG_TABLE_NAME USING ERRCODE = '42501';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER quotes_no_delete BEFORE DELETE ON quotes FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER quote_versions_no_delete BEFORE DELETE ON quote_versions FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER credit_notes_no_delete BEFORE DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- A sent quote version is frozen: the customer's copy can never be rewritten, only superseded by a new version.
CREATE OR REPLACE FUNCTION quote_version_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.sent_at IS NOT NULL THEN
    RAISE EXCEPTION 'a quote version that has been sent cannot be changed; create a new version' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER quote_versions_frozen BEFORE UPDATE ON quote_versions FOR EACH ROW EXECUTE FUNCTION quote_version_frozen();

CREATE OR REPLACE FUNCTION quote_lines_frozen() RETURNS trigger AS $$
DECLARE v uuid; sent timestamptz;
BEGIN
  v := CASE WHEN TG_OP = 'INSERT' THEN NEW.version_id ELSE OLD.version_id END;
  SELECT sent_at INTO sent FROM quote_versions WHERE id = v;
  IF sent IS NOT NULL THEN
    RAISE EXCEPTION 'the lines of a quote version that has been sent cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER quote_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON quote_lines FOR EACH ROW EXECUTE FUNCTION quote_lines_frozen();

-- A finalised invoice keeps its numbers, parties, dates, tax facts and totals for ever. Only its settlement
-- state (payments, status, delivery timestamps, cancellation, write-off, PDF) can change.
CREATE OR REPLACE FUNCTION invoice_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.finalised_at IS NOT NULL AND (
       NEW.finalised_at IS DISTINCT FROM OLD.finalised_at OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.customer_id <> OLD.customer_id OR NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.quote_id IS DISTINCT FROM OLD.quote_id OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date OR NEW.due_date IS DISTINCT FROM OLD.due_date
    OR NEW.title IS DISTINCT FROM OLD.title OR NEW.terms IS DISTINCT FROM OLD.terms OR NEW.customer_notes IS DISTINCT FROM OLD.customer_notes
    OR NEW.vat_registered <> OLD.vat_registered OR NEW.vat_rate_bps <> OLD.vat_rate_bps OR NEW.prices_include_vat <> OLD.prices_include_vat
    OR NEW.discount_type <> OLD.discount_type OR NEW.discount_value <> OLD.discount_value
    OR NEW.subtotal_cents <> OLD.subtotal_cents OR NEW.discount_cents <> OLD.discount_cents OR NEW.taxable_cents <> OLD.taxable_cents
    OR NEW.vat_cents <> OLD.vat_cents OR NEW.total_cents <> OLD.total_cents
    OR NEW.business_snapshot IS DISTINCT FROM OLD.business_snapshot OR NEW.customer_snapshot IS DISTINCT FROM OLD.customer_snapshot) THEN
    RAISE EXCEPTION 'an issued invoice cannot be changed; issue a credit note instead' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER invoices_frozen BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_frozen();

CREATE OR REPLACE FUNCTION invoice_lines_frozen() RETURNS trigger AS $$
DECLARE inv uuid; fin timestamptz;
BEGIN
  inv := CASE WHEN TG_OP = 'INSERT' THEN NEW.invoice_id ELSE OLD.invoice_id END;
  SELECT finalised_at INTO fin FROM invoices WHERE id = inv;
  IF fin IS NOT NULL THEN
    RAISE EXCEPTION 'the lines of an issued invoice cannot be changed; issue a credit note instead' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION invoice_lines_frozen();

CREATE OR REPLACE FUNCTION credit_notes_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (
       NEW.number IS DISTINCT FROM OLD.number OR NEW.invoice_id <> OLD.invoice_id OR NEW.customer_id <> OLD.customer_id
    OR NEW.reason <> OLD.reason OR NEW.total_cents <> OLD.total_cents OR NEW.vat_cents <> OLD.vat_cents OR NEW.subtotal_cents <> OLD.subtotal_cents
    OR NEW.applied_cents <> OLD.applied_cents OR NEW.credited_cents <> OLD.credited_cents OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR (OLD.status = 'ISSUED' AND NEW.status <> 'ISSUED') OR (OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED')) THEN
    RAISE EXCEPTION 'an issued credit note cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER credit_notes_frozen BEFORE UPDATE ON credit_notes FOR EACH ROW EXECUTE FUNCTION credit_notes_frozen();

CREATE OR REPLACE FUNCTION credit_note_lines_frozen() RETURNS trigger AS $$
DECLARE cn uuid; st credit_note_status;
BEGIN
  cn := CASE WHEN TG_OP = 'INSERT' THEN NEW.credit_note_id ELSE OLD.credit_note_id END;
  SELECT status INTO st FROM credit_notes WHERE id = cn;
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    RAISE EXCEPTION 'the lines of an issued credit note cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER credit_note_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON credit_note_lines FOR EACH ROW EXECUTE FUNCTION credit_note_lines_frozen();

-- A payment's identity never changes after it is recorded (corrections are refunds, never edits).
CREATE OR REPLACE FUNCTION payments_frozen() RETURNS trigger AS $$
BEGIN
  IF NEW.number <> OLD.number OR NEW.customer_id <> OLD.customer_id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.amount_cents <> OLD.amount_cents OR NEW.method <> OLD.method OR NEW.purpose <> OLD.purpose THEN
    RAISE EXCEPTION 'a recorded payment cannot be changed; refund it instead' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payments_frozen BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION payments_frozen();

-- Customer credit can never go below zero, even if two requests race: entries for one customer are serialised
-- by an advisory lock, and the balance is re-read under it.
CREATE OR REPLACE FUNCTION credit_entry_guard() RETURNS trigger AS $$
DECLARE bal bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('credit:' || NEW.business_id::text || ':' || NEW.customer_id::text, 0));
  SELECT COALESCE(SUM(amount_cents), 0) INTO bal FROM customer_credit_entries WHERE business_id = NEW.business_id AND customer_id = NEW.customer_id;
  IF bal + NEW.amount_cents < 0 THEN
    RAISE EXCEPTION 'customer credit cannot go below zero' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER credit_entry_balance BEFORE INSERT ON customer_credit_entries FOR EACH ROW EXECUTE FUNCTION credit_entry_guard();

-- ───────── Row-level security ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_settings','quotes','quote_versions','quote_lines','invoices','invoice_lines','payments','refunds','receipts',
    'customer_credit_entries','credit_notes','credit_note_lines','finance_events','document_links','finance_notifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (business_id = app_current_business())
      WITH CHECK (business_id = app_current_business())$p$, t);
  END LOOP;
END $$;

-- A customer's secret link finds exactly its own row (by hash) before any business is known. The hash is set
-- transaction-locally by the public-link code path and is useless without the token it is the hash of.
CREATE POLICY link_by_hash ON document_links FOR SELECT USING (token_hash = current_setting('app.link_hash', true));
CREATE POLICY link_touch ON document_links FOR UPDATE USING (token_hash = current_setting('app.link_hash', true)) WITH CHECK (token_hash = current_setting('app.link_hash', true));

-- ───────── Backfill: finance settings for businesses that already exist ─────────
INSERT INTO finance_settings (business_id, enabled_methods, reminder_offsets, updated_at)
SELECT id, ARRAY['CARD', 'EFT', 'CASH', 'OTHER']::payment_method[], ARRAY[-3, 0, 7]::integer[], now() FROM businesses;
