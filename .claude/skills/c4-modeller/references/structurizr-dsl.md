# Structurizr DSL Conventions

How this skill writes C4 models as Structurizr DSL. The rules were checked against the Structurizr CLI (`structurizr validate` and `structurizr inspect`). `example.dsl` in this directory is a complete model that follows every rule and passes both checks; copy its shape.

Language reference: https://docs.structurizr.com/dsl/language

## Renderer-Agnostic Subset

The workspace is data: elements, relationships, and view definitions that say **what** each diagram contains. It never says **how** anything looks or is laid out.

**Allowed**

- `workspace`, `model`, `views`, `configuration`, `properties`
- `!identifiers hierarchical`
- `person`, `softwareSystem`, `container`, `component`, `group`
- `deploymentEnvironment`, `deploymentNode`, `infrastructureNode`, `containerInstance`, `softwareSystemInstance`, `deploymentGroup`
- `->` relationships, `description`, `technology`, `tags`, `url`, `instances`, `perspectives`
- Views: `systemLandscape`, `systemContext`, `container`, `component`, `dynamic`, `deployment`, `filtered`, with `include`, `exclude`, `title`, `description`
- `!docs` and `!adrs` only when the user asks to attach existing documentation or decisions

**Never written by this skill**

- `styles`, `element` and `relationship` styles, `light`, `dark`, `theme`, `themes`, `branding`, `terminology`
- `autoLayout`, `animation`, `default`
- `image` views and `plantuml`, `mermaid` or `kroki` sources
- `!script`, `!plugin`, `!components`, `archetypes`, custom `element` types
- `!include` of a URL

Renderers add their own presentation without editing the model by extending it in a file the renderer owns:

```
workspace extends workspace.dsl {
    views {
        ...
    }
}
```

That file belongs to the renderer or presenting skill, and so does everything inside it. This skill never creates or edits it.

## Workspace Skeleton

Every workspace starts like this. The `properties` block relaxes inspections that C4 itself does not require (technology on human interactions and in-process component calls; documentation and decisions), so `inspect` reports only real gaps.

```
workspace "<Name>" "<One-sentence description>" {

    !identifiers hierarchical

    properties {
        "structurizr.inspection.model.softwaresystem.documentation" "ignore"
        "structurizr.inspection.model.softwaresystem.decisions" "ignore"
        "structurizr.inspection.model.relationship[person->softwaresystem].technology" "ignore"
        "structurizr.inspection.model.relationship[person->container].technology" "ignore"
        "structurizr.inspection.model.relationship[person->component].technology" "ignore"
        "structurizr.inspection.model.relationship[component->component].technology" "ignore"
        "structurizr.inspection.model.relationship[softwaresystem->person].technology" "ignore"
        "structurizr.inspection.model.relationship[container->person].technology" "ignore"
    }

    model {
        ...
    }

    views {
        ...
    }

    configuration {
        scope softwaresystem
    }
}
```

Scope:

- `softwaresystem` — exactly one software system has containers or components (the usual case)
- `landscape` — no software system has containers (landscape or context-only models)
- Several systems detailed in one workspace — omit `configuration` and add `"structurizr.inspection.workspace.scope" "ignore"` to `properties`. Prefer one workspace per system.

## Element Syntax

Arguments are positional. Use `""` to skip one.

```
id = person "<name>" "<description>" "<tags>"
id = softwareSystem "<name>" "<description>" "<tags>" { ... }
id = container "<name>" "<description>" "<technology>" "<tags>" { ... }
id = component "<name>" "<description>" "<technology>" "<tags>"
id = deploymentNode "<name>" "<description>" "<technology>" "<tags>" "<instances>" { ... }
id = infrastructureNode "<name>" "<description>" "<technology>" "<tags>"
id = containerInstance <container id>
id = softwareSystemInstance <software system id>
group "<name>" { ... }
```

Relationships:

```
<source id> -> <destination id> "<description>" "<technology>" "<tags>"
```

## Syntax Rules

