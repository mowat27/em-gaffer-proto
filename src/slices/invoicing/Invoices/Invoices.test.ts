import {before, after, describe, it} from 'node:test';
import {PostgreSQLProjectionAssert, PostgreSQLProjectionSpec} from '@event-driven-io/emmett-postgresql';
import {InvoicesProjection} from './InvoicesProjection';
import {PostgreSqlContainer, StartedPostgreSqlContainer} from '@testcontainers/postgresql';
import knex, {Knex} from 'knex';
import assert from 'assert';
import {runFlywayMigrations} from '../../../common/testHelpers';

// Example invoiceIds from the slice's specification "List all invoices newest first".
const INVOICE_ID_1 = 'f9e8d7c6-0000-4000-8000-000000000101';
const INVOICE_ID_2 = 'f9e8d7c6-0000-4000-8000-000000000102';
const INVOICE_ID_3 = 'f9e8d7c6-0000-4000-8000-000000000103';

// Assumption: the clientIds are the same ones as in the Clients slice's specification examples
// (Great Glen Ltd and The Lochside Lodge); the Invoices spec only names the clients, not their ids.
const CLIENT_ID_1 = 'c1a2b3c4-0000-4000-8000-000000000001';
const CLIENT_ID_2 = 'c1a2b3c4-0000-4000-8000-000000000002';

describe('Invoices Specification', () => {
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
            projection: InvoicesProjection,
            connectionString,
        });
    });

    after(async () => {
        await db?.destroy();
        await postgres?.stop();
    });

    // spec: "List all invoices newest first" - both clients and invoices ...0101, ...0102,
    // ...0103 exist; the client name is looked up from ClientCreated by clientId.
    it('spec: Invoices - List all invoices newest first', async () => {
        const assertReadModel: PostgreSQLProjectionAssert = async ({connectionString: connStr}) => {
            const queryDb = knex({client: 'pg', connection: connStr});
            try {
                const rows = await queryDb('invoices')
                    .withSchema('public')
                    .select('invoice_id', 'client_name', 'date', 'amount', 'status')
                    .orderBy('date', 'desc');

                assert.strictEqual(rows.length, 3, 'all three invoices should be listed');

                // Newest first: ...0101 (2026-11-08), ...0102 (2026-11-05), ...0103 (2026-10-02).
                assert.strictEqual(rows[0].invoice_id, INVOICE_ID_1);
                assert.strictEqual(rows[1].invoice_id, INVOICE_ID_2);
                assert.strictEqual(rows[2].invoice_id, INVOICE_ID_3);

                assert.strictEqual(rows[0].client_name, 'Great Glen Ltd');
                assert.strictEqual(rows[1].client_name, 'The Lochside Lodge');
                assert.strictEqual(rows[2].client_name, 'Great Glen Ltd');

                for (const row of rows) {
                    // Assumption: InvoiceCreated carries no status, so the projection sets 'Created'.
                    assert.strictEqual(row.status, 'Created');
                }

                assert.strictEqual(String(rows[0].amount), '1250.00');
                assert.strictEqual(String(rows[1].amount), '300.00');
                assert.strictEqual(String(rows[2].amount), '480.00');

                assert.strictEqual(new Date(rows[0].date).toISOString().slice(0, 10), '2026-11-08');
                assert.strictEqual(new Date(rows[1].date).toISOString().slice(0, 10), '2026-11-05');
                assert.strictEqual(new Date(rows[2].date).toISOString().slice(0, 10), '2026-10-02');
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
            // Assumption: InvoiceCreated carries invoiceId, clientId, date and amount (no status).
            {
                type: 'InvoiceCreated',
                data: {invoiceId: INVOICE_ID_1, clientId: CLIENT_ID_1, date: '2026-11-08', amount: 1250.00},
                metadata: {stream_name: `invoicing-${INVOICE_ID_1}`},
            },
            {
                type: 'InvoiceCreated',
                data: {invoiceId: INVOICE_ID_2, clientId: CLIENT_ID_2, date: '2026-11-05', amount: 300.00},
                metadata: {stream_name: `invoicing-${INVOICE_ID_2}`},
            },
            {
                type: 'InvoiceCreated',
                data: {invoiceId: INVOICE_ID_3, clientId: CLIENT_ID_1, date: '2026-10-02', amount: 480.00},
                metadata: {stream_name: `invoicing-${INVOICE_ID_3}`},
            },
        ])
            .when([])
            .then(assertReadModel);
    });

    // spec: "No invoices gives an empty list" - a ClientCreated exists but no invoices.
    it('spec: Invoices - No invoices gives an empty list', async () => {
        const assertReadModel: PostgreSQLProjectionAssert = async ({connectionString: connStr}) => {
            const queryDb = knex({client: 'pg', connection: connStr});
            try {
                const rows = await queryDb('invoices')
                    .withSchema('public')
                    .select('invoice_id');

                assert.strictEqual(rows.length, 0, 'the invoice list should be empty');
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
        ])
            .when([])
            .then(assertReadModel);
    });
});
