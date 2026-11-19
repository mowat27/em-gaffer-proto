# Recipe: Notation

Give a presenting skill, renderer or person the C4 notation rules, standard shapes and default styling for drawing a model. Returns guidance and shape files; never draws a model's diagrams and never edits a workspace.

## Variables

- `USER_PROMPT` — optional: element types or tags to cover, a workspace path, or the consumer ("for html-artefact")
- `WORKSPACE` — a workspace path from the prompt, or none

## Instructions

- Read `references/notation.md`. Shape files are in `references/shapes/`.
- Hand back guidance and file paths. Drawing the diagrams is the caller's job.
- Never add styles, shapes, colours or layout to a workspace, including the one in `WORKSPACE`.
- Code level is UML. When asked about code-level notation, say so and stop.

## Workflow

1. When `WORKSPACE` is given, list each element's C4 type and tags from it (or from `workspace.json` beside it), and pick the shape for each from `references/notation.md` → Shapes.
2. Otherwise, pick the rows of `references/notation.md` → Shapes that match the types or tags in the prompt, or all rows when none are named.
3. When the prompt names a consumer with its own design system, say which notation rules still apply and that its colours replace the defaults through the `--c4-*` variables.

## Report

```
## C4 notation

- Guidelines: <absolute path to references/notation.md>
- Shapes: <absolute path to references/shapes/> (gallery: shapes/index.html)

| Element or tag | Shape file |
|----------------|------------|
| <type / tag, or element name when WORKSPACE given> | <file> |

Notation rules: title with type and scope; legend for every shape, colour and line style; name, [type: technology] and description on every element; unidirectional labelled arrows with [technology] between containers; colour never the only signal.
```
