-- CreateEnum
CREATE TYPE "customer_status" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "contact_method" AS ENUM ('PHONE', 'SMS', 'WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "fuel_type" AS ENUM ('PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC', 'LPG', 'OTHER');

-- CreateEnum
CREATE TYPE "transmission" AS ENUM ('MANUAL', 'AUTOMATIC', 'CVT', 'DCT', 'OTHER');

-- CreateEnum
CREATE TYPE "drive_type" AS ENUM ('FWD', 'RWD', 'AWD', 'FOUR_BY_FOUR', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_status" AS ENUM ('ACTIVE', 'AWAITING_SERVICE', 'IN_WORKSHOP', 'AWAITING_PARTS', 'REPAIR_REQUIRED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "mileage_source" AS ENUM ('CREATED', 'MANUAL', 'BOOKING', 'CHECK_IN', 'JOB_CREATED', 'SERVICE', 'JOB_COMPLETION', 'CORRECTION');

-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('REQUESTED', 'CONFIRMED', 'REMINDER_SENT', 'CHECKED_IN', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "job_card_status" AS ENUM ('BOOKED', 'CHECKED_IN', 'INSPECTION', 'DIAGNOSIS', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS', 'QUALITY_CHECK', 'READY_FOR_COLLECTION', 'COMPLETED', 'CANCELLED', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "job_priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "inspection_status" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "inspection_category" AS ENUM ('EXTERIOR', 'TYRES_WHEELS', 'MECHANICAL', 'OTHER');

-- CreateEnum
CREATE TYPE "inspection_item_status" AS ENUM ('NOT_CHECKED', 'GOOD', 'ATTENTION', 'CRITICAL');

-- CreateEnum
CREATE TYPE "work_priority" AS ENUM ('RECOMMENDED', 'IMPORTANT', 'URGENT');

-- CreateEnum
CREATE TYPE "approval_status" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "approval_method" AS ENUM ('IN_PERSON', 'PHONE', 'WRITTEN', 'OTHER');

-- CreateEnum
CREATE TYPE "work_source" AS ENUM ('INSPECTION_ITEM', 'DIAGNOSIS', 'MANUAL');

-- CreateEnum
CREATE TYPE "visibility" AS ENUM ('INTERNAL', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "photo_category" AS ENUM ('CHECK_IN_EXTERIOR', 'CHECK_IN_DAMAGE', 'CHECK_IN_WHEELS', 'CHECK_IN_INTERIOR', 'CHECK_IN_DASHBOARD', 'CHECK_IN_MILEAGE', 'CHECK_IN_ENGINE_BAY', 'BEFORE_REPAIR', 'DURING_REPAIR', 'DAMAGED_COMPONENT', 'DIAGNOSTIC_EVIDENCE', 'COMPLETED_REPAIR', 'SIGNATURE', 'OTHER');

-- CreateEnum
CREATE TYPE "fuel_level" AS ENUM ('EMPTY', 'QUARTER', 'HALF', 'THREE_QUARTERS', 'FULL');

-- CreateEnum
CREATE TYPE "part_status" AS ENUM ('REQUESTED', 'RESERVED', 'ORDERED', 'FITTED', 'RETURNED');

-- CreateEnum
CREATE TYPE "waiting_status" AS ENUM ('WAITING', 'CONTACTED', 'BOOKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "recurrence_frequency" AS ENUM ('WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "rule_status" AS ENUM ('ACTIVE', 'ENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "time_off_kind" AS ENUM ('LEAVE', 'DAY_OFF', 'SICK', 'OTHER');

-- AlterEnum (a rename, in place, so existing rows keep their meaning and the whole migration stays one transaction)
ALTER TYPE "customer_type" RENAME VALUE 'COMPANY' TO 'BUSINESS';

-- Customers: rename phone to mobile (data kept), split names, convert status without losing rows.
ALTER TABLE "customers" RENAME COLUMN "phone" TO "mobile";
ALTER INDEX customers_phone_digits_trgm RENAME TO customers_mobile_digits_trgm;
ALTER TABLE "customers"
  ADD COLUMN "alt_phone" TEXT,
  ADD COLUMN "company_registration_number" TEXT,
  ADD COLUMN "emergency_contact_name" TEXT,
  ADD COLUMN "emergency_contact_phone" TEXT,
  ADD COLUMN "first_name" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "id_number" TEXT,
  ADD COLUMN "last_name" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "marketing_consent_at" TIMESTAMPTZ(3),
  ADD COLUMN "preferred_contact" "contact_method";
UPDATE "customers" SET
  first_name = split_part(btrim(name), ' ', 1),
  last_name = btrim(substr(btrim(name), length(split_part(btrim(name), ' ', 1)) + 1));
DROP INDEX IF EXISTS "customers_business_id_status_created_at_idx";
ALTER TABLE "customers" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "customers" ALTER COLUMN "status" TYPE "customer_status" USING ("status"::text::"customer_status");
ALTER TABLE "customers" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "service_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "default_duration_min" INTEGER NOT NULL DEFAULT 60,
    "status" "record_status" NOT NULL DEFAULT 'ACTIVE',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bays" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "location_id" UUID,
    "name" TEXT NOT NULL,
    "status" "record_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workshop_settings" (
    "business_id" UUID NOT NULL,
    "allow_technician_overlap" BOOLEAN NOT NULL DEFAULT false,
    "max_concurrent_jobs" INTEGER,
    "require_checkin_signature" BOOLEAN NOT NULL DEFAULT false,
    "require_reschedule_reason" BOOLEAN NOT NULL DEFAULT false,
    "notify_customer_on_reschedule" BOOLEAN NOT NULL DEFAULT true,
    "notify_customer_on_cancel" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workshop_settings_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "workshop_hours" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,

    CONSTRAINT "workshop_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,

    CONSTRAINT "technician_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "technician_time_off" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "kind" "time_off_kind" NOT NULL DEFAULT 'LEAVE',
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "technician_time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "registration" TEXT,
    "registration_norm" TEXT,
    "vin" TEXT,
    "make" TEXT,
    "model" TEXT,
    "year" INTEGER,
    "variant" TEXT,
    "colour" TEXT,
    "engine" TEXT,
    "engine_size_cc" INTEGER,
    "fuel_type" "fuel_type",
    "transmission" "transmission",
    "drive_type" "drive_type",
    "mileage_km" INTEGER,
    "status" "vehicle_status" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT,
    "email" TEXT,
    "relationship" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_mileage_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "mileage_km" INTEGER NOT NULL,
    "source" "mileage_source" NOT NULL,
    "job_id" UUID,
    "booking_id" UUID,
    "is_correction" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "recorded_by_id" UUID,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_mileage_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_intervals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "service_type_id" UUID,
    "name" TEXT NOT NULL,
    "every_km" INTEGER,
    "every_months" INTEGER,
    "last_service_at" TIMESTAMPTZ(3),
    "last_service_km" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_intervals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_booking_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "service_type_id" UUID,
    "service_label" TEXT NOT NULL,
    "technician_membership_id" UUID,
    "bay_id" UUID,
    "location_id" UUID,
    "frequency" "recurrence_frequency" NOT NULL,
    "interval_count" INTEGER NOT NULL DEFAULT 1,
    "start_date" DATE NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "end_date" DATE,
    "occurrences" INTEGER,
    "status" "rule_status" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recurring_booking_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "booking_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "service_type_id" UUID,
    "service_label" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "technician_membership_id" UUID,
    "bay_id" UUID,
    "location_id" UUID,
    "status" "booking_status" NOT NULL DEFAULT 'CONFIRMED',
    "is_walk_in" BOOLEAN NOT NULL DEFAULT false,
    "recurring_rule_id" UUID,
    "customer_notes" TEXT,
    "internal_notes" TEXT,
    "expected_mileage_km" INTEGER,
    "reminder_sent_at" TIMESTAMPTZ(3),
    "checked_in_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" "booking_status",
    "to_status" "booking_status",
    "from_starts_at" TIMESTAMPTZ(3),
    "to_starts_at" TIMESTAMPTZ(3),
    "from_technician_membership_id" UUID,
    "to_technician_membership_id" UUID,
    "reason" TEXT,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waiting_list_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "service_type_id" UUID,
    "service_label" TEXT NOT NULL,
    "preferred_date" DATE,
    "preferred_start_minute" INTEGER,
    "preferred_end_minute" INTEGER,
    "contact_preference" "contact_method",
    "notes" TEXT,
    "status" "waiting_status" NOT NULL DEFAULT 'WAITING',
    "booking_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "waiting_list_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_cards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "job_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "booking_id" UUID,
    "status" "job_card_status" NOT NULL DEFAULT 'CHECKED_IN',
    "held_from_status" "job_card_status",
    "priority" "job_priority" NOT NULL DEFAULT 'NORMAL',
    "service_type_id" UUID,
    "service_label" TEXT,
    "complaint" TEXT,
    "is_walk_in" BOOLEAN NOT NULL DEFAULT false,
    "mileage_in_km" INTEGER,
    "mileage_out_km" INTEGER,
    "primary_technician_membership_id" UUID,
    "advisor_membership_id" UUID,
    "location_id" UUID,
    "bay_id" UUID,
    "estimated_completion_at" TIMESTAMPTZ(3),
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_id" UUID,
    "completion_summary" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_technicians" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "added_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_technicians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_check_ins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "arrived_at" TIMESTAMPTZ(3) NOT NULL,
    "mileage_km" INTEGER,
    "fuel_level" "fuel_level",
    "existing_damage" TEXT,
    "vehicle_condition" TEXT,
    "keys_accessories" TEXT,
    "notes" TEXT,
    "signature_name" TEXT,
    "signature_file_id" UUID,
    "signed_at" TIMESTAMPTZ(3),
    "checked_in_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "visibility" "visibility" NOT NULL DEFAULT 'INTERNAL',
    "author_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "job_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_photos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "category" "photo_category" NOT NULL DEFAULT 'OTHER',
    "visibility" "visibility" NOT NULL DEFAULT 'INTERNAL',
    "description" TEXT,
    "inspection_item_id" UUID,
    "diagnosis_id" UUID,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "job_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "technician_membership_id" UUID,
    "status" "inspection_status" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "completed_by_id" UUID,
    "mileage_km" INTEGER,
    "internal_notes" TEXT,
    "customer_summary" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "category" "inspection_category" NOT NULL,
    "item_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" "inspection_item_status" NOT NULL DEFAULT 'NOT_CHECKED',
    "internal_notes" TEXT,
    "customer_notes" TEXT,
    "measurement_tenths" INTEGER,
    "measurement_unit" TEXT,
    "customer_visible" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inspection_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnoses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "technician_membership_id" UUID,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symptoms" TEXT,
    "fault_codes" TEXT[],
    "tests_performed" TEXT,
    "findings" TEXT,
    "diagnosis" TEXT,
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmed_by_id" UUID,
    "internal_notes" TEXT,
    "customer_summary" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "diagnoses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommended_work_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "source_type" "work_source" NOT NULL DEFAULT 'MANUAL',
    "source_inspection_item_id" UUID,
    "source_diagnosis_id" UUID,
    "priority" "work_priority" NOT NULL DEFAULT 'RECOMMENDED',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "parts_description" TEXT,
    "estimated_minutes" INTEGER,
    "estimated_labour_cents" INTEGER,
    "estimated_parts_cents" INTEGER,
    "notes" TEXT,
    "customer_visible" BOOLEAN NOT NULL DEFAULT true,
    "approval_status" "approval_status" NOT NULL DEFAULT 'PENDING',
    "approval_method" "approval_method",
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_id" UUID,
    "decision_note" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "recommended_work_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_parts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "inventory_item_id" UUID,
    "recommended_work_id" UUID,
    "description" TEXT NOT NULL,
    "part_number" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "cost_cents" INTEGER,
    "sell_price_cents" INTEGER,
    "status" "part_status" NOT NULL DEFAULT 'REQUESTED',
    "added_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "job_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_labour" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "technician_membership_id" UUID,
    "description" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "rate_cents_per_hour" INTEGER,
    "total_cents" INTEGER,
    "recorded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "job_labour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_quality_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "checklist" JSONB NOT NULL,
    "reason" TEXT,
    "notes" TEXT,
    "checked_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_quality_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "customer_id" UUID,
    "vehicle_id" UUID,
    "job_id" UUID,
    "booking_id" UUID,
    "summary" TEXT NOT NULL,
    "visibility" "visibility" NOT NULL DEFAULT 'INTERNAL',
    "data" JSONB,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_types_business_id_status_idx" ON "service_types"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "service_types_id_business_id_key" ON "service_types"("id", "business_id");

-- CreateIndex
CREATE INDEX "bays_business_id_status_idx" ON "bays"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bays_id_business_id_key" ON "bays"("id", "business_id");

-- CreateIndex
CREATE INDEX "workshop_hours_business_id_weekday_idx" ON "workshop_hours"("business_id", "weekday");

-- CreateIndex
CREATE INDEX "technician_schedules_business_id_membership_id_weekday_idx" ON "technician_schedules"("business_id", "membership_id", "weekday");

-- CreateIndex
CREATE INDEX "technician_time_off_business_id_membership_id_starts_at_idx" ON "technician_time_off"("business_id", "membership_id", "starts_at");

-- CreateIndex
CREATE INDEX "vehicles_business_id_customer_id_idx" ON "vehicles"("business_id", "customer_id");

-- CreateIndex
CREATE INDEX "vehicles_business_id_status_idx" ON "vehicles"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_id_business_id_key" ON "vehicles"("id", "business_id");

-- CreateIndex
CREATE INDEX "vehicle_contacts_business_id_vehicle_id_idx" ON "vehicle_contacts"("business_id", "vehicle_id");

-- CreateIndex
CREATE INDEX "vehicle_mileage_log_business_id_vehicle_id_recorded_at_idx" ON "vehicle_mileage_log"("business_id", "vehicle_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "service_intervals_business_id_vehicle_id_idx" ON "service_intervals"("business_id", "vehicle_id");

-- CreateIndex
CREATE INDEX "recurring_booking_rules_business_id_status_idx" ON "recurring_booking_rules"("business_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_booking_rules_id_business_id_key" ON "recurring_booking_rules"("id", "business_id");

-- CreateIndex
CREATE INDEX "bookings_business_id_starts_at_idx" ON "bookings"("business_id", "starts_at");

-- CreateIndex
CREATE INDEX "bookings_business_id_status_starts_at_idx" ON "bookings"("business_id", "status", "starts_at");

-- CreateIndex
CREATE INDEX "bookings_business_id_technician_membership_id_starts_at_idx" ON "bookings"("business_id", "technician_membership_id", "starts_at");

-- CreateIndex
CREATE INDEX "bookings_business_id_customer_id_idx" ON "bookings"("business_id", "customer_id");

-- CreateIndex
CREATE INDEX "bookings_business_id_vehicle_id_idx" ON "bookings"("business_id", "vehicle_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_id_business_id_key" ON "bookings"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_business_id_booking_number_key" ON "bookings"("business_id", "booking_number");

-- CreateIndex
CREATE INDEX "booking_events_business_id_booking_id_created_at_idx" ON "booking_events"("business_id", "booking_id", "created_at");

-- CreateIndex
CREATE INDEX "waiting_list_entries_business_id_status_created_at_idx" ON "waiting_list_entries"("business_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "job_cards_business_id_status_opened_at_idx" ON "job_cards"("business_id", "status", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "job_cards_business_id_primary_technician_membership_id_stat_idx" ON "job_cards"("business_id", "primary_technician_membership_id", "status");

-- CreateIndex
CREATE INDEX "job_cards_business_id_customer_id_idx" ON "job_cards"("business_id", "customer_id");

-- CreateIndex
CREATE INDEX "job_cards_business_id_vehicle_id_idx" ON "job_cards"("business_id", "vehicle_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_cards_id_business_id_key" ON "job_cards"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_cards_id_business_id_vehicle_id_customer_id_key" ON "job_cards"("id", "business_id", "vehicle_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_cards_business_id_job_number_key" ON "job_cards"("business_id", "job_number");

-- CreateIndex
CREATE UNIQUE INDEX "job_cards_booking_id_business_id_key" ON "job_cards"("booking_id", "business_id");

-- CreateIndex
CREATE INDEX "job_technicians_business_id_membership_id_idx" ON "job_technicians"("business_id", "membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_technicians_job_id_membership_id_key" ON "job_technicians"("job_id", "membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_check_ins_job_id_key" ON "job_check_ins"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_check_ins_job_id_business_id_key" ON "job_check_ins"("job_id", "business_id");

-- CreateIndex
CREATE INDEX "job_notes_business_id_job_id_created_at_idx" ON "job_notes"("business_id", "job_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_photos_file_id_key" ON "job_photos"("file_id");

-- CreateIndex
CREATE INDEX "job_photos_business_id_job_id_created_at_idx" ON "job_photos"("business_id", "job_id", "created_at");

-- CreateIndex
CREATE INDEX "job_photos_business_id_vehicle_id_created_at_idx" ON "job_photos"("business_id", "vehicle_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "inspections_job_id_key" ON "inspections"("job_id");

-- CreateIndex
CREATE INDEX "inspections_business_id_vehicle_id_completed_at_idx" ON "inspections"("business_id", "vehicle_id", "completed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "inspections_id_business_id_key" ON "inspections"("id", "business_id");

-- CreateIndex
CREATE INDEX "inspection_items_business_id_inspection_id_idx" ON "inspection_items"("business_id", "inspection_id");

-- CreateIndex
CREATE UNIQUE INDEX "inspection_items_id_business_id_key" ON "inspection_items"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "inspection_items_inspection_id_item_key_key" ON "inspection_items"("inspection_id", "item_key");

-- CreateIndex
CREATE INDEX "diagnoses_business_id_vehicle_id_recorded_at_idx" ON "diagnoses"("business_id", "vehicle_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "diagnoses_business_id_job_id_idx" ON "diagnoses"("business_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "diagnoses_id_business_id_key" ON "diagnoses"("id", "business_id");

-- CreateIndex
CREATE INDEX "recommended_work_items_business_id_job_id_idx" ON "recommended_work_items"("business_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "recommended_work_items_id_business_id_key" ON "recommended_work_items"("id", "business_id");

-- CreateIndex
CREATE INDEX "job_parts_business_id_job_id_idx" ON "job_parts"("business_id", "job_id");

-- CreateIndex
CREATE INDEX "job_labour_business_id_job_id_idx" ON "job_labour"("business_id", "job_id");

-- CreateIndex
CREATE INDEX "job_quality_checks_business_id_job_id_created_at_idx" ON "job_quality_checks"("business_id", "job_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_events_business_id_customer_id_created_at_idx" ON "activity_events"("business_id", "customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "activity_events_business_id_vehicle_id_created_at_idx" ON "activity_events"("business_id", "vehicle_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "activity_events_business_id_job_id_created_at_idx" ON "activity_events"("business_id", "job_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "memberships_id_business_id_key" ON "memberships"("id", "business_id");

-- CreateIndex
CREATE UNIQUE INDEX "files_id_business_id_key" ON "files"("id", "business_id");

-- CreateIndex
CREATE INDEX "customers_business_id_status_created_at_idx" ON "customers"("business_id", "status", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_customer_id_business_id_fkey" FOREIGN KEY ("customer_id", "business_id") REFERENCES "customers"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_contacts" ADD CONSTRAINT "vehicle_contacts_vehicle_id_business_id_fkey" FOREIGN KEY ("vehicle_id", "business_id") REFERENCES "vehicles"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_mileage_log" ADD CONSTRAINT "vehicle_mileage_log_vehicle_id_business_id_fkey" FOREIGN KEY ("vehicle_id", "business_id") REFERENCES "vehicles"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_intervals" ADD CONSTRAINT "service_intervals_vehicle_id_business_id_fkey" FOREIGN KEY ("vehicle_id", "business_id") REFERENCES "vehicles"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_business_id_fkey" FOREIGN KEY ("customer_id", "business_id") REFERENCES "customers"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_vehicle_id_business_id_fkey" FOREIGN KEY ("vehicle_id", "business_id") REFERENCES "vehicles"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_booking_id_business_id_fkey" FOREIGN KEY ("booking_id", "business_id") REFERENCES "bookings"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_customer_id_business_id_fkey" FOREIGN KEY ("customer_id", "business_id") REFERENCES "customers"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_vehicle_id_business_id_fkey" FOREIGN KEY ("vehicle_id", "business_id") REFERENCES "vehicles"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_booking_id_business_id_fkey" FOREIGN KEY ("booking_id", "business_id") REFERENCES "bookings"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_technicians" ADD CONSTRAINT "job_technicians_job_id_business_id_fkey" FOREIGN KEY ("job_id", "business_id") REFERENCES "job_cards"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_check_ins" ADD CONSTRAINT "job_check_ins_job_id_business_id_fkey" FOREIGN KEY ("job_id", "business_id") REFERENCES "job_cards"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_notes" ADD CONSTRAINT "job_notes_job_id_business_id_fkey" FOREIGN KEY ("job_id", "business_id") REFERENCES "job_cards"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_photos" ADD CONSTRAINT "job_photos_job_id_business_id_fkey" FOREIGN KEY ("job_id", "business_id") REFERENCES "job_cards"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_job_id_business_id_vehicle_id_customer_id_fkey" FOREIGN KEY ("job_id", "business_id", "vehicle_id", "customer_id") REFERENCES "job_cards"("id", "business_id", "vehicle_id", "customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspection_items" ADD CONSTRAINT "inspection_items_inspection_id_business_id_fkey" FOREIGN KEY ("inspection_id", "business_id") REFERENCES "inspections"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_job_id_business_id_vehicle_id_customer_id_fkey" FOREIGN KEY ("job_id", "business_id", "vehicle_id", "customer_id") REFERENCES "job_cards"("id", "business_id", "vehicle_id", "customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommended_work_items" ADD CONSTRAINT "recommended_work_items_job_id_business_id_fkey" FOREIGN KEY ("job_id", "business_id") REFERENCES "job_cards"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_parts" ADD CONSTRAINT "job_parts_job_id_business_id_fkey" FOREIGN KEY ("job_id", "business_id") REFERENCES "job_cards"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_labour" ADD CONSTRAINT "job_labour_job_id_business_id_fkey" FOREIGN KEY ("job_id", "business_id") REFERENCES "job_cards"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_quality_checks" ADD CONSTRAINT "job_quality_checks_job_id_business_id_fkey" FOREIGN KEY ("job_id", "business_id") REFERENCES "job_cards"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written part of 0005: foreign keys Prisma does not model, integrity
-- checks, uniqueness, search indexes, row-level security, append-only tables,
-- permission-style triggers and backfills.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ───────── Foreign keys that are composite so a link can never cross businesses ─────────
ALTER TABLE service_types ADD CONSTRAINT service_types_business_fk FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE bays ADD CONSTRAINT bays_business_fk FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE bays ADD CONSTRAINT bays_location_fk FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE workshop_settings ADD CONSTRAINT workshop_settings_business_fk FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE workshop_hours ADD CONSTRAINT workshop_hours_business_fk FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE technician_schedules ADD CONSTRAINT technician_schedules_member_fk FOREIGN KEY (membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;
ALTER TABLE technician_time_off ADD CONSTRAINT technician_time_off_member_fk FOREIGN KEY (membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;

ALTER TABLE service_intervals ADD CONSTRAINT service_intervals_type_fk FOREIGN KEY (service_type_id, business_id) REFERENCES service_types(id, business_id) ON DELETE RESTRICT;
ALTER TABLE vehicle_mileage_log ADD CONSTRAINT vehicle_mileage_job_fk FOREIGN KEY (job_id, business_id) REFERENCES job_cards(id, business_id) ON DELETE RESTRICT;
ALTER TABLE vehicle_mileage_log ADD CONSTRAINT vehicle_mileage_booking_fk FOREIGN KEY (booking_id, business_id) REFERENCES bookings(id, business_id) ON DELETE RESTRICT;

ALTER TABLE recurring_booking_rules ADD CONSTRAINT recurring_rules_business_fk FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE recurring_booking_rules ADD CONSTRAINT recurring_rules_customer_fk FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id) ON DELETE RESTRICT;
ALTER TABLE recurring_booking_rules ADD CONSTRAINT recurring_rules_vehicle_fk FOREIGN KEY (vehicle_id, business_id) REFERENCES vehicles(id, business_id) ON DELETE RESTRICT;
ALTER TABLE recurring_booking_rules ADD CONSTRAINT recurring_rules_type_fk FOREIGN KEY (service_type_id, business_id) REFERENCES service_types(id, business_id) ON DELETE RESTRICT;
ALTER TABLE recurring_booking_rules ADD CONSTRAINT recurring_rules_tech_fk FOREIGN KEY (technician_membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;
ALTER TABLE recurring_booking_rules ADD CONSTRAINT recurring_rules_bay_fk FOREIGN KEY (bay_id, business_id) REFERENCES bays(id, business_id) ON DELETE RESTRICT;
ALTER TABLE recurring_booking_rules ADD CONSTRAINT recurring_rules_location_fk FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;

ALTER TABLE bookings ADD CONSTRAINT bookings_type_fk FOREIGN KEY (service_type_id, business_id) REFERENCES service_types(id, business_id) ON DELETE RESTRICT;
ALTER TABLE bookings ADD CONSTRAINT bookings_tech_fk FOREIGN KEY (technician_membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;
ALTER TABLE bookings ADD CONSTRAINT bookings_bay_fk FOREIGN KEY (bay_id, business_id) REFERENCES bays(id, business_id) ON DELETE RESTRICT;
ALTER TABLE bookings ADD CONSTRAINT bookings_location_fk FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE bookings ADD CONSTRAINT bookings_rule_fk FOREIGN KEY (recurring_rule_id, business_id) REFERENCES recurring_booking_rules(id, business_id) ON DELETE RESTRICT;

ALTER TABLE waiting_list_entries ADD CONSTRAINT waiting_business_fk FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE waiting_list_entries ADD CONSTRAINT waiting_customer_fk FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id) ON DELETE RESTRICT;
ALTER TABLE waiting_list_entries ADD CONSTRAINT waiting_vehicle_fk FOREIGN KEY (vehicle_id, business_id) REFERENCES vehicles(id, business_id) ON DELETE RESTRICT;
ALTER TABLE waiting_list_entries ADD CONSTRAINT waiting_type_fk FOREIGN KEY (service_type_id, business_id) REFERENCES service_types(id, business_id) ON DELETE RESTRICT;
ALTER TABLE waiting_list_entries ADD CONSTRAINT waiting_booking_fk FOREIGN KEY (booking_id, business_id) REFERENCES bookings(id, business_id) ON DELETE RESTRICT;

ALTER TABLE job_cards ADD CONSTRAINT job_cards_type_fk FOREIGN KEY (service_type_id, business_id) REFERENCES service_types(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_cards ADD CONSTRAINT job_cards_tech_fk FOREIGN KEY (primary_technician_membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_cards ADD CONSTRAINT job_cards_advisor_fk FOREIGN KEY (advisor_membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_cards ADD CONSTRAINT job_cards_location_fk FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_cards ADD CONSTRAINT job_cards_bay_fk FOREIGN KEY (bay_id, business_id) REFERENCES bays(id, business_id) ON DELETE RESTRICT;

ALTER TABLE job_technicians ADD CONSTRAINT job_technicians_member_fk FOREIGN KEY (membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_check_ins ADD CONSTRAINT job_check_ins_signature_fk FOREIGN KEY (signature_file_id, business_id) REFERENCES files(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_photos ADD CONSTRAINT job_photos_file_fk FOREIGN KEY (file_id, business_id) REFERENCES files(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_photos ADD CONSTRAINT job_photos_vehicle_fk FOREIGN KEY (vehicle_id, business_id) REFERENCES vehicles(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_photos ADD CONSTRAINT job_photos_item_fk FOREIGN KEY (inspection_item_id, business_id) REFERENCES inspection_items(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_photos ADD CONSTRAINT job_photos_diagnosis_fk FOREIGN KEY (diagnosis_id, business_id) REFERENCES diagnoses(id, business_id) ON DELETE RESTRICT;
ALTER TABLE inspections ADD CONSTRAINT inspections_tech_fk FOREIGN KEY (technician_membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;
ALTER TABLE diagnoses ADD CONSTRAINT diagnoses_tech_fk FOREIGN KEY (technician_membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;
ALTER TABLE recommended_work_items ADD CONSTRAINT rec_work_item_fk FOREIGN KEY (source_inspection_item_id, business_id) REFERENCES inspection_items(id, business_id) ON DELETE RESTRICT;
ALTER TABLE recommended_work_items ADD CONSTRAINT rec_work_diag_fk FOREIGN KEY (source_diagnosis_id, business_id) REFERENCES diagnoses(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_parts ADD CONSTRAINT job_parts_work_fk FOREIGN KEY (recommended_work_id, business_id) REFERENCES recommended_work_items(id, business_id) ON DELETE RESTRICT;
ALTER TABLE job_labour ADD CONSTRAINT job_labour_tech_fk FOREIGN KEY (technician_membership_id, business_id) REFERENCES memberships(id, business_id) ON DELETE RESTRICT;

ALTER TABLE activity_events ADD CONSTRAINT activity_business_fk FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT;
ALTER TABLE activity_events ADD CONSTRAINT activity_customer_fk FOREIGN KEY (customer_id, business_id) REFERENCES customers(id, business_id) ON DELETE RESTRICT;
ALTER TABLE activity_events ADD CONSTRAINT activity_vehicle_fk FOREIGN KEY (vehicle_id, business_id) REFERENCES vehicles(id, business_id) ON DELETE RESTRICT;
ALTER TABLE activity_events ADD CONSTRAINT activity_job_fk FOREIGN KEY (job_id, business_id) REFERENCES job_cards(id, business_id) ON DELETE RESTRICT;

-- A job and its booking must describe the same customer and vehicle.
CREATE OR REPLACE FUNCTION job_booking_consistency() RETURNS trigger AS $$
DECLARE b RECORD;
BEGIN
  IF NEW.booking_id IS NULL THEN RETURN NEW; END IF;
  SELECT customer_id, vehicle_id INTO b FROM bookings WHERE id = NEW.booking_id AND business_id = NEW.business_id;
  IF b.customer_id IS DISTINCT FROM NEW.customer_id OR b.vehicle_id IS DISTINCT FROM NEW.vehicle_id THEN
    RAISE EXCEPTION 'job card customer/vehicle must match its booking' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER job_cards_booking_consistency BEFORE INSERT OR UPDATE OF booking_id, customer_id, vehicle_id ON job_cards
  FOR EACH ROW EXECUTE FUNCTION job_booking_consistency();

-- ───────── Integrity checks ─────────
ALTER TABLE service_types ADD CONSTRAINT service_types_duration_chk CHECK (default_duration_min BETWEEN 5 AND 1440);
CREATE UNIQUE INDEX service_types_name_uniq ON service_types (business_id, lower(name)) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX bays_name_uniq ON bays (business_id, lower(name)) WHERE status = 'ACTIVE';
ALTER TABLE workshop_settings ADD CONSTRAINT workshop_settings_conc_chk CHECK (max_concurrent_jobs IS NULL OR max_concurrent_jobs >= 1);
ALTER TABLE workshop_hours ADD CONSTRAINT workshop_hours_chk CHECK (weekday BETWEEN 0 AND 6 AND start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute);
ALTER TABLE technician_schedules ADD CONSTRAINT technician_schedules_chk CHECK (weekday BETWEEN 0 AND 6 AND start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute);
ALTER TABLE technician_time_off ADD CONSTRAINT technician_time_off_chk CHECK (ends_at > starts_at);

ALTER TABLE vehicles ADD CONSTRAINT vehicles_year_chk CHECK (year IS NULL OR year BETWEEN 1900 AND 2100);
ALTER TABLE vehicles ADD CONSTRAINT vehicles_mileage_chk CHECK (mileage_km IS NULL OR mileage_km BETWEEN 0 AND 5000000);
-- Registration / VIN are unique per business among live (not archived) vehicles; two businesses may hold the same plate.
CREATE UNIQUE INDEX vehicles_registration_uniq ON vehicles (business_id, registration_norm) WHERE registration_norm IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX vehicles_vin_uniq ON vehicles (business_id, vin) WHERE vin IS NOT NULL AND archived_at IS NULL;
CREATE INDEX vehicles_reg_trgm ON vehicles USING gin (registration_norm gin_trgm_ops);
CREATE INDEX vehicles_vin_trgm ON vehicles USING gin (vin gin_trgm_ops);
CREATE INDEX vehicles_make_trgm ON vehicles USING gin (make gin_trgm_ops);
CREATE INDEX vehicles_model_trgm ON vehicles USING gin (model gin_trgm_ops);

ALTER TABLE vehicle_mileage_log ADD CONSTRAINT vehicle_mileage_chk CHECK (mileage_km BETWEEN 0 AND 5000000);
ALTER TABLE service_intervals ADD CONSTRAINT service_intervals_chk CHECK ((every_km IS NOT NULL AND every_km > 0) OR (every_months IS NOT NULL AND every_months > 0));

ALTER TABLE recurring_booking_rules ADD CONSTRAINT recurring_rules_chk CHECK (
  interval_count BETWEEN 1 AND 52 AND duration_min BETWEEN 5 AND 1440 AND start_minute BETWEEN 0 AND 1439
  AND (end_date IS NOT NULL OR occurrences IS NOT NULL) AND (occurrences IS NULL OR occurrences BETWEEN 1 AND 104)
  AND (end_date IS NULL OR end_date >= start_date));

ALTER TABLE bookings ADD CONSTRAINT bookings_time_chk CHECK (ends_at > starts_at AND duration_min BETWEEN 5 AND 1440);
-- A physical bay cannot hold two live appointments at once (always true, so enforced by the database itself).
ALTER TABLE bookings ADD CONSTRAINT bookings_bay_no_overlap EXCLUDE USING gist (
  bay_id WITH =, tstzrange(starts_at, ends_at) WITH &&
) WHERE (bay_id IS NOT NULL AND status NOT IN ('CANCELLED', 'NO_SHOW'));
CREATE INDEX bookings_active_range ON bookings USING gist (tstzrange(starts_at, ends_at)) WHERE status NOT IN ('CANCELLED', 'NO_SHOW');

ALTER TABLE waiting_list_entries ADD CONSTRAINT waiting_pref_chk CHECK (
  (preferred_start_minute IS NULL AND preferred_end_minute IS NULL)
  OR (preferred_start_minute IS NOT NULL AND preferred_end_minute IS NOT NULL AND preferred_start_minute < preferred_end_minute));

ALTER TABLE job_cards ADD CONSTRAINT job_cards_mileage_chk CHECK ((mileage_in_km IS NULL OR mileage_in_km >= 0) AND (mileage_out_km IS NULL OR mileage_out_km >= 0));
CREATE INDEX job_cards_number_trgm ON job_cards USING gin (job_number gin_trgm_ops);
ALTER TABLE job_cards ADD CONSTRAINT job_cards_hold_chk CHECK (status <> 'ON_HOLD' OR held_from_status IS NOT NULL);
ALTER TABLE inspection_items ADD CONSTRAINT inspection_items_label_chk CHECK (length(btrim(label)) > 0);
ALTER TABLE recommended_work_items ADD CONSTRAINT rec_work_chk CHECK (
  quantity >= 1 AND (estimated_minutes IS NULL OR estimated_minutes >= 0)
  AND (estimated_labour_cents IS NULL OR estimated_labour_cents >= 0) AND (estimated_parts_cents IS NULL OR estimated_parts_cents >= 0));
ALTER TABLE job_parts ADD CONSTRAINT job_parts_chk CHECK (quantity >= 1 AND (cost_cents IS NULL OR cost_cents >= 0) AND (sell_price_cents IS NULL OR sell_price_cents >= 0));
ALTER TABLE job_labour ADD CONSTRAINT job_labour_chk CHECK (minutes BETWEEN 1 AND 10080 AND (rate_cents_per_hour IS NULL OR rate_cents_per_hour >= 0) AND (total_cents IS NULL OR total_cents >= 0));
CREATE INDEX job_cards_complaint_idx ON job_cards (business_id, status) WHERE status NOT IN ('COMPLETED', 'CANCELLED');

-- ───────── Customers: search indexes for the renamed/new columns ─────────
CREATE INDEX customers_first_trgm ON customers USING gin (first_name gin_trgm_ops);
CREATE INDEX customers_last_trgm ON customers USING gin (last_name gin_trgm_ops);

-- ───────── Append-only tables: history is never edited or deleted ─────────
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER vehicle_mileage_log_append_only BEFORE UPDATE OR DELETE ON vehicle_mileage_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER booking_events_append_only BEFORE UPDATE OR DELETE ON booking_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER job_quality_checks_append_only BEFORE UPDATE OR DELETE ON job_quality_checks FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER activity_events_append_only BEFORE UPDATE OR DELETE ON activity_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ───────── Row-level security: every new table, forced, fails closed ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'service_types','bays','workshop_settings','workshop_hours','technician_schedules','technician_time_off',
    'vehicles','vehicle_contacts','vehicle_mileage_log','service_intervals','recurring_booking_rules','bookings',
    'booking_events','waiting_list_entries','job_cards','job_technicians','job_check_ins','job_notes','job_photos',
    'inspections','inspection_items','diagnoses','recommended_work_items','job_parts','job_labour',
    'job_quality_checks','activity_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (business_id = app_current_business())
      WITH CHECK (business_id = app_current_business())$p$, t);
  END LOOP;
END $$;

-- ───────── Backfill: defaults for businesses that already exist ─────────
INSERT INTO service_types (business_id, name, default_duration_min, sort_order, updated_at)
SELECT b.id, s.name, s.mins, s.ord, now() FROM businesses b
CROSS JOIN (VALUES ('Minor service', 120, 1), ('Major service', 240, 2), ('Diagnostic', 60, 3), ('Brake service', 120, 4), ('Tyres and alignment', 60, 5)) AS s(name, mins, ord);
INSERT INTO workshop_hours (business_id, weekday, start_minute, end_minute)
SELECT b.id, d.wd, 480, 1020 FROM businesses b CROSS JOIN (VALUES (1), (2), (3), (4), (5)) AS d(wd);
INSERT INTO workshop_settings (business_id, updated_at) SELECT id, now() FROM businesses;
UPDATE number_sequences SET prefix = 'CUS' WHERE kind = 'customer';
