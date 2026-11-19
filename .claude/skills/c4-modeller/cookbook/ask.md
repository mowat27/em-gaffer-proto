# Recipe: Ask

Answer a question about a system, scoped to a named C4 level, or a question about the C4 model itself. The level fixes which elements the answer considers and how much detail it gives. Writes no files.

## Variables

- `USER_PROMPT` — the question
- `LEVEL` — the C4 level named in the question; derived in step 2 when absent
- `SUBJECT` — the element the question is about
- `WORKSPACE` — an existing model, located by `cookbook/preferences.md` → Locating an Existing Workspace, or none

## Instructions

- Read `references/c4-model.md`, especially Scoping by Level and Classification Rules.
- **The level is a contract.** Consider only elements of the kinds the level puts in play. Give only the detail the level allows. Leave out everything the level excludes, without listing what was left out.
- Lead with the answer. No preamble, no wall of caveats. At most one line of assumptions, only when an assumption changes the answer.
- Use domain language for data at system context and container level ("customer orders", "rendered report"), never payload examples or field lists.
- When a model exists, answer from it and check the code only for facts the model lacks. When no model exists, gather evidence from the code at the requested level only; do not build a full model.

## Workflow

1. **Conceptual question?** If the question is about C4 itself ("is S3 a container?", "how do I model a queue?"), answer from `references/c4-model.md` in a few sentences, with the classification rule that decides it, and stop.
2. **Fix the level.** Use the level named in the question. When none is named, pick the highest level that answers it (context for "who uses", container for "what talks to what", component for "how is X structured inside") and state the level in the scope line.
3. **Place the subject.** Classify `SUBJECT` with the classification rules.
   - Subject at the requested level → answer about it.
   - Subject below the requested level (a component asked about at container level) → answer about the enclosing element at the requested level, and say so in the scope line ("The rendering engine is a component of Report API; at container level that means Report API.").
   - Subject above the requested level (a system asked about at container level) → answer about its children at the requested level.
4. **Collect facts** from `WORKSPACE`, then from code, documents or the conversation, limited to elements in play at `LEVEL`.
5. **Answer** in this shape:
   - One scope line: `Scope: <subject> (<C4 type>, <technology if container or component>) in <software system>, at <level> level.`
   - The answer as a short bullet list or table. For questions about inputs, outputs, dependencies or callers, use a table with the columns `From` (or `To`) | `Type` | `What flows` | `Via`. `Type` holds the C4 type, with the technology in brackets for containers and components ("Container (PostgreSQL)"). `What flows` uses domain terms. `Via` holds the protocol at container level and below, and is dropped at context and landscape level. Read direction as `references/c4-model.md` → Scoping by Level says.
   - Name elements as `cookbook/preferences.md` → Evidence and Assumptions says. Mark an inferred row by ending its `What flows` cell with "(assumed)".
   - Optionally one line naming the next level down if the user would need it for more detail ("Component level shows which part of Report API consumes each input.").
6. When the prompt asks for it, add a Structurizr DSL fragment for the elements discussed, following `references/structurizr-dsl.md`. Never add diagrams or rendering.

## Report

The answer from step 5, and the DSL fragment when requested. Nothing else.

### Example

Question: "What are the inputs to the rendering engine at the C4 container level?"

```
Scope: Rendering Engine (container, Node.js worker) in Report Builder, at container level.

| From | Type | What flows | Via |
|------|------|------------|-----|
| Report API | Container (Node.js) | Render jobs: which report, for whom, in what format | SQS (render.requested) |
| Template Store | Container (Amazon S3) | Report templates and brand assets | AWS SDK/HTTPS |
| Reporting Database | Container (PostgreSQL) | The report's figures | SQL |
| Fonts Service | External system | Licensed fonts (assumed) | HTTPS |
```
