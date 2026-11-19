import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {PostgreSQLProjectionSpec, type PostgreSQLProjectionAssert} from '@event-driven-io/emmett-postgresql';
import {PostgreSqlContainer, type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import knex, {type Knex} from 'knex';
import {runFlywayMigrations} from '../../../common/testHelpers';
import {type ClientsEvents, readModelColumns, tableName, ClientsProjection} from './ClientsProjection';

type Row = Record<string, unknown>;

// JSON with object keys sorted, so rows compare whatever key order the database keeps.
const sortKeys = (_key: string, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value;

describe('Clients Specification', () => {
    let postgres: StartedPostgreSqlContainer;
    let db: Knex;
    let given: PostgreSQLProjectionSpec<ClientsEvents>;

    before(async () => {
        postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
        const connectionString = postgres.getConnectionUri();
        await runFlywayMigrations(connectionString);
        db = knex({client: 'pg', connection: connectionString});
        given = PostgreSQLProjectionSpec.for({projection: ClientsProjection, connectionString});
    });

    beforeEach(async () => {
        await db(tableName).withSchema('public').truncate();
    });

    after(async () => {
        await db?.destroy();
        await postgres?.stop();
    });

    // The table holds exactly the expected rows, compared on the fields they name, in any order.
    const thenRows = (expected: Row[]): PostgreSQLProjectionAssert => async ({connectionString}) => {
        const reader = knex({client: 'pg', connection: connectionString});
        try {
            const rows: Row[] = await reader(tableName).withSchema('public').select(readModelColumns(reader));
            const fields = [...new Set(expected.flatMap((row) => Object.keys(row)))];
            const comparable = (all: Row[]) =>
                all.map((row) => JSON.stringify(Object.fromEntries(fields.map((f) => [f, row[f] ?? null])), sortKeys)).sort();
            assert.deepStrictEqual(comparable(rows), comparable(expected));
        } finally {
            await reader.destroy();
        }
    };

    it('List both clients', async () => {
        await given([
            {
                type: 'ClientCreated',
                data: {
                    clientId: 'c1a2b3c4-0000-4000-8000-000000000001',
                    name: 'Great Glen Ltd',
                    contactEmail: 'accounts@great-glen.example',
                },
                metadata: {},
            },
            {
                type: 'ClientCreated',
                data: {
                    clientId: 'c1a2b3c4-0000-4000-8000-000000000002',
                    name: 'The Lochside Lodge',
                    contactEmail: 'ellen@lochside.example',
                },
                metadata: {},
            },
        ])
            .when([])
            .then(thenRows([
                {
                    clientId: 'c1a2b3c4-0000-4000-8000-000000000001',
                    name: 'Great Glen Ltd',
                    contactEmail: 'accounts@great-glen.example',
                },
                {
                    clientId: 'c1a2b3c4-0000-4000-8000-000000000002',
                    name: 'The Lochside Lodge',
                    contactEmail: 'ellen@lochside.example',
                },
            ]));
    });

    it('No clients gives an empty list', async () => {
        await given([])
            .when([])
            .then(thenRows([]));
    });
});
