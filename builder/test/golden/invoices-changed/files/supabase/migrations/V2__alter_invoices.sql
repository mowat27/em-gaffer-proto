-- Invoices changed since its last build. New columns are nullable: rows projected before them have no value.
ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS due_date DATE;
