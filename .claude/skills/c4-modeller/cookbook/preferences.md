# Shared Rules

Rules every recipe in this skill follows. Paths are relative to the skill directory unless stated.

## Invariants

- **YOU ARE MODELLING, NOT RENDERING.** Produce data. Never draw, never emit Mermaid, PlantUML, SVG, ASCII art or images, never choose colours, shapes, icons or layout. If the request asks for a picture, produce the model and state in the report that presentation belongs to the caller. The `notation` recipe is the only exception: it returns presentation guidance and shape files, and still never writes them into a workspace.
- **Never write renderer-specific content** into a workspace. The allowed and forbidden DSL constructs are listed in `references/structurizr-dsl.md` → Renderer-Agnostic Subset.
- **Keep official level meanings.** Use the definitions and classification rules in `references/c4-model.md` exactly. Never invent levels.
- **Headless.** Never ask questions, never pause for confirmation. Resolve ambiguity with the defaults below and record assumptions: every one in the `model`, `update` and `review` reports; in `ask`, only as that recipe allows.

## Locating an Existing Workspace

When a recipe needs an existing model and none is named in the arguments, use the first that exists:

1. `docs/architecture/workspace.dsl`
2. `workspace.dsl` at the project root
3. The most recently modified `tmp/c4/*/workspace.dsl`

## Output Location

- A path in the arguments ("to <path>", "in <path>", or any path ending in `.dsl`) wins.
- When another skill or a presentation request drives the call (another skill invoked this one, or the request says the model feeds a page, diagram, deck or renderer), write to `tmp/c4/<system-slug>/workspace.dsl` unless a path is named, so the project's docs are untouched.
- Otherwise write to `docs/architecture/workspace.dsl`.
- Relative paths resolve against the session's working directory. When the codebase being modelled is a different directory, never write inside it; it is read-only evidence.
- Export JSON beside the workspace as `workspace.json` when another skill or a presentation request drives the call (whether or not a path is named), when the prompt asks for JSON, or when a `workspace.json` already sits beside the workspace.
- Overwrite the target file when it exists. Create parent directories as needed.

## Validation Loop

Run after every write:

```
bash <skill-dir>/scripts/validate.sh <workspace.dsl> [--json <workspace.json>]
```

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | Parses and passes inspections | Done |
| 1 | Parse error (message names the line) | Fix the line using `references/structurizr-dsl.md` → Syntax Rules; rerun |
| 2 | Inspection errors or warnings | Add the missing description, technology or relationship detail; rerun |
| 3 | No Structurizr CLI and no running Docker | Check the file by hand against Syntax Rules, then report it as "not machine-validated" |

Stop after five rounds. Report any remaining failures verbatim; never hide them. Never silence a failing inspection with an `ignore` property beyond those in the standard workspace skeleton, except `workspace.scope` for a deliberately unscoped workspace.

## Quality Gate

Before reporting a model, check it against `references/c4-model.md` → Notation Rules as Data and → Anti-Patterns. Fix anything that fails. Confirm the workspace contains no forbidden construct:

```
grep -nE '^\s*(styles|theme|themes|autoLayout|animation|branding|terminology|image|plantuml|mermaid|kroki|archetypes|!script|!plugin)(\s*$|\s+[^=[:space:]])' <workspace.dsl>
```

Every hit is a forbidden keyword and must be removed.

## Evidence and Assumptions

- Name, describe and assign technology from evidence: code, configs, manifests, docs, the user's words.
- When something is inferred rather than seen (a probable user role, a likely protocol), tag the element or relationship `Assumed` and list it in the report with the reason.
- Never invent technologies. When technology is unknown, write `"Unknown"` and tag the element `Assumed`.
- Record what was not modelled and why (for example "no deployment configuration found, deployment level skipped").
- Name elements by their role in the system, taking names from docs, READMEs, UI text and config first ("Content API", not `be`). Keep each name for the whole model or answer.
- Code that is declared but carries nothing (unused bindings, stub or mock integrations, empty handlers) is not evidence of a running element or relationship. Leave it out and list it under "Not modelled", unless the prompt asks about the planned design.

## Edge Cases

| Situation | Handling |
|-----------|----------|
| Request names the code level | The DSL has no code level. In `ask`, answer from the code. In `model` and `update`, model down to components and report that code level is outside the model |
| The subject is a library, SDK or package with no runtime of its own | A library is not a container. Model the containers that embed it when known, with the library's functionality as components inside them. When no consumer is known, model one container named "Host Application" tagged `Assumed` and put the library's components in it; report this |
| Monorepo with many deployables | Each separately running app, function or job is a container; shared packages are not |
| Ownership unclear (one system or several?) | Assume one team and one software system; list it as an assumption |
| Message broker present | One container per queue or topic, tagged `Queue` or `Topic`; never a single broker container |
| Docker Compose or Kubernetes services | Map app and data services to containers; map proxies, gateways, collectors and sidecars to infrastructure nodes in a deployment environment |
| More than 20 elements at one level | Model all of them; add focused views as described in `references/structurizr-dsl.md` → Views |
| Input is an existing Mermaid, PlantUML or image diagram | Translate it into the model; fix anti-patterns while translating and list each fix |
| Input is a vague description with no codebase | Model what is stated, tag inferences `Assumed`, keep to context and container levels |
| Caller asks for rendered output (Mermaid, SVG, PNG) | Produce the model; report that rendering is out of scope and the caller presents it |
| The workspace fails to parse after five rounds | Leave the file in place, report the failure and the parser message |

## Model Hand-Off

`model` and `update` end with this block, so a calling skill can use the model without reading the recipe:

```
## C4 model

- Workspace: <path to workspace.dsl>
- JSON: <path to workspace.json, or "not exported">
- Validation: <ok | parse failed | inspections failed | not machine-validated> — <one-line detail>
- System in scope: <name> (<identifier>)
- Levels modelled: <system landscape, system context, container, component (<containers>), deployment (<environments>), dynamic (<flows>)>

| View key | Type | Scope | Shows |
|----------|------|-------|-------|
| <key> | <type> | <scope element> | <one line> |

- Assumptions: <each Assumed element or relationship and why, or "none">
- Not modelled: <levels or areas skipped and why, or "nothing">

Presentation is the caller's responsibility. The workspace carries no styling or layout.
```
