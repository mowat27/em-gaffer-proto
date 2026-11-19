CREATE TABLE IF NOT EXISTS "public"."clients"
(
    client_id     TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    phone         TEXT
);
