import {before, after, describe, it} from 'node:test';
import {PostgreSQLProjectionAssert, PostgreSQLProjectionSpec} from '@event-driven-io/emmett-postgresql';
import {ClientsProjection} from './ClientsProjection';
import {PostgreSqlContainer, StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import knex, {Knex} from 'knex';
import assert from 'assert';
import {runFlywayMigrations} from '../../../common/testHelpers';

// Example clientIds from the slice's specification "List both clients".
const CLIENT_ID_1 = 'c1a2b3c4-0000-4000-8000-000000000001';
const CLIENT_ID_2 = 'c1a2b3c4-0000-4000-8000-000000000002';

describe('Clients Specification', () => {
    let postgres: StartedPostgreSqlContainer;
    let connectionString: string;
    let db: Knex;
    let given: PostgreSQLProjectionSpec<any>;

    before(async () => {
        postgres = await new PostgreSqlContainer('postgres').start();
        connectionString = postgres.getConnectionUri();

        db = knex({client: 'pg', connection: connectionString});

        await runFlywayMigrations(connectionString);

        given = PostgreSQLProjectionSpec.for({
            projection: ClientsProjection,
            connectionString,
        });
    });

    after(async () => {
        await db?.destroy();
        await postgres?.stop();
    });

    // spec: "List both clients" - two ClientCreated events project to two client rows.
    it('spec: Clients - List both clients', async () => {
        const assertReadModel: PostgreSQLProjectionAssert = async ({connectionString: connStr}) => {
            const queryDb = knex({client: 'pg', connection: connStr});
            try {
                const rows = await queryDb('clients')
                    .withSchema('public')
                    .select('client_id', 'name', 'contact_email');

                assert.strictEqual(rows.length, 2, 'both clients should be listed');

                const greatGlen = rows.find((r: {client_id: string}) => r.client_id === CLIENT_ID_1);
                assert.ok(greatGlen, 'Great Glen Ltd row should exist');
                assert.strictEqual(greatGlen.name, 'Great Glen Ltd');
                assert.strictEqual(greatGlen.contact_email, 'accounts@great-glen.example');

                const lochside = rows.find((r: {client_id: string}) => r.client_id === CLIENT_ID_2);
                assert.ok(lochside, 'The Lochside Lodge row should exist');
                assert.strictEqual(lochside.name, 'The Lochside Lodge');
                assert.strictEqual(lochside.contact_email, 'ellen@lochside.example');
            } finally {
                await queryDb.destroy();
            }
        };

        await given([
            {
                type: 'ClientCreated',
                data: {clientId: CLIENT_ID_1, name: 'Great Glen Ltd', contactEmail: 'accounts@great-glen.example'},
                metadata: {stream_name: `invoicing-${CLIENT_ID_1}`},
            },
            {
                type: 'ClientCreated',
                data: {clientId: CLIENT_ID_2, name: 'The Lochside Lodge', contactEmail: 'ellen@lochside.example'},
                metadata: {stream_name: `invoicing-${CLIENT_ID_2}`},
            },
        ])
            .when([])
            .then(assertReadModel);
    });

    // spec: "No clients gives an empty list" - no events, empty read model.
    it('spec: Clients - No clients gives an empty list', async () => {
        const assertReadModel: PostgreSQLProjectionAssert = async ({connectionString: connStr}) => {
            const queryDb = knex({client: 'pg', connection: connStr});
            try {
                const rows = await queryDb('clients')
                    .withSchema('public')
                    .select('client_id');

                assert.strictEqual(rows.length, 0, 'the client list should be empty');
            } finally {
                await queryDb.destroy();
            }
        };

        await given([])
            .when([])
            .then(assertReadModel);
    });
});
