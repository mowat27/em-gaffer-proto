---
name: emmett-reference
description: The emmett 0.42 and dumbo 0.12 APIs and the scaffold helpers as installed in this app, and where the build-skill templates differ from this app. Read before writing slice code, instead of searching node_modules.
---

# Emmett reference for this app

Installed: `@event-driven-io/emmett`, `emmett-postgresql` and `emmett-expressjs` 0.42.5, `@event-driven-io/dumbo` 0.12.7,
`knex` 3, `@testcontainers/postgresql` 11. The signatures below are copied from their `index.d.ts`. Do not search
`node_modules` for them.

## Where this app differs from the build-skill templates

These facts win over the templates in `build-state-view`, `build-state-change` and `build-automation`.

| Template | This app |
|---|---|
| Slice spec at `.slices/{Context}/{slicename}/slice.json` | `.slice.json` in the working directory |
| Events imported from `../{Context}Events` | `src/slices/{context}/{Context}Events.ts`. The first slice of a context creates it (template below). Later slices add their events to it |
| Routes import `../../../core/readmodel` | Does not exist. Routes query the read model table with `getKnexInstance()` from `src/common/db` |
| Register the route or processor in `src/index.ts` (build-automation Step 5) | `server.ts` discovers `src/slices/**/routes{,-*}.ts` and `processor{,-*}.ts` itself. Never edit `server.ts` |
| Migration file name | Flyway with `validateOnMigrate=true`: the next free `V<n>__<name>.sql` in `supabase/migrations/`. Never reuse a version, even when a board comment names one |

Route paths come from `src/common/modeledEndpoints.ts` (for example `GET /api/query/invoices-collection`).

## Scaffold helpers

| Import | Exports |
|---|---|
| `src/common/db` | `postgresUrl`, `getKnexInstance(): Knex` (shared), `getSharedPool(): pg.Pool`, `closeDb()` |
| `src/common/loadPostgresEventstore` | `findEventstore()`: the PostgreSQL event store. Register inline projections in its `projections.inline([...])` |
| `src/common/testHelpers` | `runFlywayMigrations(connectionString)`: Supabase stubs plus every migration |
| `src/supabase/requireUser` | `requireUser(req, res, sendUnauthorized = true)`: `{user, error: null}` or `{user: null, error: string}`. On an error it has already answered 401: return |

## Events and commands (`@event-driven-io/emmett`)

```ts
type Event<Type extends string, Data extends Record<string, unknown>, Meta extends Record<string, unknown> | undefined = undefined>
// = Readonly<{ type; data }>, plus `metadata: Meta` when Meta is given
type Command<Type extends string, Data extends Record<string, unknown>, Meta extends Record<string, unknown> | undefined = undefined>
// = { type; data; metadata? }
```

Context events file, `src/slices/{context}/{Context}Events.ts`:

```ts
import type {Event} from '@event-driven-io/emmett';

type CommonMeta = {correlation_id?: string; causation_id?: string; userId?: string};

// Fields from the slice.json event definition.
export type ClientCreated = Event<'ClientCreated', {clientId: string; name: string}, CommonMeta>;

export type InvoicingEvents = ClientCreated; // | each further event of the context
```

Emmett's own read metadata is camelCase: `{messageId, streamName, streamPosition: bigint, globalPosition: bigint}`.
`stream_name` fails excess-property checks.

## Projection: state view (`@event-driven-io/emmett-postgresql`)

```ts
postgreSQLRawSQLProjection<EventType>({
  name: string,
  canHandle: EventType['type'][],
  evolve: (event: EventType, context: PostgreSQLProjectionHandlerContext) => SQL | SQL[] | Promise<SQL | SQL[]>,
  init?: (context) => void | SQL | SQL[] | Promise<...>,
})

type PostgreSQLProjectionHandlerContext = {
  execute: SQLExecutor;
  connection: {connectionString: string; client; transaction; pool: Dumbo};
};
```

- Inline projections run in the append's transaction. `evolve` is called for every event of the batch first, and the
  collected SQL then runs as one batch. A read through any connection, including a new knex on `connectionString`,
  cannot see rows written earlier in the same batch.
- Resolve a cross-event lookup inside the statement with a subquery:

  ```ts
  client_name: db.raw('COALESCE((SELECT client_name FROM public.invoices_client_lookup WHERE client_id = ?), ?)', [event.data.clientId, '']),
  ```

## SQL (`@event-driven-io/dumbo`)

```ts
sql(sqlQuery: string, ...params: unknown[]): SQL   // pg-format style: params are interpolated into the string
rawSql(sqlQuery: string): SQL
interface SQLExecutor {
  query<R>(sql: SQL): Promise<QueryResult<R>>;
  command<R>(sql: SQL): Promise<QueryResult<R>>;
  batchQuery<R>(sqls: SQL[]): Promise<QueryResult<R>[]>;
  batchCommand<R>(sqls: SQL[]): Promise<QueryResult<R>[]>;
}
```

The usual form is `sql(knexBuilder.toQuery())`. `toQuery()` inlines the bindings, so the result is literal SQL.

## Projection test

```ts
const postgres = await new PostgreSqlContainer('postgres').start();   // Docker is available
const connectionString = postgres.getConnectionUri();
await runFlywayMigrations(connectionString);
const given = PostgreSQLProjectionSpec.for({projection: MyProjection, connectionString});

await given(givenEvents)
  .when(events, {numberOfTimes?: number})
  .then(assert: PostgreSQLProjectionAssert, message?: string);   // or .thenThrows(...)

type PostgreSQLProjectionAssert = (options: {pool: Dumbo; connectionString: string}) => Promise<void | boolean>;
// Given and when events: EventType & {metadata?: Partial<{streamName; messageId; streamPosition; globalPosition}>}
eventInStream(streamName, event); eventsInStream(streamName, events);
expectSQL.query(sql).resultRows.toBeTheSame(rows);
```

Start a fresh container per spec when each scenario must begin from its own state, and `await postgres.stop()` in
`finally`.

## Command handler: state change (`@event-driven-io/emmett`)

```ts
CommandHandler<State, StreamEvent>({evolve, initialState, mapToStreamId?, retry?})
  (store, id: string, handle: (state: State) => StreamEvent | StreamEvent[] | Promise<...>)
  // => Promise<{newState, newEvents, nextExpectedStreamVersion: bigint, createdNewStream: boolean, lastEventGlobalPosition: bigint}>

DeciderCommandHandler<State, CommandType, StreamEvent>({evolve, initialState, decide})
  (store, id: string, commands: CommandType | CommandType[])   // same result

DeciderSpecification.for({decide, evolve, initialState})   // async decide gives an async spec: await it
  (givenEvents: Event | Event[])
  .when(command)
  .then(expectedEvents) | .thenNothingHappened() | .thenThrows(errorCheck?)
```

- Get the store with `await findEventstore()`. Return the bigint results to clients with `.toString()`.
- `decide` throws `{code, message}`. The route maps each `code` to a 409 message.
- When a given event lives on another aggregate's stream (for example `ClientCreated` for an invoice command),
  `evolve` still handles it so `DeciderSpecification` tests pass. The real handler resolves that fact from the read
  model (`getKnexInstance()`, kept in sync by the inline projection) and passes it into the state before `decide`.
