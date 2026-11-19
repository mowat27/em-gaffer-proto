import {postgreSQLRawSQLProjection} from '@event-driven-io/emmett-postgresql';
import {sql, type SQL} from '@event-driven-io/dumbo';
import knex, {type Knex} from 'knex';
import type {ClientCreated} from '../ReportingEvents';

export const tableName = 'client_directory';

// One row of the ClientDirectory read model: the slice's fields, in slice order.
export type ClientDirectoryReadModel = {
    clientId: string;
    name: string;
    contactEmail: string;
};

// Reads the table as the read model: each column under its field name (DATE as text, BIGINT and NUMERIC as numbers).
export const readModelColumns = (db: Knex) => [
    'client_id as clientId',
    'name',
    'contact_email as contactEmail',
];

const getKnexInstance = (connectionString: string): Knex =>
    knex({client: 'pg', connection: connectionString, pool: {min: 0, max: 1}});

export type ClientDirectoryEvents = ClientCreated;

export const ClientDirectoryProjection = postgreSQLRawSQLProjection<ClientDirectoryEvents>({
    name: 'ClientDirectoryProjection',
    canHandle: ['ClientCreated'],
    evolve: async (event, context): Promise<SQL[]> => {
        const db = getKnexInstance(context.connection.connectionString);

        try {
            switch (event.type) {
                case 'ClientCreated':
                    return [sql(db(tableName)
                        .withSchema('public')
                        .insert({
                            client_id: event.data.clientId,
                            name: event.data.name,
                            contact_email: event.data.contactEmail,
                        })
                        .onConflict('client_id')
                        .merge(['name', 'contact_email'])
                        .toQuery())];

                default:
                    return [];
            }
        } finally {
            await db.destroy();
        }
    },
});
