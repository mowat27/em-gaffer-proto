---
name: em-scaffold
description: Generate a runnable app skeleton from an eventmodelers.ai event model, ready for the build kits to add slices - Supabase sign-in, main container, navigation with one entry per timeline, a page shell per screen, 501 Not Implemented for every unbuilt endpoint with a UI placeholder, hot reload, and one start command. Use when starting a new app from a board, or to refresh an existing skeleton after the model changed.
---

# em-scaffold: app skeleton from an event model

The build kits build slices only. This skill builds everything around them, so slice building starts from a working app: the same stack as the kits install (`supabase` backend at the root, `supabase-react` front end in `web/`), plus

- Supabase email and password sign-in (real local Supabase auth, not stubbed) and a closed-by-default API auth gate
- a main container with one navigation entry per timeline (chapter), each opening a timeline overview
- a page shell per distinct screen title at `web/src/pages/<ScreenTitle>.tsx`, named as the web kit names pages, routed automatically
- a 501 fallback registered after every real route, so a modeled endpoint with no slice yet answers 501 and a real route always wins, with no stub file a builder could see
- one 501 branch in `web/src/lib/api.ts` and a `<NotBuilt />` placeholder, so the UI shows "not built yet" instead of failing
- hot reload for both halves (`tsx watch` including new files and migrations, Vite HMR) and one start command, `just up`

The model comes from the eventmodelers MCP and the standards from the kits. Never invent either: names, routes and styling are derived from the board and the kit conventions below.

## Inputs

| Input | Default |
|---|---|
| `target` | required: an empty or non-existent directory, or an existing skeleton to refresh |
| board | `boardId` / `organizationId` / `token` / `baseUrl` from `.eventmodelers/config.json` of the project this skill is run from |
| app title | the board name from `list_boards` |

Prerequisites on the machine: Node 22, Docker, Supabase CLI, Flyway with Java, `just`, `foreman`. Check with `command -v` and stop with a list of what is missing.

`SKILL_DIR` below is this skill's folder.

## Step 1: MCP connection

Every board read goes through the `mcp__eventmodelers__*` tools. **If any MCP call fails with an authentication error (401/403, "unauthorized", "token", "re-authenticate", or the tools are not available), stop and ask the user to log in again (`/mcp`, reconnect eventmodelers), then wait.** Do not fall back to the REST API, curl or the CLI's fetch to read the model.

## Step 2: Read the model and write `model.json`

1. `get_chapter_bounds {boardId}`: the timelines, with `title`, `x`, `y`.
2. `get_slice_data {boardId, contextName: <timeline title>, projection: "outline"}`, once per timeline (a context is required): every slice with `title`, `sliceType`, `chapter` and `screens[]`. Cross-check the total against `list_slices {boardId}`; a slice listed there but in no timeline's outline still goes into `model.json` with its `contextName` as `chapter`.
3. Distinct screen titles: for each one take one screen node id from the outline and read it with `get_node` (or `get_nodes {nodeIds}` in batches of about 5). From each screen take only:
   - `route`: only when the screen `description` states one explicitly (for example "route /orders" or "route /orders/:orderId"). Never make one up.
   - `home: true`: only when the description says it is the home page or the page shown after sign-in.
   - the CSS framework its HTML (`meta.pages`) uses. Bulma classes (`navbar`, `is-primary`, `modal-card`, `columns`, `box`) mean `bulma`.
4. CSS: also read the web kit's style guide (`web/.claude/skills/learn-styleguide/` if the project already has the web kit, or the installed kit after step 4). Set `"css": "bulma"` when the screens or style guide use Bulma, otherwise `"none"` (the skeleton then ships a small stylesheet of its own). For another framework, use `"none"` and say so in the report.

Write `<target>/../<target-name>.model.json` (outside the target, it is an input not a project file):

```json
{
  "appTitle": "Order manager",
  "css": "bulma",
  "timelines": [{"title": "Order Management", "x": 275, "y": -368}],
  "slices": [{"title": "OrderList", "sliceType": "STATE_VIEW", "chapter": "Order Management", "screens": ["Orders Page"]}],
  "screens": [{"title": "Orders Page", "route": "/orders", "home": true}]
}
```

Copy titles exactly as the board has them: they become route names and page names. Include every slice, including automations (they get no endpoint but are listed on the timeline overview).

## Step 3: Ports

Pick ports that are free now (`lsof -nP -iTCP:<port> -sTCP:LISTEN` prints nothing):

- a Supabase prefix `NNN` where `NNN20` to `NNN29` are all free (start at 564 and go up; `543` and any prefix another local stack uses are taken). This gives the stack its own ports beside other local Supabase projects.
- an API port (start at 3100) and a web port (start at 5273).

## Step 4: Install the kits

Use the CLI version this project uses (`node_modules/@eventmodelers/cli/package.json`), else `latest`:

