CREATE TABLE IF NOT EXISTS "public"."invoices"
(
    invoice_id  TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    date        DATE NOT NULL,
    amount      NUMERIC NOT NULL,
    status      TEXT NOT NULL,
    due_date    DATE NOT NULL
);
