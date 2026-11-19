-- Clients changed since its last build. New columns are nullable: rows projected before them have no value.
ALTER TABLE "public"."clients" ADD COLUMN IF NOT EXISTS phone TEXT;
