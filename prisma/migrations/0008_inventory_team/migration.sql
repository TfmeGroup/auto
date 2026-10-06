
-- CreateEnum
CREATE TYPE "inventory_status" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "stock_movement_type" AS ENUM ('RECEIVED', 'SOLD', 'USED', 'RESERVED', 'UNRESERVED', 'RETURNED', 'ADJUSTED', 'DAMAGED', 'LOST', 'TRANSFER_IN', 'TRANSFER_OUT', 'SUPPLIER_RETURN');

-- CreateEnum
CREATE TYPE "purchase_order_status" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "transfer_status" AS ENUM ('DRAFT', 'REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "cost_method" AS ENUM ('LAST_COST', 'AVERAGE_COST');

-- CreateEnum
CREATE TYPE "technician_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "time_entry_status" AS ENUM ('RUNNING', 'COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "time_entry_source" AS ENUM ('TIMER', 'MANUAL');

-- AlterTable
ALTER TABLE "service_types" ADD COLUMN     "labour_rate_cents_per_hour" INTEGER;

-- AlterTable
ALTER TABLE "job_parts" ADD COLUMN     "fitted_at" TIMESTAMPTZ(3),
ADD COLUMN     "fitted_by_id" UUID,
ADD COLUMN     "reserved_at" TIMESTAMPTZ(3),
ADD COLUMN     "returned_at" TIMESTAMPTZ(3),
ADD COLUMN     "stock_location_id" UUID;

-- AlterTable
ALTER TABLE "finance_settings" ADD COLUMN     "default_labour_rate_cents_per_hour" INTEGER;

-- CreateTable
CREATE TABLE "inventory_settings" (
    "business_id" UUID NOT NULL,
    "unique_sku" BOOLEAN NOT NULL DEFAULT true,
    "unique_part_number" BOOLEAN NOT NULL DEFAULT false,
    "unique_barcode" BOOLEAN NOT NULL DEFAULT true,
    "allow_negative_stock" BOOLEAN NOT NULL DEFAULT false,
    "auto_reserve_on_job_add" BOOLEAN NOT NULL DEFAULT true,
    "cost_method" "cost_method" NOT NULL DEFAULT 'LAST_COST',
    "po_prefix" TEXT NOT NULL DEFAULT 'PO',
    "receipt_prefix" TEXT NOT NULL DEFAULT 'GRN',
    "transfer_prefix" TEXT NOT NULL DEFAULT 'TRF',
    "supplier_return_prefix" TEXT NOT NULL DEFAULT 'SRT',
    "number_padding" INTEGER NOT NULL DEFAULT 6,
    "po_approval_required" BOOLEAN NOT NULL DEFAULT false,
    "po_approval_threshold_cents" INTEGER NOT NULL DEFAULT 0,
    "transfer_approval_required" BOOLEAN NOT NULL DEFAULT false,
    "po_reminder_days" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_settings_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "part_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" "record_status" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "part_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trading_name" TEXT,
    "contact_person" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "vat_number" TEXT,
    "registration_number" TEXT,
    "account_number" TEXT,
    "payment_terms" TEXT,
    "notes" TEXT,
    "status" "inventory_status" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "part_number" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category_id" UUID,
    "brand" TEXT,
    "manufacturer" TEXT,
    "barcode" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "cost_cents" INTEGER,
    "sell_price_cents" INTEGER,
    "tax_treatment" "tax_treatment" NOT NULL DEFAULT 'STANDARD',
    "min_stock" INTEGER NOT NULL DEFAULT 0,
    "reorder_level" INTEGER,
    "reorder_quantity" INTEGER,
    "primary_supplier_id" UUID,
    "status" "inventory_status" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "last_alert_level" TEXT NOT NULL DEFAULT 'NORMAL',
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_compatibility" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "year_from" INTEGER,
    "year_to" INTEGER,
    "variant" TEXT,
    "engine" TEXT,
    "engine_size_cc" INTEGER,
    "fuel_type" "fuel_type",
    "transmission" "transmission",
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "part_compatibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_suppliers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "supplier_part_number" TEXT,
    "supplier_cost_cents" INTEGER,
    "lead_time_days" INTEGER,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "status" "inventory_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "part_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_price_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "previous_cost_cents" INTEGER,
    "new_cost_cents" INTEGER,
    "previous_sell_cents" INTEGER,
    "new_sell_cents" INTEGER,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "changed_by_id" UUID,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "part_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_levels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "storage_area" TEXT,
    "bin" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "type" "stock_movement_type" NOT NULL,
    "on_hand_delta" INTEGER NOT NULL,
    "reserved_delta" INTEGER NOT NULL DEFAULT 0,
    "on_hand_before" INTEGER NOT NULL DEFAULT 0,
    "on_hand_after" INTEGER NOT NULL DEFAULT 0,
    "reserved_before" INTEGER NOT NULL DEFAULT 0,
    "reserved_after" INTEGER NOT NULL DEFAULT 0,
    "unit_cost_cents" INTEGER,
    "reference_type" TEXT,
    "reference_id" UUID,
    "job_id" UUID,
    "job_part_id" UUID,
    "invoice_id" UUID,
    "purchase_order_id" UUID,
    "receipt_id" UUID,
    "transfer_id" UUID,
    "reason_code" TEXT,
    "reason" TEXT,
    "went_negative" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "status" "purchase_order_status" NOT NULL DEFAULT 'DRAFT',
    "po_date" DATE NOT NULL,
    "expected_date" DATE,
    "notes" TEXT,
    "internal_notes" TEXT,
    "terms" TEXT,
    "vat_registered" BOOLEAN NOT NULL DEFAULT false,
    "vat_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "subtotal_cents" INTEGER NOT NULL DEFAULT 0,
    "vat_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "rejected_reason" TEXT,
    "ordered_at" TIMESTAMPTZ(3),
    "ordered_by_id" UUID,
    "sent_to_supplier_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "closed_short" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "last_late_notice_for" DATE,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "part_id" UUID,
    "description" TEXT NOT NULL,
    "supplier_part_number" TEXT,
    "quantity_ordered" INTEGER NOT NULL,
    "quantity_received" INTEGER NOT NULL DEFAULT 0,
    "quantity_cancelled" INTEGER NOT NULL DEFAULT 0,
    "quantity_damaged" INTEGER NOT NULL DEFAULT 0,
    "unit_cost_cents" INTEGER NOT NULL,
    "tax_treatment" "tax_treatment" NOT NULL DEFAULT 'STANDARD',
    "vat_rate_bps" INTEGER NOT NULL DEFAULT 0,
    "subtotal_cents" INTEGER NOT NULL DEFAULT 0,
    "vat_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "delivery_note_ref" TEXT,
    "notes" TEXT,
    "idempotency_key" TEXT,
    "received_by_id" UUID,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "po_line_id" UUID NOT NULL,
    "part_id" UUID,
    "description" TEXT NOT NULL,
    "quantity_expected" INTEGER NOT NULL,
    "quantity_received" INTEGER NOT NULL,
    "quantity_damaged" INTEGER NOT NULL DEFAULT 0,
    "quantity_incorrect" INTEGER NOT NULL DEFAULT 0,
    "quantity_missing" INTEGER NOT NULL DEFAULT 0,
    "unit_cost_cents" INTEGER NOT NULL,
    "vat_cents" INTEGER NOT NULL DEFAULT 0,
    "quantity_returned" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_returns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "receipt_id" UUID,
    "purchase_order_id" UUID,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "idempotency_key" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_return_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "receipt_line_id" UUID,
    "quantity" INTEGER NOT NULL,
    "unit_cost_cents" INTEGER,
    "reason" TEXT,

    CONSTRAINT "supplier_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "from_location_id" UUID NOT NULL,
    "to_location_id" UUID NOT NULL,
    "status" "transfer_status" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "requested_by_id" UUID,
    "requested_at" TIMESTAMPTZ(3),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "shipped_by_id" UUID,
    "shipped_at" TIMESTAMPTZ(3),
    "received_by_id" UUID,
    "received_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_cost_cents" INTEGER,

    CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "is_technician" BOOLEAN NOT NULL DEFAULT true,
    "status" "technician_status" NOT NULL DEFAULT 'ACTIVE',
    "billable_rate_cents_per_hour" INTEGER,
    "skills" TEXT[],
    "notes" TEXT,
    "deactivated_at" TIMESTAMPTZ(3),
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "technician_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_service_types" (
    "technician_id" UUID NOT NULL,
    "service_type_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,

    CONSTRAINT "technician_service_types_pkey" PRIMARY KEY ("technician_id","service_type_id")
);

-- CreateTable
CREATE TABLE "job_assignment_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_assignment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "status" "time_entry_status" NOT NULL,
    "source" "time_entry_source" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "duration_minutes" INTEGER,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "job_labour_id" UUID,
    "posted_at" TIMESTAMPTZ(3),
    "idempotency_key" TEXT,
    "edit_count" INTEGER NOT NULL DEFAULT 0,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_id" UUID,
    "void_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "part_categories_business_id_status_idx" ON "part_categories"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "part_categories_id_business_id_key" ON "part_categories"("id", "business_id");

-- CreateIndex
CREATE INDEX "suppliers_business_id_status_idx" ON "suppliers"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_id_business_id_key" ON "suppliers"("id", "business_id");

-- CreateIndex
CREATE INDEX "parts_business_id_status_idx" ON "parts"("business_id", "status");

-- CreateIndex
CREATE INDEX "parts_business_id_category_id_idx" ON "parts"("business_id", "category_id");

-- CreateIndex
CREATE INDEX "parts_business_id_primary_supplier_id_idx" ON "parts"("business_id", "primary_supplier_id");

-- CreateIndex
CREATE INDEX "parts_business_id_barcode_idx" ON "parts"("business_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "parts_id_business_id_key" ON "parts"("id", "business_id");

-- CreateIndex
CREATE INDEX "part_compatibility_business_id_part_id_idx" ON "part_compatibility"("business_id", "part_id");

-- CreateIndex
CREATE INDEX "part_compatibility_business_id_make_model_idx" ON "part_compatibility"("business_id", "make", "model");

-- CreateIndex
CREATE INDEX "part_suppliers_business_id_supplier_id_idx" ON "part_suppliers"("business_id", "supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "part_suppliers_part_id_supplier_id_key" ON "part_suppliers"("part_id", "supplier_id");

-- CreateIndex
CREATE INDEX "part_price_history_business_id_part_id_changed_at_idx" ON "part_price_history"("business_id", "part_id", "changed_at" DESC);

-- CreateIndex
CREATE INDEX "stock_levels_business_id_location_id_idx" ON "stock_levels"("business_id", "location_id");

-- CreateIndex
CREATE INDEX "stock_levels_business_id_part_id_idx" ON "stock_levels"("business_id", "part_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_levels_part_id_location_id_key" ON "stock_levels"("part_id", "location_id");

-- CreateIndex
CREATE INDEX "stock_movements_business_id_part_id_created_at_idx" ON "stock_movements"("business_id", "part_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_business_id_location_id_type_created_at_idx" ON "stock_movements"("business_id", "location_id", "type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_business_id_created_at_idx" ON "stock_movements"("business_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "stock_movements_business_id_reference_type_reference_id_idx" ON "stock_movements"("business_id", "reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "stock_movements_business_id_job_id_idx" ON "stock_movements"("business_id", "job_id");

-- CreateIndex
CREATE INDEX "purchase_orders_business_id_status_created_at_idx" ON "purchase_orders"("business_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "purchase_orders_business_id_supplier_id_idx" ON "purchase_orders"("business_id", "supplier_id");

-- CreateIndex
CREATE INDEX "purchase_orders_business_id_location_id_idx" ON "purchase_orders"("business_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_id_business_id_key" ON "purchase_orders"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_business_id_number_key" ON "purchase_orders"("business_id", "number");

-- CreateIndex
CREATE INDEX "purchase_order_lines_business_id_purchase_order_id_position_idx" ON "purchase_order_lines"("business_id", "purchase_order_id", "position");

-- CreateIndex
CREATE INDEX "purchase_order_lines_business_id_part_id_idx" ON "purchase_order_lines"("business_id", "part_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_id_business_id_key" ON "purchase_order_lines"("id", "business_id");

-- CreateIndex
CREATE INDEX "goods_receipts_business_id_purchase_order_id_idx" ON "goods_receipts"("business_id", "purchase_order_id");

-- CreateIndex
CREATE INDEX "goods_receipts_business_id_supplier_id_received_at_idx" ON "goods_receipts"("business_id", "supplier_id", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_id_business_id_key" ON "goods_receipts"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_business_id_number_key" ON "goods_receipts"("business_id", "number");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_business_id_receipt_id_idx" ON "goods_receipt_lines"("business_id", "receipt_id");

-- CreateIndex
CREATE INDEX "goods_receipt_lines_business_id_part_id_idx" ON "goods_receipt_lines"("business_id", "part_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_lines_id_business_id_key" ON "goods_receipt_lines"("id", "business_id");

-- CreateIndex
CREATE INDEX "supplier_returns_business_id_supplier_id_created_at_idx" ON "supplier_returns"("business_id", "supplier_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_returns_id_business_id_key" ON "supplier_returns"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_returns_business_id_number_key" ON "supplier_returns"("business_id", "number");

-- CreateIndex
CREATE INDEX "supplier_return_lines_business_id_return_id_idx" ON "supplier_return_lines"("business_id", "return_id");

-- CreateIndex
CREATE INDEX "supplier_return_lines_business_id_part_id_idx" ON "supplier_return_lines"("business_id", "part_id");

-- CreateIndex
CREATE INDEX "stock_transfers_business_id_status_idx" ON "stock_transfers"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_id_business_id_key" ON "stock_transfers"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_business_id_number_key" ON "stock_transfers"("business_id", "number");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_business_id_transfer_id_idx" ON "stock_transfer_lines"("business_id", "transfer_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_lines_transfer_id_part_id_key" ON "stock_transfer_lines"("transfer_id", "part_id");

-- CreateIndex
CREATE INDEX "technician_profiles_business_id_status_idx" ON "technician_profiles"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "technician_profiles_membership_id_key" ON "technician_profiles"("membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "technician_profiles_id_business_id_key" ON "technician_profiles"("id", "business_id");

-- CreateIndex
CREATE INDEX "job_assignment_events_business_id_job_id_created_at_idx" ON "job_assignment_events"("business_id", "job_id", "created_at");

-- CreateIndex
CREATE INDEX "job_assignment_events_business_id_membership_id_created_at_idx" ON "job_assignment_events"("business_id", "membership_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "time_entries_business_id_membership_id_started_at_idx" ON "time_entries"("business_id", "membership_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "time_entries_business_id_job_id_idx" ON "time_entries"("business_id", "job_id");

-- CreateIndex
CREATE INDEX "time_entries_business_id_status_idx" ON "time_entries"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "time_entries_id_business_id_key" ON "time_entries"("id", "business_id");

-- CreateIndex
CREATE INDEX "job_parts_business_id_inventory_item_id_status_idx" ON "job_parts"("business_id", "inventory_item_id", "status");

-- AddForeignKey
ALTER TABLE "job_parts" ADD CONSTRAINT "job_parts_inventory_item_id_business_id_fkey" FOREIGN KEY ("inventory_item_id", "business_id") REFERENCES "parts"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts" ADD CONSTRAINT "parts_category_id_business_id_fkey" FOREIGN KEY ("category_id", "business_id") REFERENCES "part_categories"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parts" ADD CONSTRAINT "parts_primary_supplier_id_business_id_fkey" FOREIGN KEY ("primary_supplier_id", "business_id") REFERENCES "suppliers"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_compatibility" ADD CONSTRAINT "part_compatibility_part_id_business_id_fkey" FOREIGN KEY ("part_id", "business_id") REFERENCES "parts"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_suppliers" ADD CONSTRAINT "part_suppliers_part_id_business_id_fkey" FOREIGN KEY ("part_id", "business_id") REFERENCES "parts"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_suppliers" ADD CONSTRAINT "part_suppliers_supplier_id_business_id_fkey" FOREIGN KEY ("supplier_id", "business_id") REFERENCES "suppliers"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "part_price_history" ADD CONSTRAINT "part_price_history_part_id_business_id_fkey" FOREIGN KEY ("part_id", "business_id") REFERENCES "parts"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_part_id_business_id_fkey" FOREIGN KEY ("part_id", "business_id") REFERENCES "parts"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_part_id_business_id_fkey" FOREIGN KEY ("part_id", "business_id") REFERENCES "parts"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_business_id_fkey" FOREIGN KEY ("supplier_id", "business_id") REFERENCES "suppliers"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_business_id_fkey" FOREIGN KEY ("purchase_order_id", "business_id") REFERENCES "purchase_orders"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_part_id_business_id_fkey" FOREIGN KEY ("part_id", "business_id") REFERENCES "parts"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_business_id_fkey" FOREIGN KEY ("purchase_order_id", "business_id") REFERENCES "purchase_orders"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_id_business_id_fkey" FOREIGN KEY ("receipt_id", "business_id") REFERENCES "goods_receipts"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_return_id_business_id_fkey" FOREIGN KEY ("return_id", "business_id") REFERENCES "supplier_returns"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_id_business_id_fkey" FOREIGN KEY ("transfer_id", "business_id") REFERENCES "stock_transfers"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "technician_service_types" ADD CONSTRAINT "technician_service_types_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "technician_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═════════════════════════ Part 5 integrity layer (hand-written) ═════════════════════════

-- ───────── Foreign keys the schema file does not model ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'inventory_settings','part_categories','suppliers','parts','part_compatibility','part_suppliers','part_price_history',
    'stock_levels','stock_movements','purchase_orders','purchase_order_lines','goods_receipts','goods_receipt_lines',
    'supplier_returns','supplier_return_lines','stock_transfers','stock_transfer_lines','technician_profiles',
    'technician_service_types','job_assignment_events','time_entries']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT', t, t || '_business_fkey');
  END LOOP;
END $$;

ALTER TABLE part_categories ADD CONSTRAINT part_categories_parent_fkey FOREIGN KEY (parent_id, business_id) REFERENCES part_categories(id, business_id) ON DELETE RESTRICT;
ALTER TABLE stock_levels ADD CONSTRAINT stock_levels_location_fkey FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_location_fkey FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_location_fkey FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE goods_receipts ADD CONSTRAINT goods_receipts_location_fkey FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE supplier_returns ADD CONSTRAINT supplier_returns_location_fkey FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE supplier_returns ADD CONSTRAINT supplier_returns_supplier_fkey FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers(id, business_id) ON DELETE RESTRICT;
ALTER TABLE goods_receipts ADD CONSTRAINT goods_receipts_supplier_fkey FOREIGN KEY (supplier_id, business_id) REFERENCES suppliers(id, business_id) ON DELETE RESTRICT;
ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_from_fkey FOREIGN KEY (from_location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_to_fkey FOREIGN KEY (to_location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE stock_transfer_lines ADD CONSTRAINT stock_transfer_lines_part_fkey FOREIGN KEY (part_id, business_id) REFERENCES parts(id, business_id) ON DELETE RESTRICT;
ALTER TABLE supplier_return_lines ADD CONSTRAINT supplier_return_lines_part_fkey FOREIGN KEY (part_id, business_id) REFERENCES parts(id, business_id) ON DELETE RESTRICT;
ALTER TABLE goods_receipt_lines ADD CONSTRAINT goods_receipt_lines_po_line_fkey FOREIGN KEY (po_line_id, business_id) REFERENCES purchase_order_lines(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_parts ADD CONSTRAINT job_parts_stock_location_fkey FOREIGN KEY (stock_location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE technician_profiles ADD CONSTRAINT technician_profiles_membership_fkey FOREIGN KEY (membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_assignment_events ADD CONSTRAINT job_assignment_events_job_fkey FOREIGN KEY (job_id, business_id) REFERENCES job_cards(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_assignment_events ADD CONSTRAINT job_assignment_events_membership_fkey FOREIGN KEY (membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_job_fkey FOREIGN KEY (job_id, business_id) REFERENCES job_cards(id, business_id) ON DELETE RESTRICT;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_membership_fkey FOREIGN KEY (membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;

-- ───────── Value rules ─────────
ALTER TABLE parts ADD CONSTRAINT parts_chk CHECK (
  min_stock >= 0 AND COALESCE(cost_cents, 0) >= 0 AND COALESCE(sell_price_cents, 0) >= 0
  AND COALESCE(reorder_level, 0) >= 0 AND COALESCE(reorder_quantity, 0) >= 0 AND length(btrim(sku)) > 0 AND length(btrim(name)) > 0);
ALTER TABLE part_compatibility ADD CONSTRAINT part_compatibility_chk CHECK (year_from IS NULL OR year_to IS NULL OR year_from <= year_to);
ALTER TABLE part_suppliers ADD CONSTRAINT part_suppliers_chk CHECK (COALESCE(supplier_cost_cents, 0) >= 0 AND COALESCE(lead_time_days, 0) >= 0);
ALTER TABLE stock_levels ADD CONSTRAINT stock_levels_chk CHECK (reserved >= 0);

-- Every movement is one recognisable kind of change to the two counters.
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_shape_chk CHECK (
  (type = 'RESERVED' AND on_hand_delta = 0 AND reserved_delta > 0) OR
  (type = 'UNRESERVED' AND on_hand_delta = 0 AND reserved_delta < 0) OR
  (type IN ('RECEIVED', 'RETURNED', 'TRANSFER_IN') AND on_hand_delta > 0 AND reserved_delta = 0) OR
  (type = 'USED' AND on_hand_delta < 0 AND reserved_delta <= 0 AND reserved_delta >= on_hand_delta) OR
  (type IN ('SOLD', 'SUPPLIER_RETURN', 'TRANSFER_OUT') AND on_hand_delta < 0 AND reserved_delta = 0) OR
  (type IN ('DAMAGED', 'LOST') AND on_hand_delta <= 0 AND reserved_delta = 0) OR
  (type = 'ADJUSTED' AND on_hand_delta <> 0 AND reserved_delta = 0));

ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_chk CHECK (
  subtotal_cents >= 0 AND vat_cents >= 0 AND total_cents = subtotal_cents + vat_cents
  AND (expected_date IS NULL OR expected_date >= po_date));
ALTER TABLE purchase_order_lines ADD CONSTRAINT purchase_order_lines_chk CHECK (
  quantity_ordered > 0 AND quantity_received >= 0 AND quantity_cancelled >= 0 AND quantity_damaged >= 0
  AND quantity_received + quantity_cancelled <= quantity_ordered
  AND unit_cost_cents >= 0 AND subtotal_cents >= 0 AND vat_cents >= 0 AND total_cents = subtotal_cents + vat_cents);
ALTER TABLE goods_receipt_lines ADD CONSTRAINT goods_receipt_lines_chk CHECK (
  quantity_received >= 0 AND quantity_damaged >= 0 AND quantity_incorrect >= 0 AND quantity_missing >= 0
  AND quantity_expected >= quantity_received + quantity_damaged + quantity_incorrect
  AND quantity_returned >= 0 AND quantity_returned <= quantity_received AND unit_cost_cents >= 0 AND vat_cents >= 0
  AND quantity_received + quantity_damaged + quantity_incorrect > 0);
ALTER TABLE supplier_return_lines ADD CONSTRAINT supplier_return_lines_chk CHECK (quantity > 0);
ALTER TABLE stock_transfers ADD CONSTRAINT stock_transfers_chk CHECK (from_location_id <> to_location_id);
ALTER TABLE stock_transfer_lines ADD CONSTRAINT stock_transfer_lines_chk CHECK (quantity > 0);
ALTER TABLE technician_profiles ADD CONSTRAINT technician_profiles_chk CHECK (COALESCE(billable_rate_cents_per_hour, 0) >= 0);
ALTER TABLE service_types ADD CONSTRAINT service_types_rate_chk CHECK (COALESCE(labour_rate_cents_per_hour, 0) >= 0);
ALTER TABLE finance_settings ADD CONSTRAINT finance_settings_labour_rate_chk CHECK (COALESCE(default_labour_rate_cents_per_hour, 0) >= 0);
ALTER TABLE time_entries ADD CONSTRAINT time_entries_chk CHECK (
  (status = 'RUNNING' AND ended_at IS NULL AND duration_minutes IS NULL)
  OR (status = 'COMPLETED' AND ended_at IS NOT NULL AND ended_at > started_at AND duration_minutes IS NOT NULL AND duration_minutes >= 0 AND duration_minutes <= 1440)
  OR status = 'VOIDED');
-- A part drawn from stock must say where from once it is reserved or fitted.
ALTER TABLE job_parts ADD CONSTRAINT job_parts_stock_chk CHECK (inventory_item_id IS NULL OR status NOT IN ('RESERVED', 'FITTED') OR stock_location_id IS NOT NULL);

-- ───────── Uniqueness and lookups ─────────
CREATE UNIQUE INDEX part_categories_name_uq ON part_categories (business_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) WHERE status = 'ACTIVE';
CREATE INDEX parts_sku_lower_idx ON parts (business_id, lower(sku));
CREATE INDEX parts_part_number_lower_idx ON parts (business_id, lower(part_number)) WHERE part_number IS NOT NULL;
CREATE INDEX parts_name_trgm ON parts USING gin (name gin_trgm_ops);
CREATE INDEX parts_sku_trgm ON parts USING gin (sku gin_trgm_ops);
CREATE INDEX parts_part_number_trgm ON parts USING gin (part_number gin_trgm_ops);
CREATE INDEX parts_barcode_trgm ON parts USING gin (barcode gin_trgm_ops);
CREATE INDEX parts_brand_trgm ON parts USING gin (brand gin_trgm_ops);
CREATE INDEX part_suppliers_spn_trgm ON part_suppliers USING gin (supplier_part_number gin_trgm_ops);
CREATE INDEX suppliers_name_trgm ON suppliers USING gin (name gin_trgm_ops);
CREATE INDEX suppliers_email_trgm ON suppliers USING gin (email gin_trgm_ops);
CREATE INDEX suppliers_phone_idx ON suppliers (business_id, phone);
CREATE INDEX suppliers_account_idx ON suppliers (business_id, account_number);
CREATE INDEX suppliers_vat_idx ON suppliers (business_id, vat_number);
CREATE INDEX purchase_orders_number_trgm ON purchase_orders USING gin (number gin_trgm_ops);
CREATE INDEX purchase_orders_open_idx ON purchase_orders (business_id, expected_date) WHERE status IN ('ORDERED', 'PARTIALLY_RECEIVED');
CREATE INDEX stock_levels_low_idx ON stock_levels (business_id, part_id) WHERE on_hand <= 0;
CREATE UNIQUE INDEX stock_movements_idem_uq ON stock_movements (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX goods_receipts_idem_uq ON goods_receipts (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX supplier_returns_idem_uq ON supplier_returns (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX time_entries_one_running_uq ON time_entries (business_id, membership_id) WHERE status = 'RUNNING';
CREATE UNIQUE INDEX time_entries_idem_uq ON time_entries (business_id, membership_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX time_entries_range_idx ON time_entries (business_id, started_at) WHERE status <> 'VOIDED';

-- ───────── Stock: quantities move only through movements ─────────
-- Applying a movement happens HERE, under the stock row's lock, so two requests for the last unit are decided one after
-- the other by the database no matter what the application checked first.
CREATE OR REPLACE FUNCTION stock_movement_apply() RETURNS trigger AS $$
DECLARE
  lvl stock_levels%ROWTYPE;
  neg_ok boolean;
  new_on integer;
  new_res integer;
BEGIN
  INSERT INTO stock_levels (business_id, part_id, location_id, updated_at)
    VALUES (NEW.business_id, NEW.part_id, NEW.location_id, now())
    ON CONFLICT (part_id, location_id) DO NOTHING;
  SELECT * INTO lvl FROM stock_levels WHERE part_id = NEW.part_id AND location_id = NEW.location_id FOR UPDATE;
  IF lvl.business_id <> NEW.business_id THEN
    RAISE EXCEPTION 'TFME_STOCK: part and location do not belong together' USING ERRCODE = '23514';
  END IF;
  SELECT allow_negative_stock INTO neg_ok FROM inventory_settings WHERE business_id = NEW.business_id;
  neg_ok := COALESCE(neg_ok, false);
  new_on := lvl.on_hand + NEW.on_hand_delta;
  new_res := lvl.reserved + NEW.reserved_delta;
  IF new_res < 0 THEN
    RAISE EXCEPTION 'TFME_STOCK: more stock would be released than is reserved' USING ERRCODE = '23514';
  END IF;
  IF (NEW.on_hand_delta - NEW.reserved_delta) < 0 AND (new_on - new_res) < 0 AND NOT neg_ok THEN
    RAISE EXCEPTION 'TFME_STOCK_INSUFFICIENT: not enough stock available' USING ERRCODE = '23514';
  END IF;
  NEW.on_hand_before := lvl.on_hand;
  NEW.on_hand_after := new_on;
  NEW.reserved_before := lvl.reserved;
  NEW.reserved_after := new_res;
  NEW.went_negative := (new_on - new_res) < 0;
  UPDATE stock_levels SET on_hand = new_on, reserved = new_res, updated_at = now() WHERE id = lvl.id;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_movements_apply BEFORE INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION stock_movement_apply();
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE OR REPLACE FUNCTION stock_levels_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.on_hand <> 0 OR NEW.reserved <> 0 THEN
      RAISE EXCEPTION 'stock quantities change only through stock movements' USING ERRCODE = '42501';
    END IF;
  ELSIF (NEW.on_hand <> OLD.on_hand OR NEW.reserved <> OLD.reserved) AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'stock quantities change only through stock movements' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_levels_guard_trg BEFORE INSERT OR UPDATE ON stock_levels FOR EACH ROW EXECUTE FUNCTION stock_levels_guard();
CREATE TRIGGER stock_levels_no_delete BEFORE DELETE ON stock_levels FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ───────── History is kept ─────────
CREATE TRIGGER part_price_history_append_only BEFORE UPDATE OR DELETE ON part_price_history FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER job_assignment_events_append_only BEFORE UPDATE OR DELETE ON job_assignment_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER supplier_returns_append_only BEFORE UPDATE OR DELETE ON supplier_returns FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER supplier_return_lines_append_only BEFORE UPDATE OR DELETE ON supplier_return_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER goods_receipts_append_only BEFORE UPDATE OR DELETE ON goods_receipts FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A receipt line never changes, except that returning goods to the supplier counts up how many have gone back.
CREATE OR REPLACE FUNCTION goods_receipt_lines_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'delivery records cannot be deleted' USING ERRCODE = '42501';
  END IF;
  IF (NEW.quantity_received, NEW.quantity_damaged, NEW.quantity_incorrect, NEW.quantity_missing, NEW.unit_cost_cents, NEW.vat_cents, NEW.po_line_id, NEW.part_id, NEW.receipt_id)
     IS DISTINCT FROM (OLD.quantity_received, OLD.quantity_damaged, OLD.quantity_incorrect, OLD.quantity_missing, OLD.unit_cost_cents, OLD.vat_cents, OLD.po_line_id, OLD.part_id, OLD.receipt_id)
     OR NEW.quantity_returned < OLD.quantity_returned THEN
    RAISE EXCEPTION 'a delivery record cannot be changed; correct it with a supplier return or an adjustment' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER goods_receipt_lines_guard_trg BEFORE UPDATE OR DELETE ON goods_receipt_lines FOR EACH ROW EXECUTE FUNCTION goods_receipt_lines_guard();

CREATE TRIGGER parts_no_delete BEFORE DELETE ON parts FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER suppliers_no_delete BEFORE DELETE ON suppliers FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER part_categories_no_delete BEFORE DELETE ON part_categories FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER purchase_orders_no_delete BEFORE DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER stock_transfers_no_delete BEFORE DELETE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER time_entries_no_delete BEFORE DELETE ON time_entries FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER technician_profiles_no_delete BEFORE DELETE ON technician_profiles FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ───────── Purchase orders: controlled status changes, frozen once ordered ─────────
CREATE OR REPLACE FUNCTION purchase_order_guard() RETURNS trigger AS $$
DECLARE open_lines integer; line_count integer; got integer;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'ORDERED', 'CANCELLED')) OR
      (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED', 'DRAFT', 'CANCELLED')) OR
      (OLD.status = 'APPROVED' AND NEW.status IN ('ORDERED', 'DRAFT', 'CANCELLED')) OR
      (OLD.status = 'ORDERED' AND NEW.status IN ('PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')) OR
      (OLD.status = 'PARTIALLY_RECEIVED' AND NEW.status IN ('RECEIVED'))
    ) THEN
      RAISE EXCEPTION 'a purchase order cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    SELECT count(*), COALESCE(sum(quantity_received), 0), count(*) FILTER (WHERE quantity_ordered - quantity_received - quantity_cancelled > 0)
      INTO line_count, got, open_lines FROM purchase_order_lines WHERE purchase_order_id = NEW.id AND business_id = NEW.business_id;
    IF NEW.status IN ('PENDING_APPROVAL', 'ORDERED') AND line_count = 0 THEN
      RAISE EXCEPTION 'a purchase order needs at least one line' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'ORDERED' AND NEW.requires_approval AND OLD.status <> 'APPROVED' THEN
      RAISE EXCEPTION 'this purchase order needs approval before it can be placed' USING ERRCODE = '42501';
    END IF;
    IF NEW.status = 'RECEIVED' AND open_lines > 0 THEN
      RAISE EXCEPTION 'a purchase order with quantities still outstanding is not fully received' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'CANCELLED' AND got > 0 THEN
      RAISE EXCEPTION 'stock has already been received on this order; close it short instead of cancelling' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'PARTIALLY_RECEIVED' AND got = 0 THEN
      RAISE EXCEPTION 'nothing has been received on this purchase order' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status <> 'DRAFT' THEN
    IF (NEW.supplier_id, NEW.location_id, NEW.number, NEW.po_date, NEW.subtotal_cents, NEW.vat_cents, NEW.total_cents)
       IS DISTINCT FROM (OLD.supplier_id, OLD.location_id, OLD.number, OLD.po_date, OLD.subtotal_cents, OLD.vat_cents, OLD.total_cents) THEN
      RAISE EXCEPTION 'an order that has been placed cannot be edited' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_orders_guard BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION purchase_order_guard();

CREATE OR REPLACE FUNCTION purchase_order_lines_guard() RETURNS trigger AS $$
DECLARE st purchase_order_status; oid uuid; bid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN oid := OLD.purchase_order_id; bid := OLD.business_id; ELSE oid := NEW.purchase_order_id; bid := NEW.business_id; END IF;
  SELECT status INTO st FROM purchase_orders WHERE id = oid AND business_id = bid;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.part_id, NEW.description, NEW.quantity_ordered, NEW.unit_cost_cents, NEW.subtotal_cents, NEW.vat_cents, NEW.total_cents, NEW.purchase_order_id)
       IS NOT DISTINCT FROM (OLD.part_id, OLD.description, OLD.quantity_ordered, OLD.unit_cost_cents, OLD.subtotal_cents, OLD.vat_cents, OLD.total_cents, OLD.purchase_order_id) THEN
      IF NEW.quantity_received < OLD.quantity_received OR NEW.quantity_damaged < OLD.quantity_damaged OR NEW.quantity_cancelled < OLD.quantity_cancelled THEN
        RAISE EXCEPTION 'received quantities only go up' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF st IS NULL OR st <> 'DRAFT' THEN
    RAISE EXCEPTION 'the lines of a placed order cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER purchase_order_lines_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION purchase_order_lines_guard();

-- ───────── Transfers: controlled status changes ─────────
CREATE OR REPLACE FUNCTION stock_transfer_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'DRAFT' AND NEW.status IN ('REQUESTED', 'APPROVED', 'IN_TRANSIT', 'CANCELLED')) OR
    (OLD.status = 'REQUESTED' AND NEW.status IN ('APPROVED', 'CANCELLED')) OR
    (OLD.status = 'APPROVED' AND NEW.status IN ('IN_TRANSIT', 'CANCELLED')) OR
    (OLD.status = 'IN_TRANSIT' AND NEW.status = 'RECEIVED')
  ) THEN
    RAISE EXCEPTION 'a transfer cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('RECEIVED', 'CANCELLED') THEN
    RAISE EXCEPTION 'a finished transfer cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER stock_transfers_guard BEFORE UPDATE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION stock_transfer_guard();

-- ───────── Time entries: what has become a labour line is not rewritten ─────────
CREATE OR REPLACE FUNCTION time_entry_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.job_labour_id IS NOT NULL AND NEW.status <> 'VOIDED'
     AND (NEW.started_at, NEW.ended_at, NEW.duration_minutes, NEW.job_id, NEW.membership_id)
         IS DISTINCT FROM (OLD.started_at, OLD.ended_at, OLD.duration_minutes, OLD.job_id, OLD.membership_id) THEN
    RAISE EXCEPTION 'time that has been posted to labour cannot be edited' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'VOIDED' THEN
    RAISE EXCEPTION 'a voided time entry cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER time_entries_guard BEFORE UPDATE ON time_entries FOR EACH ROW EXECUTE FUNCTION time_entry_guard();

-- ───────── Row-level security ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'inventory_settings','part_categories','suppliers','parts','part_compatibility','part_suppliers','part_price_history',
    'stock_levels','stock_movements','purchase_orders','purchase_order_lines','goods_receipts','goods_receipt_lines',
    'supplier_returns','supplier_return_lines','stock_transfers','stock_transfer_lines','technician_profiles',
    'technician_service_types','job_assignment_events','time_entries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (business_id = app_current_business())
      WITH CHECK (business_id = app_current_business())$p$, t);
  END LOOP;
END $$;

-- ───────── Backfill: settings for businesses that already exist ─────────
INSERT INTO inventory_settings (business_id, updated_at) SELECT id, now() FROM businesses;
