---
name: build-state-view
description: Finishes an emmett state-view slice (projection, migration, tests, route) from the builder's scaffold and its BUILD markers, or builds it whole when the scaffold was skipped
---

# Build State View Slice

> Read `../emmett-reference/SKILL.md` (next to this skill) first. It has the installed emmett, dumbo and test APIs and the places where this app differs from older templates. Do not search `node_modules` for them.

> `.slice.json` in the working directory is the **source of truth** for every field, event and specification. Never invent fields not defined there. Each element and the slice carry `description` and `comments[]`: use them as implementation hints. The events the slice projects, with their fields, are the job's `sourceEvents` (`context_get` with no step).

A state-view slice projects events into one read model table and serves it on a GET route. It emits no events and handles no commands.

## What the scaffold already wrote

The builder renders these files from the slice before you start. Names, types, columns, fields (in slice order), the route, the OpenAPI block and the test wiring are right: keep them.

| File | Holds |
|---|---|
| `src/slices/{Context}/{Slice}/{Slice}Projection.ts` | `tableName`; the `{ReadModel}ReadModel` row type; `readModelColumns(db)`, which reads each column under its field name (DATE as text, BIGINT and NUMERIC as numbers); `{Slice}Events`, the events it handles; the projection, whose `evolve` has a `case` per event. An event that carries the read model's key gets an upsert of the columns it has a field for |
| `src/slices/{Context}/{Slice}/{Slice}.test.ts` | One `it('<title>')` per specification: `given` events, `.when(...)`, then `thenRows([...])` with the expected rows from the specification's examples (`[]` for an empty list). `thenRows` compares the fields the rows name, in any order, through `readModelColumns` |
| `src/slices/{Context}/{Slice}/routes.ts` | `GET /api/query/{name}-collection`, the path `src/common/modeledEndpoints.ts` lists for the read model (else its title, lowercased), with `requireUser` and the `@openapi` block: the whole collection, or the row whose key is `?_id=` |
| `supabase/migrations/V{n}__{table}.sql` | `CREATE TABLE` with a snake_case column per read model field: the key is the PRIMARY KEY, other fields are NOT NULL unless optional |
| `src/slices/{Context}/{Context}Events.ts` | The projected event types and the context's union. The first slice of a context creates the file; later slices add their types and union members to it |
| `src/common/loadPostgresEventstore.ts` | The projection's import and its entry in `projections.inline([...])` |

## Fill the markers

The scaffold report (`context_get` with step `scaffold`) lists every `BUILD:` marker by file and line. Write what each asks for, then delete the marker line. The `done` tool refuses a file that still holds one.

| Marker | Write |
|---|---|
| `BUILD: evolve <Event>. <Event> has no <fields>` | The upsert covers the fields the event has. Add the missing columns to the `insert` and the `merge` list as the slice says: a default from its comments or examples, or a lookup (below). If the event does not create or update a row (it removes one, say), replace the statement |
| `BUILD: evolve <Event>. <Event> has no <key>` | The event cannot address a row by the key. Write what it does: an update by another column, a lookup table that a later event reads, or `return []` |
| `BUILD: evolve <Event>. The dispatch has no definition` | Give the event's type in `{Context}Events.ts` its fields (from its slice under `src/slices/` when built, else what this slice reads from it), then write its `case` as above |
| `BUILD: given.` | The events' data holds placeholders (`''`, `0`) where the examples do not say what the events carry. Set values that give exactly the expected rows below; add events when the rows need more than the specification lists (three invoices need three `InvoiceCreated`). The note above the marker says how the events relate |
| `BUILD: then.` | The expected rows: what the specification describes, or an example value that does not fit its field type |
| `BUILD: test.` | The slice has no specification: give the event example data and expect the row it gives |
| `BUILD: key.` | The read model has no id field: choose the key column, make it the PRIMARY KEY, use it in `onConflict` and in the route's `_id` lookup |
| `BUILD: read models.` | The slice has further read models: build each the same way, with its table in this slice's migration |

Do every item in the report's `tasks` too. A task is a snippet the builder could not place, typically `| {Event}` for a union written on one line (`export type InvoicingEvents = A | B;`): add the member to the union.

### Statements

Inline projections run in the append's transaction: `evolve` runs for every event of the batch, then the collected SQL runs as one batch. So a read cannot see rows written earlier in the same batch. Resolve a cross-event value inside the statement:

```typescript
// ClientCreated feeds a lookup table (created in this slice's migration, truncated in the test's beforeEach too)
return [sql(db('invoices_client_lookup').withSchema('public')
    .insert({client_id: event.data.clientId, client_name: event.data.name})
    .onConflict('client_id').merge(['client_name']).toQuery())];

// InvoiceCreated reads it in the insert
client_name: db.raw('COALESCE((SELECT client_name FROM public.invoices_client_lookup WHERE client_id = ?), ?)', [event.data.clientId, '']),
```

Update a row: `db(tableName).withSchema('public').where({client_id: event.data.clientId}).update({name: event.data.name})`. Delete one: `.where({...}).delete()`. Always end with `.toQuery()` inside `sql(...)`, and keep the `try/finally` with `db.destroy()`.

### Storylines

