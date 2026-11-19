import {postgreSQLRawSQLProjection} from '@event-driven-io/emmett-postgresql';
import {sql, type SQL} from '@event-driven-io/dumbo';
import knex, {type Knex} from 'knex';
import type {ClientCreated, InvoiceCreated} from '../InvoicingEvents';

export const tableName = 'invoices';
export const clientLookupTableName = 'invoices_client_lookup';

// One row of the Invoices read model: the slice's fields, in slice order.
export type InvoicesReadModel = {
    invoiceId: string;
    clientName: string;
    date: string;
    amount: number;
    status: string;
};

// Reads the table as the read model: each column under its field name (DATE as text, BIGINT and NUMERIC as numbers).
export const readModelColumns = (db: Knex) => [
    'invoice_id as invoiceId',
    'client_name as clientName',
    db.raw('??::text as ??', ['date', 'date']),
    db.raw('??::float8 as ??', ['amount', 'amount']),
    'status',
];

const getKnexInstance = (connectionString: string): Knex =>
    knex({client: 'pg', connection: connectionString, pool: {min: 0, max: 1}});

export type InvoicesEvents = ClientCreated | InvoiceCreated;

export const InvoicesProjection = postgreSQLRawSQLProjection<InvoicesEvents>({
    name: 'InvoicesProjection',
    canHandle: ['ClientCreated', 'InvoiceCreated'],
    evolve: async (event, context): Promise<SQL[]> => {
        const db = getKnexInstance(context.connection.connectionString);

        try {
            switch (event.type) {
                case 'ClientCreated':
                    // Feeds the private clientId -> name lookup that InvoiceCreated reads (the slice's comment).
                    return [sql(db(clientLookupTableName)
                        .withSchema('public')
                        .insert({
                            client_id: event.data.clientId,
                            client_name: event.data.name,
                        })
                        .onConflict('client_id')
                        .merge(['client_name'])
                        .toQuery())];

                case 'InvoiceCreated':
                    // Assumption (the slice's comment): InvoiceCreated carries no status, so a new invoice is 'Created'.
                    return [sql(db(tableName)
                        .withSchema('public')
                        .insert({
                            invoice_id: event.data.invoiceId,
                            client_name: db.raw(`COALESCE((SELECT client_name FROM public.${clientLookupTableName} WHERE client_id = ?), ?)`, [event.data.clientId, '']),
                            date: event.data.date,
                            amount: event.data.amount,
                            status: 'Created',
                        })
                        .onConflict('invoice_id')
                        .merge(['client_name', 'date', 'amount', 'status'])
                        .toQuery())];

                default:
                    return [];
            }
        } finally {
            await db.destroy();
        }
    },
});