```bash
mkdir -p <target>/web && cd <target> && [ -d .git ] || git init -q
CLI="npx -y @eventmodelers/cli@<version>"
CREDS="--token <token> --board-id <boardId> --organization-id <organizationId> --base-url <baseUrl> --print"
$CLI init --stack supabase $CREDS </dev/null              # backend kit + scaffold at the root
(cd web && $CLI init --stack supabase-react $CREDS </dev/null)  # front end kit + scaffold in web/
```

Skip a kit whose `.build-kit/` already exists (refresh run). Never print the token.

## Step 5: Generate the skeleton

```bash
node SKILL_DIR/scripts/generate.mjs --model <model.json> --target <target> \
  --api-port <api> --web-port <web> --db-port-prefix <NNN>
```

It writes the overlay from `SKILL_DIR/template/` and the files generated from the model:

| File | Owner |
|---|---|
| `server.ts`, `src/common/notImplemented.ts` (+ test), `justfile`, `Procfile`, `scripts/*.mjs` | skeleton, rewritten on every run |
| `src/common/modeledEndpoints.ts` | generated: `POST <slicename>` per command, `GET query/<slicename>-collection` per read model (`slicename` = title lowercased, spaces removed, as the build skills name routes) |
| `src/common/extraEndpoints.ts` | created once, then kept by hand: routes the model needs outside the convention |
| `web/src/App.tsx`, `web/src/main.tsx`, `web/src/app/*`, `web/src/lib/api.ts`, `web/src/lib/NotBuilt.tsx` | skeleton, rewritten on every run |
| `web/src/app/model.ts` | generated: timelines, pages, slices |
| `web/src/pages/<ScreenTitle>.tsx` | created once per screen title, then owned by the web kit's page composition |
| `supabase/migrations/_V0__supabase_stubs.sql` | created once: Supabase roles and auth stubs the kit's projection tests load (Flyway skips it) |
| `.build-kit/AGENTS.md`, `web/.build-kit/AGENTS.md` | one "App skeleton" section appended once, read by the build agents at session start |
| `package.json`, `web/package.json`, `web/index.html`, `tsconfig.json`, `supabase/config.toml`, `.gitignore` | patched (dev scripts, router and CSS deps, page title, `web` excluded from root tsc, project id and ports, Supabase CLI temp folders ignored) |
| `skeleton.json` | ports and counts; read by the scripts |

Report any `warnings` it prints.

## Step 6: Install and check

```bash
cd <target> && npm install && npm --prefix web install
npx tsc --noEmit
npx tsx --test src/common/notImplemented.test.ts
npm --prefix web run build && npm --prefix web run lint
```

All must pass. Then commit: `git add -A && git commit -m "chore: app skeleton from the event model"`.

## Step 7: Run it

```bash
just up            # Supabase (if not running), .env files, port check, then API + web with hot reload
just user <email> <password>    # in another terminal: a user to sign in with (there is no sign-up screen)
```

Confirm, with the app running:

1. `curl localhost:<api>/health` answers `{"ok":true,...}`.
2. A modeled read model without a slice answers 501 with a signed-in token, and 401 without one. A path that is not modeled answers 404.
3. `http://localhost:<web>` shows the sign-in; after sign-in the navigation has one entry per timeline, and a timeline overview shows "This feature is not built yet." for each read model.

Leave it running only if the user asked; otherwise `just down`, and `just db-stop` to stop Supabase.

## Refreshing after a model change

Run steps 1 to 6 again with the same `target` and ports (from `skeleton.json`). Generated files are rewritten, page files that exist are kept, new screens get new page shells, and nothing a builder wrote is touched. A running `just up` reloads by itself.

## Reasonable results for unusual input

| Case | Result |
|---|---|
| Board with no slices or no timelines | Runs. Navigation lists the timelines (or is empty), the home route is the first timeline overview, no modeled endpoints |
| Slice whose chapter is not a timeline | Gets a navigation entry named after its chapter |
| Timeline with no screens or only automations | Overview lists its slices, says it has no screens |
| Screen route with a parameter (`/orders/:orderId`) | Routed, not in navigation, listed as "opened from another page" |
| Two screens claiming one route, or a relative route | Second one gets a generated route, reported as a warning |
| Screens with no CSS framework | `css: none`, skeleton stylesheet |
| Port or Supabase prefix in use | Pick the next free one in step 3. At start, `just up` names the busy port and stops |
| MCP authentication fails | Stop and ask the user to log in again. Never use the REST API instead |
| Target is an existing skeleton | Refresh (above) |
| Target is a non-empty directory that is not a skeleton | Stop and ask |

## How slices land in the skeleton

- Backend: the build kit writes `src/slices/<context>/<Slice>/routes.ts`; `tsx watch` restarts the API, the route is mounted before the 501 fallback and wins. A new migration is applied by Flyway on that restart. `notImplemented.test.ts` fails if a route is not on the modeled list, which keeps 501 and real routes in step.
- Front end: the web kit composes components into the existing page shell for the slice's screen (its Step 5), and Vite hot-reloads it. A page file with a new name is routed at `/pages/<name>` automatically.
- Known limits: a read model the UI reads straight from a Supabase table with RLS on and no policies shows an empty list, not a 501. The AGENTS note steers builders to `getReadModel` for that reason.
