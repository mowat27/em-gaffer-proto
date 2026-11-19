CREATE TABLE IF NOT EXISTS "public"."client_directory"
(
    client_id     TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    contact_email TEXT NOT NULL
);
