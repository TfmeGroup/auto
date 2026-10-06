-- Part 7: reports, business settings, workshop configuration, imports and administration.
-- Everything here is additive: no existing column or row is rewritten.

-- ───────── One configuration row per business (numbering, labour rules, job / vehicle / inventory options, report and security preferences) ─────────
CREATE TABLE "business_config" (
    "business_id" UUID NOT NULL,
    "customer_prefix" TEXT NOT NULL DEFAULT 'CUS',
    "booking_prefix" TEXT NOT NULL DEFAULT 'BKG',
    "job_prefix" TEXT NOT NULL DEFAULT 'JOB',
    "customer_padding" INTEGER NOT NULL DEFAULT 6,
    "booking_padding" INTEGER NOT NULL DEFAULT 6,
    "job_padding" INTEGER NOT NULL DEFAULT 7,
    "min_billable_minutes" INTEGER NOT NULL DEFAULT 0,
    "time_rounding_minutes" INTEGER NOT NULL DEFAULT 0,
    "time_rounding_mode" TEXT NOT NULL DEFAULT 'UP',
    "job_status_labels" JSONB NOT NULL DEFAULT '{}',
    "retired_job_statuses" TEXT[] NOT NULL DEFAULT '{}',
    "priority_labels" JSONB NOT NULL DEFAULT '{}',
    "job_required_fields" TEXT[] NOT NULL DEFAULT '{}',
    "vehicle_required_fields" TEXT[] NOT NULL DEFAULT '{}',
    "vehicle_mileage_required" BOOLEAN NOT NULL DEFAULT false,
    "enabled_fuel_types" TEXT[] NOT NULL DEFAULT '{}',
    "enabled_transmissions" TEXT[] NOT NULL DEFAULT '{}',
    "enabled_drive_types" TEXT[] NOT NULL DEFAULT '{}',
    "default_interval_km" INTEGER,
    "default_interval_months" INTEGER,
    "default_reorder_quantity" INTEGER,
    "default_markup_bps" INTEGER,
    "report_default_range" TEXT NOT NULL DEFAULT 'THIS_MONTH',
    "report_default_format" TEXT NOT NULL DEFAULT 'CSV',
    "slow_moving_days" INTEGER NOT NULL DEFAULT 90,
    "lapsed_customer_days" INTEGER NOT NULL DEFAULT 180,
    "dashboard_hidden_kpis" TEXT[] NOT NULL DEFAULT '{}',
    "session_max_hours" INTEGER,
    "invitation_expiry_days" INTEGER,
    "report_run_retention_days" INTEGER NOT NULL DEFAULT 90,
    "import_retention_days" INTEGER NOT NULL DEFAULT 30,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "business_config_pkey" PRIMARY KEY ("business_id")
);

-- ───────── Booking rules ─────────
ALTER TABLE "workshop_settings"
  ADD COLUMN "buffer_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "min_lead_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cancel_window_hours" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "max_daily_bookings" INTEGER,
  ADD COLUMN "allow_walk_ins" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "waiting_list_enabled" BOOLEAN NOT NULL DEFAULT true;

-- ───────── Service catalogue ─────────
ALTER TABLE "service_types"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "default_price_cents" INTEGER,
  ADD COLUMN "tax_treatment" "tax_treatment" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "checklist" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "default_parts" JSONB NOT NULL DEFAULT '[]';

-- ───────── Job templates (copied into a job when it is created; never a live link) ─────────
CREATE TABLE "job_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "service_type_id" UUID,
    "estimated_minutes" INTEGER,
    "checklist" TEXT[] NOT NULL DEFAULT '{}',
    "labour" JSONB NOT NULL DEFAULT '[]',
    "parts" JSONB NOT NULL DEFAULT '[]',
    "inspection_fields" TEXT[] NOT NULL DEFAULT '{}',
    "status" "record_status" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "job_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "job_templates_id_business_id_key" ON "job_templates"("id", "business_id");
CREATE INDEX "job_templates_business_id_status_idx" ON "job_templates"("business_id", "status");

-- ───────── Locations carry their own contact details ─────────
ALTER TABLE "locations"
  ADD COLUMN "address_line1" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "province" TEXT,
  ADD COLUMN "postal_code" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "email" TEXT;

