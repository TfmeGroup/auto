-- Part 8: integrity hardening. Two references between tenant tables did not carry business_id, so only application code
-- stopped a record pointing into another business. Make the database refuse it too. Additive: no row is rewritten; the
-- statements fail loudly (rather than silently fixing anything) if existing data already violated the rule.

CREATE UNIQUE INDEX IF NOT EXISTS "service_intervals_id_business_id_key" ON "service_intervals"("id", "business_id");

ALTER TABLE "service_reminder_log" DROP CONSTRAINT "service_reminder_log_interval_fkey";
ALTER TABLE "service_reminder_log" ADD CONSTRAINT "service_reminder_log_interval_fkey"
  FOREIGN KEY ("interval_id", "business_id") REFERENCES "service_intervals"("id", "business_id") ON DELETE RESTRICT;

ALTER TABLE "technician_service_types" DROP CONSTRAINT "technician_service_types_technician_id_fkey";
ALTER TABLE "technician_service_types" ADD CONSTRAINT "technician_service_types_technician_id_fkey"
  FOREIGN KEY ("technician_id", "business_id") REFERENCES "technician_profiles"("id", "business_id") ON DELETE CASCADE;

-- Indexes for lookups the application really makes and that had none:
--   * location scope: a member restricted to some locations has every list filtered by location_id;
--   * "payments / receipts / refunds of this job, vehicle, quote or invoice" on the record pages.
-- Partial (non-null only) because most rows of these optional links are empty. Created with IF NOT EXISTS so a re-run is harmless.
CREATE INDEX IF NOT EXISTS "job_cards_business_id_location_id_idx" ON "job_cards"("business_id", "location_id") WHERE "location_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "bookings_business_id_location_id_idx" ON "bookings"("business_id", "location_id") WHERE "location_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "quotes_business_id_location_id_idx" ON "quotes"("business_id", "location_id") WHERE "location_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "invoices_business_id_location_id_idx" ON "invoices"("business_id", "location_id") WHERE "location_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "communications_business_id_location_id_idx" ON "communications"("business_id", "location_id") WHERE "location_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "files_business_id_location_id_idx" ON "files"("business_id", "location_id") WHERE "location_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "goods_receipts_business_id_location_id_idx" ON "goods_receipts"("business_id", "location_id") WHERE "location_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "supplier_returns_business_id_location_id_idx" ON "supplier_returns"("business_id", "location_id") WHERE "location_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "payments_business_id_job_id_idx" ON "payments"("business_id", "job_id") WHERE "job_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "payments_business_id_vehicle_id_idx" ON "payments"("business_id", "vehicle_id") WHERE "vehicle_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "payments_business_id_quote_id_idx" ON "payments"("business_id", "quote_id") WHERE "quote_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "receipts_business_id_invoice_id_idx" ON "receipts"("business_id", "invoice_id") WHERE "invoice_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "refunds_business_id_invoice_id_idx" ON "refunds"("business_id", "invoice_id") WHERE "invoice_id" IS NOT NULL;
