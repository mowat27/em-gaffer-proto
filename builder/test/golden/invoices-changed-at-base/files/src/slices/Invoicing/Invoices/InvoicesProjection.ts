import {postgreSQLRawSQLProjection} from '@event-driven-io/emmett-postgresql';
import {sql, type SQL} from '@event-driven-io/dumbo';
import knex, {type Knex} from 'knex';
import type {ClientCreated, InvoiceCreated} from '../InvoicingEvents';

export const tableName = 'invoices';

// One row of the Invoices read model: the slice's fields, in slice order.
export type InvoicesReadModel = {
    invoiceId: string;
    clientName: string;
    date: string;
    amount: number;
    status: string;
    dueDate: string;
};

// Reads the table as the read model: each column under its field name (DATE as text, BIGINT and NUMERIC as numbers).
export const readModelColumns = (db: Knex) => [
    'invoice_id as invoiceId',
    'client_name as clientName',
    db.raw('??::text as ??', ['date', 'date']),
    db.raw('??::float8 as ??', ['amount', 'amount']),
    'status',
    db.raw('??::text as ??', ['due_date', 'dueDate']),
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
                    // BUILD: evolve ClientCreated. ClientCreated has no invoiceId, the key of Invoices: write the statements it implies (an update by another column, a lookup table in this slice's migration), or return []
                    return [];

                case 'InvoiceCreated':
                    // BUILD: evolve InvoiceCreated. InvoiceCreated has no clientName or status: add client_name and status to the insert as the slice describes (a lookup, a default), or change the statement if InvoiceCreated does not create or update a row
                    return [sql(db(tableName)
                        .withSchema('public')
                        .insert({
                            invoice_id: event.data.invoiceId,
                            date: event.data.date,
                            amount: event.data.amount,
                            due_date: event.data.dueDate,
                        })
                        .onConflict('invoice_id')
                        .merge(['date', 'amount', 'due_date'])
                        .toQuery())];

                default:
                    return [];
            }
        } finally {
            await db.destroy();
        }
    },
});