-- ───────── Saved reports, schedules and their runs ─────────
CREATE TABLE "saved_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "report_key" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "owner_membership_id" UUID NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "shared_role_ids" UUID[] NOT NULL DEFAULT '{}',
    "shared_membership_ids" UUID[] NOT NULL DEFAULT '{}',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "saved_reports_id_business_id_key" ON "saved_reports"("id", "business_id");
CREATE INDEX "saved_reports_business_id_owner_idx" ON "saved_reports"("business_id", "owner_membership_id");

CREATE TABLE "report_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "saved_report_id" UUID NOT NULL,
    "frequency" TEXT NOT NULL,
    "weekday" INTEGER,
    "month_day" INTEGER,
    "hour" INTEGER NOT NULL DEFAULT 7,
    "format" TEXT NOT NULL DEFAULT 'CSV',
    "recipient_membership_ids" UUID[] NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "next_run_at" TIMESTAMPTZ(3) NOT NULL,
    "last_run_at" TIMESTAMPTZ(3),
    "last_status" TEXT,
    "created_by_membership_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "report_schedules_id_business_id_key" ON "report_schedules"("id", "business_id");
CREATE INDEX "report_schedules_due_idx" ON "report_schedules"("status", "next_run_at");
CREATE INDEX "report_schedules_business_id_idx" ON "report_schedules"("business_id");

CREATE TABLE "report_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "recipients_sent" INTEGER NOT NULL DEFAULT 0,
    "recipients_skipped" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "detail" JSONB,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "report_runs_schedule_due_key" ON "report_runs"("schedule_id", "due_at");
CREATE INDEX "report_runs_business_id_created_idx" ON "report_runs"("business_id", "created_at" DESC);

-- ───────── Imports (staged: nothing is written to real records until the person confirms) ─────────
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "file_name" TEXT NOT NULL,
    "headers" TEXT[] NOT NULL DEFAULT '{}',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "options" JSONB NOT NULL DEFAULT '{}',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "invalid_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "warning_rows" INTEGER NOT NULL DEFAULT 0,
    "imported_rows" INTEGER NOT NULL DEFAULT 0,
    "skipped_rows" INTEGER NOT NULL DEFAULT 0,
    "failed_rows" INTEGER NOT NULL DEFAULT 0,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "import_batches_id_business_id_key" ON "import_batches"("id", "business_id");
CREATE INDEX "import_batches_business_id_created_idx" ON "import_batches"("business_id", "created_at" DESC);

CREATE TABLE "import_rows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "values" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errors" TEXT[] NOT NULL DEFAULT '{}',
    "warnings" TEXT[] NOT NULL DEFAULT '{}',
    "duplicate_of" TEXT,
    "record_id" UUID,
    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "import_rows_batch_row_key" ON "import_rows"("batch_id", "row_number");
CREATE INDEX "import_rows_batch_status_idx" ON "import_rows"("batch_id", "status");

-- ───────── Foreign keys ─────────
ALTER TABLE "business_config" ADD CONSTRAINT "business_config_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_templates" ADD CONSTRAINT "job_templates_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "job_templates" ADD CONSTRAINT "job_templates_service_fkey" FOREIGN KEY ("service_type_id", "business_id") REFERENCES "service_types"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_report_fkey" FOREIGN KEY ("saved_report_id", "business_id") REFERENCES "saved_reports"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_schedule_fkey" FOREIGN KEY ("schedule_id", "business_id") REFERENCES "report_schedules"("id", "business_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_fkey" FOREIGN KEY ("batch_id", "business_id") REFERENCES "import_batches"("id", "business_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────── Value checks (a malformed setting can never be stored, whatever wrote it) ─────────
ALTER TABLE business_config ADD CONSTRAINT business_config_numbering_chk CHECK (
  customer_prefix ~ '^[A-Z0-9]{1,8}$' AND booking_prefix ~ '^[A-Z0-9]{1,8}$' AND job_prefix ~ '^[A-Z0-9]{1,8}$'
  AND customer_padding BETWEEN 1 AND 10 AND booking_padding BETWEEN 1 AND 10 AND job_padding BETWEEN 1 AND 10);
