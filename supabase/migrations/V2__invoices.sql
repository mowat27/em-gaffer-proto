-- Invoices read model (slice: invoicing/Invoices).
-- Fields exactly as in slice.json: invoiceId (UUID, id attribute), clientName, date, amount
-- (Decimal), status - all non-optional, so NOT NULL. Column names are snake_case.
-- Board decision comment: "InvoiceCreated carries no status, so the Invoices projection sets
-- status 'Created'; clientName comes from a private clientId->name lookup fed by ClientCreated",
-- hence the companion lookup table below.
CREATE TABLE IF NOT EXISTS "public"."invoices"
(
    invoice_id  TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    date        DATE NOT NULL,
    amount      NUMERIC NOT NULL,
    status      TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW()
);

-- Private clientId -> name lookup table, fed by ClientCreated events and read by the
-- InvoiceCreated handler to resolve the clientName column of the invoices read model.
CREATE TABLE IF NOT EXISTS "public"."invoices_client_names"
(
    client_id   TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW()
);
