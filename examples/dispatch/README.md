# Example dispatches

`POST /slices` bodies ([docs/contract.md](../../docs/contract.md)) for every Invoice Lite slice. Use them to iterate on the builder without a board, a runner or a gaffer.

To build them with the verified workflow (the builder, then the verifier) and no build server, ask the slice-lab agent, which finds them as `data:dispatches/<name>.json` (see the [README](../../README.md)):

```
just builder run dev/slice-lab
```

To exercise the build server itself, post one to a local builder:

```
curl -i -X POST http://127.0.0.1:8788/slices -H 'content-type: application/json' -d @examples/dispatch/createclient-new.json
```

| File | Slice | Verdict | What the builder is asked to do |
|---|---|---|---|
| `createclient-new.json` | CreateClient (STATE_CHANGE) | NEW | Build the slice |
| `createclient-changed.json` | CreateClient | CHANGED | Add an optional `phone` to the command, event and screen. One spec added |
| `clients-new.json` | Clients (STATE_VIEW) | NEW | Build the slice from source event ClientCreated |
| `clients-changed.json` | Clients | CHANGED | Show `phone` in the read model and screen. Source event ClientCreated changed |
| `createinvoice-new.json` | CreateInvoice (STATE_CHANGE) | NEW | Build the slice |
| `createinvoice-changed.json` | CreateInvoice | CHANGED | Add `dueDate` to the command, event and screen. Spec "Zero amount is rejected" removed, one rejection spec added |
| `invoices-new.json` | Invoices (STATE_VIEW) | NEW | Build the slice from source events ClientCreated and InvoiceCreated |
| `invoices-changed.json` | Invoices | CHANGED | Show `dueDate` in the read model and screen. Source event InvoiceCreated changed |
| `clientdirectory-new.json` | ClientDirectory (STATE_VIEW, Reporting chapter) | NEW | Build the slice from ClientCreated, owned in another chapter |
| `clientdirectory-changed.json` | ClientDirectory | CHANGED | Add `contactEmail` to the read model and screen. First spec added |

- `repo.base` is invoice-lite `a4ed0fb`, the scaffold with no slice built. A CHANGED dispatch therefore asks for rework of code that is not on the base, and `changes.since.commit` equals the base. Regenerate with `--base <sha>` once a branch with built slices exists.
- `callback` is `http://127.0.0.1:8787/jobs/example-<slice>-<new|changed>`. With no listener there the builder retries the callback, then abandons it. A running local gaffer answers 410. Either way the job's workspace keeps the commits.
- `requires` is `repo:github.com/mowat27/invoice-lite` and `stack:stub`, the gaffer's defaults.

## Regenerate

`board.json` is a snapshot of the board's slice list and each chapter's `slicedata`. `generate.ts` builds every file from it: NEW from the slice as it is, CHANGED from the edits it defines, with `changes` computed by the gaffer's own `compare()` in `gaffer/kit/templates/build-kit/baseline.ts`.

```
node examples/dispatch/generate.ts [--base <sha>] [--callback-port <port>]
```
