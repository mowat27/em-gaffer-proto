# ops memory

What ops has learned about this builder: one dated line per fact, with its evidence, newest last. Read it when an
investigation starts (`agent_get { "id": "ops", "file": "MEMORY.md" }`) and add to it with `agent_update`.

- 2026-11-18: The verifier's `endpoint.route` rule (`POST /api/{kebab-case}/:id`) disagrees with invoice-lite's
  modeled endpoints (`src/common/modeledEndpoints.ts`), and the builder follows the app. A verify FAIL on
  `endpoint.route` alone is the rule's, not the build's: report it, do not change the build skills for it.
- 2026-11-18: The verifier's `readmodel.<RM>` rule reads only CREATE TABLE bodies, so a CHANGED state-view build that
  adds columns with ALTER TABLE is reported as missing them. That is the rule's, not the build's.
- 2026-11-18: On a VM, builder/ is a copy, not a git repository: the git tools fail there.
- 2026-11-18: A real build takes 4 to 9 minutes (npm ci, tsc, then 15 to 80 agent turns). A check run is not free.
