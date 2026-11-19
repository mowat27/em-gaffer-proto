---
name: build-state-change
description: Finishes an emmett state-change slice (command handler, tests, route) from the builder's scaffold and its BUILD markers, or builds it whole when the scaffold was skipped
---

# Build State Change Slice

> Read `../emmett-reference/SKILL.md` (next to this skill) first. It has the installed emmett, dumbo and test APIs and the places where this app differs from older templates. Do not search `node_modules` for them.

> `.slice.json` in the working directory is the **source of truth** for every field, event, rule and specification. Never invent fields not defined there. Each element and the slice carry `description` and `comments[]`: use them as implementation hints.

A state-change slice handles one command with event sourcing: `evolve` replays the stream's past events into a state, `decide` checks the command against that state and returns new events or throws.

## What the scaffold already wrote

The builder renders these files from the slice before you start. Names, types, fields (in slice order), the route, the OpenAPI block, the error codes and the test wiring are right: keep them.

| File | Holds |
|---|---|
| `src/slices/{Context}/{Slice}/{Slice}Command.ts` | The command type; the state (`{}`) and its initial state; `evolve` (returns the state); `decide`, which returns every event the command emits with each field copied from the command field of the same name; the `CommandHandler` and `handle{Slice}(id, command)` |
| `src/slices/{Context}/{Slice}/{Slice}.test.ts` | One `it('spec: <title>')` per specification: `given` events, the `when` command, and `then` events, `thenThrows(rejectedWith('<code>'))` or `thenNothingHappened()` |
| `src/slices/{Context}/{Slice}/routes.ts` | The slice's POST route (see below) with `requireUser`, the `@openapi` block, 201/401/409/500 and `errorMapping` |
| `src/slices/{Context}/{Context}Events.ts` | The event types and the context's union. The first slice of a context creates the file; later slices add their types and union members to it |

Every SPEC_ERROR has one error code, the snake_case of its title (`Empty name is rejected` → `empty_name_is_rejected`), and one message, its description. `errorMapping`, the 409 lines of the `@openapi` block and the tests already use them, so `decide` must throw exactly `{code, message}` as the marker says.

## Fill the markers

The scaffold report (`context_get` with step `scaffold`) lists every `BUILD:` marker by file and line. Write what each asks for, then delete the marker line. The `done` tool refuses a file that still holds one.

| Marker | Write |
|---|---|
| `BUILD: decide.` | One per rule: before the `return`, throw `{code: '<code>', message: '<message>'}` when the command breaks the rule. Base the check on the rule's title, description and the slice's comments, nothing more. When the command can emit several events, return the ones each specification expects |
| `BUILD: state.` | The fields `decide` needs from earlier events, and their start values in `{Slice}InitialState`. Keep `{}` when it needs nothing |
| `BUILD: evolve.` | A `case` per named event that updates the state; `default` returns it unchanged. Pure: no I/O |
| `BUILD: handle.` | An event from another slice may live on another stream (for example `ClientCreated` for an invoice command): then `handle{Slice}` loads that fact, for example from its read model with `getKnexInstance()` from `src/common/db`, and adds it to the state before `decide`. The tests still feed it through `evolve` |
| `BUILD: emit.` | An event field `decide` could not copy from the command: set it as the slice describes |
| `BUILD: test data.` | Values the specification gives no example for are placeholders (`'<name>'`, `1`, `'2026-01-01'`): replace them with values that fit the specification. In an error specification, the command must break only that rule. An event of another slice is written `data: {} as ClientCreated['data']`: fill in the fields its type has and drop the cast when it is no longer needed |
| `BUILD: event type.` | A stub type in `{Context}Events.ts` for an event of another slice that the specifications use: give it that slice's fields when `src/slices/` has them, else the fields this slice reads from it |
| `BUILD: route.` | The command has no generated ID field: choose the stream id |
| `BUILD: commands.` | The slice has more than one command: handle the others too |

Do every item in the report's `tasks` too. A task is a snippet the builder could not place, typically `| {Event}` for a union written on one line (`export type InvoicingEvents = A | B;`): add the member to the union.

## What not to change

- **The route.** The path is the slice's entry in the app's `src/common/modeledEndpoints.ts`, with the generated ID field as its parameter: `POST createclient` gives `POST /api/createclient/:clientId`. Only a slice the app does not list there uses `POST /api/{kebab-case-slice}/:{generated-id-field}`. The `@openapi` path key is the same path with `{param}`, and the ID comes from the path, never from the body. Never edit `modeledEndpoints.ts` or `extraEndpoints.ts`: they are outside the slice.
- **Generated names and types**: the command and event types, the error codes, the test titles and the files' imports.
- **Other event types** in `{Context}Events.ts`: add to the file, never remove or rewrite another slice's types.

## Verdict CHANGED

The scaffold never overwrites a file, so the earlier build's files are `kept` as they were. Read `changes` from the job (`context_get` with no step) and rework them, using `before` to see what was built:

