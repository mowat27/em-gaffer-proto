import {postgreSQLRawSQLProjection} from '@event-driven-io/emmett-postgresql';
import {sql, SQL} from '@event-driven-io/dumbo';
import knex, {Knex} from 'knex';

export const tableName = 'clients';

// TypeScript shape of one row in the read model.
// Fields exactly as in slice.json: clientId (UUID, id attribute), name, contactEmail.
export type ClientsReadModel = {
    clientId: string;
    name: string;
    contactEmail: string;
};

export const getKnexInstance = (connectionString: string): Knex =>
    knex({client: 'pg', connection: connectionString, pool: {min: 0, max: 1}});

// Assumption: no shared InvoicingEvents module exists yet, so the ClientCreated event type is
// declared here. Its payload mirrors the read model fields (clientId, name, contactEmail), as
// implied by the slice's specification examples ("List both clients").
export type ClientCreated = {
    type: 'ClientCreated';
    data: {
        clientId: string;
        name: string;
        contactEmail: string;
    };
};

type ClientsEvents = ClientCreated;

export const ClientsProjection = postgreSQLRawSQLProjection<ClientsEvents>({
    name: 'ClientsProjection',
    canHandle: ['ClientCreated'],
    evolve: async (event, context): Promise<SQL[]> => {
        const db = getKnexInstance(context.connection.connectionString);

        try {
            switch (event.type) {
                case 'ClientCreated':
                    // Insert with upsert: a client row is created (or refreshed) per ClientCreated event.
                    return [sql(db(tableName)
                        .withSchema('public')
                        .insert({
                            client_id:     event.data.clientId,
                            name:          event.data.name,
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
