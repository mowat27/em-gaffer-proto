---
name: c4-modeller
description: C4 architecture modeller that builds, updates, reviews and answers questions about C4 models expressed as data in Structurizr DSL, with no rendering. Use when another skill or agent needs a C4 model or architecture model of a system to present (for example "/html-artefact c4 model for the system using /c4-modeller"); when asked to model, document or map the architecture of a codebase or system as system context, containers, components, deployment or dynamic flows; when a question is scoped to a C4 level ("at the C4 container level", "at component level", "at system context level") or needs a fixed level of abstraction; when creating or editing a Structurizr DSL workspace (workspace.dsl); when reviewing a C4 model for correctness; when deciding whether something is a software system, container or component; or when drawing or styling C4 diagrams and needing the standard C4 shapes (person, database, queue, browser, folder, bucket), colours, legend or notation rules; or when the user asks for the C4 Modeller user guide.
argument-hint: "[model|update|ask|review] <subject, change or question>"
---

# C4 Modeller

Construct C4 architecture models as data in Structurizr DSL, and use the C4 levels as a shared vocabulary for scoping detail. The skill never renders: it hands a validated `workspace.dsl` (and optionally Structurizr's resolved JSON) to whichever skill, tool or renderer presents it. Adding a renderer never requires changing this skill; a renderer adds its own presentation in a separate `workspace extends` file it owns.

**YOU ARE MODELLING, NOT RENDERING.** The one exception is `notation` mode, which hands presenters the standard C4 shapes and style guidelines (`references/notation.md`, `references/shapes/`). They live here so they are easy to find; they never enter a workspace, and a presenter's own design system overrides their colours.

## Modes

| Mode | What it does | Typical invocation |
|------|--------------|--------------------|
| `model` | Build a new C4 model from a codebase, documents, an existing diagram or a description; validate it; hand it off | "model this repo", "c4 model for the system", "model the billing service to tmp/c4/billing/workspace.dsl" |
| `update` | Change an existing workspace: add components, a deployment environment or a dynamic flow; edit elements; resync with code | "update add components for the API", "update add the staging deployment", "update sync" |
| `ask` | Answer a question scoped to a named C4 level, or a question about C4 itself; writes nothing | "ask what are the inputs to the rendering engine at the C4 container level", "is S3 a container?" |
| `review` | Validate and critique a workspace against C4 rules, renderer-agnosticism and, optionally, the code; "fix" applies the findings | "review", "review docs/architecture/workspace.dsl against code fix" |
| `notation` | Return C4 notation rules, standard SVG shapes and default styling for presenting a model; maps a workspace's elements to shapes | "notation", "notation for tmp/c4/shop/workspace.dsl", "which shape for a queue?" |
| `user-guide` | Start a local server for the user guide (how to use the skill, C4 basics, shape gallery) and open it; default port 47144 | "user-guide", "user-guide 5050" |

## Recipes

| Mode | Recipe |
|------|--------|
| `model` | `cookbook/model.md` |
| `update` | `cookbook/update.md` |
| `ask` | `cookbook/ask.md` |
| `review` | `cookbook/review.md` |
| `notation` | `cookbook/notation.md` |
| `user-guide` | `cookbook/user-guide.md` |
| shared rules | `cookbook/preferences.md` |

## Resources

| File | Purpose |
|------|---------|
| `references/c4-model.md` | Official abstractions, classification rules, diagram types, scoping by level, notation rules, anti-patterns |
| `references/structurizr-dsl.md` | The renderer-agnostic DSL subset, workspace skeleton, syntax rules, tags, view keys, JSON hand-off |
| `references/example.dsl` | A complete validated model covering every level, deployment and a dynamic flow |
| `references/notation.md` | Presentation hints: official notation rules, shape-per-type table, default palette as CSS variables, text, line and layout guidelines |
| `references/shapes/*.svg` | Standard C4 shapes (person, system, container, component, database, queue, browser, desktop, mobile, folder, bucket, function, boundary, group, deployment and infrastructure nodes, relationships); `index.html` shows them all |
| `guide/index.html` | The user guide page, built on Precision Weave glass; `guide/pw-ui.css` is a copy of the design system's built CSS (not the pw-ui skill) so the guide works offline |
| `scripts/validate.sh` | Parses and inspects a workspace with the Structurizr CLI or Docker image; optionally exports resolved JSON |

All paths are relative to this skill's directory.

---

## Dispatch

Parse `$ARGUMENTS`. When the first token is `model`, `update`, `ask`, `review`, `notation` or `user-guide`, that is the **MODE** and the rest is the **USER_PROMPT**. Otherwise infer the mode from the whole of `$ARGUMENTS`, which becomes the USER_PROMPT:

- **user-guide** — asks for the guide, help, docs or documentation of this skill
- **notation** — asks about shapes, symbols, colours, styling, legend, notation or SVGs for drawing C4 diagrams
- **ask** — a question (ends with `?`, or starts with what, which, who, how, why, where, does, is, should), or names a level as a lens ("at the C4 … level", "at container level")
- **review** — contains review, check, validate, audit or critique
- **update** — contains add, extend, zoom, sync, rename, remove or update, and an existing workspace is found
- **model** — everything else, including empty arguments (model the system in the current working directory)

---

### `model` mode

1. Read `cookbook/model.md`
2. Execute the recipe with USER_PROMPT
3. Return the Model Hand-Off block

---

### `update` mode

1. Read `cookbook/update.md`
2. Execute the recipe with USER_PROMPT
3. Return the change list and the Model Hand-Off block

---

### `ask` mode

1. Read `cookbook/ask.md`
2. Execute the recipe with USER_PROMPT as the question
3. Return the answer

---

### `review` mode

1. Read `cookbook/review.md`
2. Execute the recipe with USER_PROMPT
3. Return the findings report

---

### `notation` mode

1. Read `cookbook/notation.md`
2. Execute the recipe with USER_PROMPT
3. Return the notation block

---

### `user-guide` mode

1. Read `cookbook/user-guide.md`
2. Execute the recipe with USER_PROMPT
3. Return the guide URL

## Composition

When another skill calls this one for a model to present, run `model` (or `update` when a workspace already exists and the caller asks for a change). The model lands in `tmp/c4/<system-slug>/` with `workspace.json` beside it, unless the caller names a path. The calling skill reads the hand-off block, then the DSL or JSON, and owns all presentation: layout, styling and format. When it has no shapes or notation of its own, it can run `notation` (or read `references/notation.md` directly) for the standard C4 shapes and rules.

## Cleanup

Before reporting, ensure any `Explore` agent a recipe started (only `model` starts one, for large codebases) has completed. This is essential when running headless, where a clean shutdown is required for the session to exit.
