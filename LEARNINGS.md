<!-- Generated from the slice-state event log. Record learnings with the learn command; do not edit. -->

## environment
- em-gaffer-proto target repo is a stub (README.md + LOGBOOK.md only, no package.json, src or app skeleton); slice builds land as standalone files whose shared imports (@event-driven-io/*, supabase/, core/, common/) do not exist there and nothing can be executed.
- Builder pi runs have no shell tool (only read/write/edit/halt/capture-learning): npm test, git and tsc cannot be run; verify by reading files only.

## clients-slice
- Clients slice: table 'clients', PK column client_id maps slice field clientId; ClientCreated payload assumed {clientId, name, contactEmail}; upsert onConflict('client_id').

## createclient-slice
- CreateClient slice: no create-once guard per board decision; throws codes empty_name/invalid_contact_email mapped to 409 in routes.ts; clientId is generated so it comes from the path id, not the request body.
