# Recipe: Model

Build a C4 model of a software system as a Structurizr DSL workspace, from a codebase, documents, an existing diagram or a description, validate it, and hand it off. Writes data only.

## Variables

- `USER_PROMPT` — what to model, plus optional levels, source and output path
- `SUBJECT` — the system to model; default: the system built by the current working directory
- `SOURCES` — where evidence comes from: a codebase path (default `.`), documents, an existing diagram, or the prompt text
- `LEVELS` — levels to model; parsed from the prompt (see step 1)
- `OUT` — workspace path, resolved by `cookbook/preferences.md` → Output Location

## Instructions

- Read `cookbook/preferences.md`, `references/c4-model.md` and `references/structurizr-dsl.md` before writing anything. Copy the shape of `references/example.dsl`.
- Model the system as it is, not as it should be. Future or proposed elements appear only when the prompt describes a proposed design.
- Classify every candidate element with `references/c4-model.md` → Classification Rules. Ownership and runtime boundaries decide.
- Go no deeper than the levels requested. Component detail is expensive to keep true; never add it by default.
- When the codebase has more than about 300 source files or more than five deployable units, delegate discovery to one `Explore` agent with this brief, then classify its findings yourself: "List every separately running unit (apps, SPAs, workers, jobs, serverless functions, CLIs), every data store, queue and topic, every external API or SaaS called, every user role, and every deployment definition (Dockerfile, compose, Kubernetes, Terraform, wrangler, fly, serverless configs) in `<path>`. For each give the file path that proves it, its technology, and what it talks to. Max 800 words. Bullet points only."

## Workflow

1. **Parse the prompt.**
   - Levels: "landscape" → system landscape; "context" → system context; "container" → container; "component(s) for/of X" → component for container X; "deployment" or an environment name → deployment; "flow", "sequence", "dynamic" or "how X happens" → dynamic for that flow; "all levels" → every level with evidence.
   - Default when no level is named: system context and container, plus deployment when deployment definitions exist.
   - A level named "code" → follow `cookbook/preferences.md` → Edge Cases.
   - Resolve `OUT` and whether to export JSON.
2. **Gather evidence** from `SOURCES`.
   - Codebase: entry points, package manifests and scripts, framework configs, Dockerfiles, compose and IaC files, migrations and ORM configs, environment variable names, SDK imports and API base URLs, auth roles and UI audiences, README and docs.
   - Existing diagram: read every element and relationship; map each to a C4 type.
   - Description: take each named actor, system, app, store and flow.
3. **Identify people.** User roles, personas and external actors who interact with the system. Name them by role.
4. **Identify software systems.** The system in scope (one name, used everywhere) and each external system it talks to. External systems get the `External` tag and stay black boxes.
5. **Identify containers** inside the system in scope. Apply the classification rules: two containers for server app plus SPA, one per queue or topic, one per serverless function, managed data stores as containers, libraries and infrastructure excluded. Give each a description of its responsibility, its technology and a semantic tag from the tag table.
6. **Identify components** only for containers named in `LEVELS`. Group code into units of related functionality behind an interface (controllers, services with their repositories, facades, adapters, modules). A cross-cutting unit with its own interface that several components call (security, encryption, a storage adapter) is a component. Data classes and generic helpers (formatting, string or date utilities) are not.
7. **Identify relationships** at the lowest modelled level. Each has a direction-consistent verb-phrase description naming the domain data or intent, and a technology or protocol when inter-process. Apply the implied-relationship rule in `references/structurizr-dsl.md` → Syntax Rules: a single lower-level relationship implies its higher-level copy; several sharing a pair need an explicit summary written first.
8. **Identify deployment** when in `LEVELS`: one `deploymentEnvironment` per environment the system is shipped to (production or live, staging, preview), skipping local development and test harnesses unless the prompt names them, nested deployment nodes with technology and instance counts, `containerInstance` for each container, `infrastructureNode` for load balancers, gateways, proxies and DNS, and relationships from infrastructure to the instances they route to.
9. **Identify dynamic flows** when in `LEVELS`: ordered steps at one chosen level. Make sure every step exists as a static relationship; add any missing static relationship first.
10. **Write the workspace** to `OUT` using the skeleton in `references/structurizr-dsl.md`: set the scope, define identifiers before use, put cross-system relationships at the end of `model`, write one view per level with the standard keys and descriptions, and add focused views for any view over 20 elements.
11. **Validate** with the loop in `cookbook/preferences.md` → Validation Loop, passing `--json` when JSON export applies.
12. **Quality gate** per `cookbook/preferences.md` → Quality Gate. Fix, then rerun validation if anything changed.

## Report

Return the Model Hand-Off block from `cookbook/preferences.md`. Do not paste the DSL unless the prompt asks for it.