The scaffold writes no storyline tests. When `.slice.json` has `storylines[]`, add a `describe('Storyline: <title>')` per storyline after the specifications. Each pair of READMODEL beats with only EVENT beats between them is one `it`: given every EVENT beat from the start of the storyline up to the later read model beat, `thenRows` with that beat's rows. Skip a segment with a COMMAND or SCREEN beat between the read models.

## What not to change

- **The route** and the `@openapi` path key, which the scaffold took from `src/common/modeledEndpoints.ts` (or the read model title). If a specification or the description asks for an order ("newest first"), add an `orderBy` to the collection query; nothing else about the route changes.
- **`readModelColumns`**: the route and the tests read the table through it, so a date comes back as `'2026-11-08'` and an amount as `1250`.
- **Generated names and types**: the table, the columns, the row type, the event types, the test titles, the expected rows from examples and the imports.
- **Migrations that existed before this build**: Flyway validates them. Change the table with a new `V{n}__*.sql`, the next free number.
- **Other event types** in `{Context}Events.ts`: add to the file, never remove or rewrite another slice's types.

## Verdict CHANGED

The scaffold never overwrites a file, so the earlier build's files are `kept` as they were. When the table's migration exists, it writes `V{n}__alter_{table}.sql` with the column changes (`ADD COLUMN IF NOT EXISTS`, new columns nullable; `ALTER COLUMN ... TYPE`; `DROP COLUMN IF EXISTS`). Read `changes` from the job (`context_get` with no step) and rework the kept files, using `before` to see what was built:

- **A changed read model**: its fields in the `ReadModel` type, `readModelColumns`, the `@openapi` properties, and each `insert` and `merge` list in the projection.
- **A changed or added source event** (`changes.sourceEvents`): its type in `{Context}Events.ts` (edit it in place), its `case` in `evolve`, `{Slice}Events` and `canHandle`, and the event data in the tests.
- **An added specification**: one more `it('<title>')` in the same shape as the others: given events with their data, `thenRows` with the expected rows from its examples.
- **A removed element or specification**: remove its code and test.

When the base holds no earlier build, the scaffold creates every file as for NEW, from the current slice: there is nothing to rework.

## No scaffold: the scaffold was skipped

When the report has `skipped`, write the files in the table above yourself, with the emmett APIs and the events file from `emmett-reference`. Each holds what the scaffold would: the migration, one snake_case column per read model field; the row type with exactly the read model's fields; the projection with `canHandle` listing every source event and a `case` per event; one `PostgreSQLProjectionSpec` test per specification; the route above with `requireUser` and the `@openapi` block (types below, `example` only from the slice); the registration in `loadPostgresEventstore.ts`. The projection's shape:

```typescript
import {postgreSQLRawSQLProjection} from '@event-driven-io/emmett-postgresql';
import {sql, type SQL} from '@event-driven-io/dumbo';
import knex, {type Knex} from 'knex';
import type {ClientCreated} from '../InvoicingEvents';

export const tableName = 'clients';
export type ClientsReadModel = {clientId: string; name: string};
export const readModelColumns = (db: Knex) => ['client_id as clientId', 'name'];
export type ClientsEvents = ClientCreated;

export const ClientsProjection = postgreSQLRawSQLProjection<ClientsEvents>({
    name: 'ClientsProjection',
    canHandle: ['ClientCreated'],
    evolve: async (event, context): Promise<SQL[]> => {
        const db = knex({client: 'pg', connection: context.connection.connectionString, pool: {min: 0, max: 1}});
        try {
            switch (event.type) {
                case 'ClientCreated':
                    return [sql(db(tableName).withSchema('public')
                        .insert({client_id: event.data.clientId, name: event.data.name})
                        .onConflict('client_id').merge(['name']).toQuery())];
                default:
                    return [];
            }
        } finally {
            await db.destroy();
        }
    },
});
```

The test starts a `PostgreSqlContainer`, runs `runFlywayMigrations(connectionString)` from `src/common/testHelpers`, truncates the table before each test, and asserts the rows with `given([...events]).when([]).then(assert)`.

| Field `type` | SQL | OpenAPI |
|---|---|---|
| `String` | `TEXT` | `type: string` |
| `UUID` | `TEXT` | `type: string`, `format: uuid` |
| `Int` | `INTEGER` | `type: integer`, `format: int32` |
| `Long` | `BIGINT` | `type: integer`, `format: int64` |
| `Double` | `DOUBLE PRECISION` | `type: number`, `format: double` |
| `Decimal` | `NUMERIC` | `type: number` |
| `Boolean` | `BOOLEAN` | `type: boolean` |
| `Date` | `DATE` | `type: string`, `format: date` |
| `DateTime` | `TIMESTAMP` | `type: string`, `format: date-time` |
| `Custom`, or any `List` | `JSONB` (insert `JSON.stringify(value)`) | `type: object`, or `type: array` |

## Checklist

- [ ] No `BUILD:` marker left, and every task in the report done
- [ ] Every read model field has a column, a field in the row type, a `readModelColumns` entry and an `@openapi` property: no more, no fewer
- [ ] Every source event is in `canHandle` and has a `case`; each fills the read model fields from the right event data
- [ ] One test per specification, and each passes: `npx tsx --test src/slices/{Context}/{Slice}/{Slice}.test.ts`
- [ ] A lookup or extra table is in this slice's new migration and truncated in the test's `beforeEach`