- **Blocks span lines.** `{ include * }` on one line fails to parse. Open the brace, put each statement on its own line, close the brace on its own line.
- **Quote every string** that contains a space; quoting all strings is simplest.
- **Identifiers** use `a-zA-Z_0-9` only, in lowerCamelCase (`orderApi`, `paymentsQueue`). With `!identifiers hierarchical`, refer to nested elements by path: `banking.api.signIn`.
- **Define before use.** A relationship can only reference elements already defined above it. Put relationships between elements of different software systems at the end of the `model` block.
- **One relationship per source, destination and description.** A duplicate fails to parse. For several interactions between the same pair, give each a distinct description, or merge them into one ("Reads orders from and writes orders to").
- **Model relationships at the lowest level you know, and summarise shared pairs first.** The DSL creates implied relationships upwards (a person → container relationship implies person → software system), but only one per pair of elements, copied from the first lower-level relationship it meets; a summary defined after that adds a duplicate. So:
  - When only one lower-level relationship connects a pair of higher-level elements, let it imply the higher-level one. Do not write the copy.
  - When several lower-level relationships connect the same pair (several components of one container calling the same database, several containers calling the same external system), write one explicit summary relationship between the higher-level elements **before** the lower-level ones, describing everything that flows ("Reads and writes content, settings and conversations in").
- **Dynamic view steps must exist in the static model.** Every `a -> b` inside a `dynamic` view needs a matching (or implied) relationship in `model`, or the workspace fails to parse.
- **Groups** hold elements of one level only: people and systems in `model`, containers in a software system, components in a container.
- **`!identifiers hierarchical` does not apply to groups.** Elements inside a group are still addressed through their parent: `shop.ordersApi`, not via the group name.
- **Deployment instance counts** go in the fifth position of `deploymentNode` (`"2..4"`, `"3"`, `"1..N"`).

## Tags

Tags record what kind of thing an element is, beyond its C4 type. Consumers decide what, if anything, to do with them; `references/notation.md` → Shapes gives the standard shape for each. Use only this vocabulary unless the user supplies another.

| Tag | Apply to |
|-----|----------|
| `External` | People and software systems outside the organisation's or team's ownership |
| `Database` | Containers that are relational, document, graph or key-value stores |
| `Queue` | Containers that are a single queue |
| `Topic` | Containers that are a single pub/sub topic or stream |
| `File Store` | Containers that are a blob bucket, file system folder or CDN |
| `Web Browser` | Containers that run in a browser (SPAs) |
| `Mobile App` | Containers that are mobile apps |
| `Desktop App` | Containers that are desktop apps |
| `Function` | Containers that are a serverless function |
| `Assumed` | Elements and relationships inferred without direct evidence |

Structurizr adds the type tags (`Element`, `Person`, `Software System`, `Container`, `Component`, `Relationship`, …) itself. Never write them.

## Views

Define a view for every level modelled. Keys are stable kebab-case strings; renderers and humans refer to diagrams by key.

| View | Key | Definition |
|------|-----|------------|
| System landscape | `system-landscape` | `systemLandscape "system-landscape" "<description>"` with `include *` |
| System context | `system-context` | `systemContext <system> "system-context" "<description>"` with `include *` |
| Container | `containers` | `container <system> "containers" "<description>"` with `include *` |
| Component | `components-<container-id>` (the container's identifier, kebab-cased) | `component <system>.<container> "components-<container-id>" "<description>"` with `include *` |
| Dynamic | `dynamic-<flow-slug>` | `dynamic <scope> "dynamic-<slug>" "<description>"` with ordered `a -> b "<step>" "<technology>"` lines |
| Deployment | `deployment-<environment-slug>` | `deployment <system> <environment id> "deployment-<slug>" "<description>"` with `include *` |

Rules:

- Give every view a description that names its level and scope ("The applications and data stores inside the Internet Banking System.").
- When a view would hold more than 20 elements, keep the full view and add focused views with a suffix (`containers-orders`). Select elements with `include "element.group==<Group>"`, `include ->id->` (an element plus everything coupled to it), or explicit identifiers.
- Dynamic view scope: `*` for people and systems, a software system for containers, a container for components.
- With no `views` block the parser creates default views; always write the views explicitly so keys are stable.

## JSON Hand-Off

`scripts/validate.sh <workspace.dsl> --json <out.json>` writes the parsed workspace in Structurizr's JSON format. In that file every view lists the exact elements and relationships it contains, with `include *` already resolved. Consumers that cannot parse the DSL read the JSON instead. The DSL stays the source of truth; the JSON is derived and regenerated on every change.