- **A changed or added command field**: the command type, the route's `data` and its `@openapi` body (`properties` and `required`), the field mapping in `decide`, and the command data in every test.
- **A changed or added event field**: the type in `{Context}Events.ts` (edit it in place), `decide`'s event data, and the event data in the tests.
- **An added specification**: one more `it('spec: <title>')` in the same shape as the others. For a new SPEC_ERROR, also its code in `decide`, `errorMapping` and the 409 lines.
- **A removed element or specification**: remove its code, test, error code and documentation.
- **A kept route that breaks the convention above** (for example `/api/create-client/:clientId` when the app lists `POST createclient`): change the path and the `@openapi` key to it.

## No scaffold: the scaffold was skipped, or an automation slice

When the report has `skipped`, write the four files above yourself, in the shape the table describes, with the emmett APIs and the events file from `emmett-reference`. Each must hold what the scaffold would: the command type with exactly the command's fields; `evolve`, `decide` and `handle{Slice}`; one `DeciderSpecification` test per specification; the route with the convention above, `requireUser`, the `@openapi` block (types from the table below, `required` = the non-optional fields, `example` only from the slice), a 201 with `next_expected_stream_version` and `last_event_global_position`, and `errorMapping` with one 409 message per error code. `build-automation` uses the same command handler. Its shape:

```typescript
import type {Command} from '@event-driven-io/emmett';
import {CommandHandler} from '@event-driven-io/emmett';
import type {InvoicingEvents} from '../InvoicingEvents';
import {findEventstore} from '../../../common/loadPostgresEventstore';

export type CreateInvoiceCommand = Command<'CreateInvoice', {invoiceId: string; amount: number}, {correlation_id?: string; causation_id?: string}>;

export type CreateInvoiceState = {created: boolean};   // only what decide needs; {} when nothing
export const CreateInvoiceInitialState = (): CreateInvoiceState => ({created: false});

export const evolve = (state: CreateInvoiceState, event: InvoicingEvents): CreateInvoiceState => {
    switch (event.type) {
        case 'InvoiceCreated': return {...state, created: true};
        default: return state;
    }
};

export const decide = (command: CreateInvoiceCommand, state: CreateInvoiceState): InvoicingEvents[] => {
    if (command.data.amount <= 0) throw {code: 'zero_amount_is_rejected', message: 'Amount must be greater than zero'};
    return [{
        type: 'InvoiceCreated',
        data: {invoiceId: command.data.invoiceId, amount: command.data.amount},
        metadata: {correlation_id: command.metadata?.correlation_id, causation_id: command.metadata?.causation_id},
    }];
};

const CreateInvoiceCommandHandler = CommandHandler<CreateInvoiceState, InvoicingEvents>({evolve, initialState: CreateInvoiceInitialState});

export const handleCreateInvoice = async (id: string, command: CreateInvoiceCommand) => {
    const result = await CreateInvoiceCommandHandler(await findEventstore(), id, (state: CreateInvoiceState) => decide(command, state));
    return {nextExpectedStreamVersion: result.nextExpectedStreamVersion, lastEventGlobalPosition: result.lastEventGlobalPosition};
};
```

Tests use `DeciderSpecification.for({decide, evolve, initialState})`, then `given(events).when(command)` with `.then(events)`, `.thenThrows((error: Error) => (error as Error & {code?: string}).code === '<code>')` or `.thenNothingHappened()`. Events in `given` and `then` need `metadata: {}`.

| slice.json `type` | OpenAPI schema |
|---|---|
| `String` | `type: string` |
| `UUID` | `type: string`, `format: uuid` |
| `Int` / `Long` | `type: integer`, `format: int32` / `int64` |
| `Double` / `Decimal` | `type: number` (`format: double` for Double) |
| `Boolean` | `type: boolean` |
| `Date` / `DateTime` | `type: string`, `format: date` / `date-time` |
| `Custom` | `type: object` |

## Step 4b: storyline tests (optional)

The scaffold does not render storylines. When `.slice.json` has `storylines[]`, each COMMAND beat directly followed by its EVENT beat(s) is one more test in the same shape: `given` = the EVENT beats before the command beat, `when` = the command from the beat's `fields`, `then` = the events right after it. A COMMAND → EVENT → READMODEL walk is not a test here (that half belongs to `build-state-view`). Skip a segment, without inventing values, when the beat's fields do not give a valid command.

## Final verification against `.slice.json`

- [ ] Every command field is in the command type, and no other field is
- [ ] Every event has a type in `{Context}Events.ts` with exactly its fields
- [ ] Every specification has one test that sets up its given, sends its when and asserts its then
- [ ] Every SPEC_ERROR rule is enforced in `decide` with its code, and mapped in `errorMapping` and the 409 lines
- [ ] No business rule, default or constraint that `description`, `comments` or the specifications do not state
- [ ] The route is the slice's modeled endpoint (else the kebab-case slice) with the generated ID field as parameter, and the `@openapi` block documents exactly that path and the command's body fields
- [ ] No `BUILD:` marker is left
