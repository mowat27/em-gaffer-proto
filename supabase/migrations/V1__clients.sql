-- Clients read model (slice: invoicing/Clients).
-- Table 'clients' per the board decision comment: "used table 'clients' from backend migration
-- V1__clients.sql". clientId (the slice's id attribute, type UUID) is the primary key column
-- client_id; name and contact_email are NOT NULL (all fields are non-optional in slice.json).
CREATE TABLE IF NOT EXISTS "public"."clients"
(
    client_id     TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    created_at    TIMESTAMP DEFAULT NOW()
);
