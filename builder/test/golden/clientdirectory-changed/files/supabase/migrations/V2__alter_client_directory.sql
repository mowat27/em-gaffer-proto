-- ClientDirectory changed since its last build. New columns are nullable: rows projected before them have no value.
ALTER TABLE "public"."client_directory" ADD COLUMN IF NOT EXISTS contact_email TEXT;