ALTER TABLE business_config ADD CONSTRAINT business_config_labour_chk CHECK (
  min_billable_minutes BETWEEN 0 AND 480 AND time_rounding_minutes IN (0, 5, 10, 15, 30, 60) AND time_rounding_mode IN ('UP', 'NEAREST'));
ALTER TABLE business_config ADD CONSTRAINT business_config_other_chk CHECK (
  (default_interval_km IS NULL OR default_interval_km BETWEEN 100 AND 200000)
  AND (default_interval_months IS NULL OR default_interval_months BETWEEN 1 AND 120)
  AND (default_reorder_quantity IS NULL OR default_reorder_quantity BETWEEN 1 AND 1000000)
  AND (default_markup_bps IS NULL OR default_markup_bps BETWEEN 0 AND 100000)
  AND report_default_range IN ('TODAY', 'YESTERDAY', 'THIS_WEEK', 'LAST_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'THIS_QUARTER', 'THIS_YEAR', 'LAST_YEAR')
  AND report_default_format IN ('CSV', 'XLSX', 'PDF')
  AND slow_moving_days BETWEEN 14 AND 730 AND lapsed_customer_days BETWEEN 30 AND 1095
  AND (session_max_hours IS NULL OR session_max_hours BETWEEN 1 AND 720)
  AND (invitation_expiry_days IS NULL OR invitation_expiry_days BETWEEN 1 AND 30)
  AND report_run_retention_days BETWEEN 7 AND 3650 AND import_retention_days BETWEEN 1 AND 365);
ALTER TABLE workshop_settings ADD CONSTRAINT workshop_settings_rules_chk CHECK (
  buffer_minutes BETWEEN 0 AND 240 AND min_lead_minutes BETWEEN 0 AND 10080 AND cancel_window_hours BETWEEN 0 AND 720 AND (max_daily_bookings IS NULL OR max_daily_bookings BETWEEN 1 AND 1000));
ALTER TABLE service_types ADD CONSTRAINT service_types_catalogue_chk CHECK (default_price_cents IS NULL OR default_price_cents BETWEEN 0 AND 100000000);
ALTER TABLE job_templates ADD CONSTRAINT job_templates_chk CHECK (estimated_minutes IS NULL OR estimated_minutes BETWEEN 5 AND 10080);
ALTER TABLE saved_reports ADD CONSTRAINT saved_reports_chk CHECK (kind IN ('STANDARD', 'CUSTOM') AND visibility IN ('PRIVATE', 'SHARED', 'BUSINESS') AND (kind = 'CUSTOM' OR report_key IS NOT NULL));
ALTER TABLE report_schedules ADD CONSTRAINT report_schedules_chk CHECK (
  frequency IN ('DAILY', 'WEEKLY', 'MONTHLY') AND hour BETWEEN 0 AND 23 AND format IN ('CSV', 'XLSX', 'PDF') AND status IN ('ACTIVE', 'PAUSED')
  AND (frequency <> 'WEEKLY' OR weekday BETWEEN 0 AND 6) AND (frequency <> 'MONTHLY' OR month_day BETWEEN 1 AND 28));
ALTER TABLE report_runs ADD CONSTRAINT report_runs_chk CHECK (status IN ('QUEUED', 'RUNNING', 'SENT', 'PARTIAL', 'FAILED'));
ALTER TABLE import_batches ADD CONSTRAINT import_batches_chk CHECK (
  kind IN ('customers', 'vehicles', 'suppliers') AND status IN ('UPLOADED', 'VALIDATED', 'PROCESSING', 'DONE', 'FAILED', 'CANCELLED'));
ALTER TABLE import_rows ADD CONSTRAINT import_rows_chk CHECK (status IN ('PENDING', 'VALID', 'INVALID', 'DUPLICATE', 'IMPORTED', 'SKIPPED', 'FAILED'));

-- ───────── Row-level security ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_config','job_templates','saved_reports','report_schedules','report_runs','import_batches','import_rows']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (business_id = app_current_business())
      WITH CHECK (business_id = app_current_business())$p$, t);
  END LOOP;
END $$;

-- ───────── Backfill ─────────
INSERT INTO business_config (business_id) SELECT id FROM businesses;
