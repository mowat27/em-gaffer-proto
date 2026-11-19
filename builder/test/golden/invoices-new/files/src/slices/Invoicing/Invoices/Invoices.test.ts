import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {PostgreSQLProjectionSpec, type PostgreSQLProjectionAssert} from '@event-driven-io/emmett-postgresql';
import {PostgreSqlContainer, type StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import knex, {type Knex} from 'knex';
import {runFlywayMigrations} from '../../../common/testHelpers';
import {type InvoicesEvents, readModelColumns, tableName, InvoicesProjection} from './InvoicesProjection';

type Row = Record<string, unknown>;

// JSON with object keys sorted, so rows compare whatever key order the database keeps.
const sortKeys = (_key: string, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value;

describe('Invoices Specification', () => {
    let postgres: StartedPostgreSqlContainer;
    let db: Knex;
    let given: PostgreSQLProjectionSpec<InvoicesEvents>;

    before(async () => {
        postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
        const connectionString = postgres.getConnectionUri();
        await runFlywayMigrations(connectionString);
        db = knex({client: 'pg', connection: connectionString});
        given = PostgreSQLProjectionSpec.for({projection: InvoicesProjection, connectionString});
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

    it('List all invoices newest first', async () => {
        // Given both clients and invoices ...0101, ...0102, ...0103 exist. Client name is looked up from ClientCreated by clientId.
        // BUILD: given. Set the events' data, and add events, so they give the expected rows (see the note)
        await given([
            {
                type: 'ClientCreated',
                data: {
                    clientId: '',
                    name: '',
                    contactEmail: '',
                },
                metadata: {},
            },
            {
                type: 'InvoiceCreated',
                data: {
                    invoiceId: '',
                    clientId: '',
                    amount: 0,
                    date: '',
                },
                metadata: {},
            },
        ])
            .when([])
            .then(thenRows([
                {
                    invoiceId: 'f9e8d7c6-0000-4000-8000-000000000101',
                    clientName: 'Great Glen Ltd',
                    date: '2026-11-08',
                    amount: 1250,
                    status: 'Created',
                },
                {
                    invoiceId: 'f9e8d7c6-0000-4000-8000-000000000102',
                    clientName: 'The Lochside Lodge',
                    date: '2026-11-05',
                    amount: 300,
                    status: 'Created',
                },
                {
                    invoiceId: 'f9e8d7c6-0000-4000-8000-000000000103',
                    clientName: 'Great Glen Ltd',
                    date: '2026-10-02',
                    amount: 480,
                    status: 'Created',
                },
            ]));
    });

    it('No invoices gives an empty list', async () => {
        // BUILD: given. Set the events' data so they give the expected rows
        await given([
            {
                type: 'ClientCreated',
                data: {
                    clientId: '',
                    name: '',
                    contactEmail: '',
                },
                metadata: {},
            },
        ])
            .when([])
            .then(thenRows([]));
    });
});
