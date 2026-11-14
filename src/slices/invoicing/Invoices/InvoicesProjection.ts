import {postgreSQLRawSQLProjection} from '@event-driven-io/emmett-postgresql';
import {sql, SQL} from '@event-driven-io/dumbo';
import knex, {Knex} from 'knex';

export const tableName = 'invoices';

// Private clientId -> name lookup table (board decision comment: "clientName comes from a private
// clientId->name lookup fed by ClientCreated").
export const clientLookupTableName = 'invoices_client_names';

// TypeScript shape of one row in the read model.
// Fields exactly as in slice.json: invoiceId (UUID, id attribute), clientName, date, amount, status.
export type InvoicesReadModel = {
    invoiceId: string;
    clientName: string;
    date: string;
    amount: number;
    status: string;
};

export const getKnexInstance = (connectionString: string): Knex =>
    knex({client: 'pg', connection: connectionString, pool: {min: 0, max: 1}});

// Assumption: no shared InvoicingEvents module exists yet, so the event types are declared here.
// ClientCreated payload {clientId, name, contactEmail} mirrors the Clients slice (see its
// projection); its `name` feeds the private clientId -> name lookup.
export type ClientCreated = {
    type: 'ClientCreated';
    data: {
        clientId: string;
        name: string;
        contactEmail: string;
    };
};

// Assumption: InvoiceCreated carries invoiceId, clientId, date and amount, but no status (board
// decision comment: "InvoiceCreated carries no status, so the Invoices projection sets status
// 'Created'"). clientId is what the ClientCreated lookup is keyed on.
export type InvoiceCreated = {
    type: 'InvoiceCreated';
    data: {
        invoiceId: string;
        clientId: string;
        date: string;
        amount: number;
    };
};

type InvoicesEvents = ClientCreated | InvoiceCreated;

export const InvoicesProjection = postgreSQLRawSQLProjection<InvoicesEvents>({
    name: 'InvoicesProjection',
    canHandle: ['ClientCreated', 'InvoiceCreated'],
    evolve: async (event, context): Promise<SQL[]> => {
        const db = getKnexInstance(context.connection.connectionString);

        try {
            switch (event.type) {
                case 'ClientCreated':
                    // Upsert into the private clientId -> name lookup; no invoices row yet.
                    return [sql(db(clientLookupTableName)
                        .withSchema('public')
                        .insert({
                            client_id:   event.data.clientId,
                            client_name: event.data.name,
                        })
                        .onConflict('client_id')
                        .merge(['client_name'])
                        .toQuery())];

                case 'InvoiceCreated': {
                    // Resolve the client name from the private lookup before inserting the row.
                    const client = await db(clientLookupTableName)
                        .withSchema('public')
                        .where({client_id: event.data.clientId})
                        .select('client_name')
                        .first();

                    // Assumption: when no ClientCreated has been seen for the clientId, the name
                    // falls back to an empty string (the field is non-optional in slice.json).
                    const clientName = client?.client_name ?? '';

                    // Insert with upsert: one invoice row per InvoiceCreated event.
                    // status is set to 'Created' because InvoiceCreated carries no status.
                    return [sql(db(tableName)
                        .withSchema('public')
                        .insert({
                            invoice_id:  event.data.invoiceId,
                            client_name: clientName,
                            date:        event.data.date,
                            amount:      event.data.amount,
                            status:      'Created',
                        })
                        .onConflict('invoice_id')
                        .merge(['client_name', 'date', 'amount', 'status'])
                        .toQuery())];
                }

                default:
                    return [];
            }
        } finally {
            await db.destroy();
        }
    },
});
