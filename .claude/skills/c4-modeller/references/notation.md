# C4 Notation Hints

Style guidelines and standard shapes for **presenting** a C4 model. This is the one place in the skill that talks about visuals, kept here so it is easy to find. It never feeds back into modelling:

- Workspaces built by `model` and `update` never contain styles, shapes, colours or layout. The rule in `references/structurizr-dsl.md` → Renderer-Agnostic Subset still holds.
- These hints are defaults for whoever draws the diagram. A presenting skill's own design system (for example html-artefact's theme classes) wins over the colours here. Keep the shapes and the notation rules.
- Code level is drawn in UML (class diagrams, ER diagrams). No shapes here for it.

Open `shapes/index.html` in a browser to see every shape.

## Notation Rules (official C4)

These come from c4model.com → Notation and apply to every diagram whatever its styling:

- Every diagram has a title naming its type and scope ("Container diagram for Internet Banking System").
- Every diagram has a key or legend explaining every shape, colour, border style, line style and arrowhead used.
- Every element shows its name, its type in brackets (`[Container: Spring Boot]`), and a short description.
- Every container and component shows its technology.
- Every line is unidirectional, labelled with a description that matches its direction, and, between containers, labelled with its technology or protocol in brackets.
- Acronyms are spelled out in the legend unless every reader knows them.
- Colour is never the only signal. The type label and the shape must still make sense printed in black and white or seen with colour blindness.
- Colours mean the same thing on every diagram in a set.

## Shapes

Pick the shape from the element's C4 type, then its tag (see `references/structurizr-dsl.md` → Tags). Files are in `shapes/`.

| Model element | Tag | Shape | File |
|---------------|-----|-------|------|
| Person | — | Head and shoulders | `person.svg` |
| Person | `External` | Head and shoulders, grey | `person-external.svg` |
| Software system | — | Box | `software-system.svg` |
| Software system | `External` | Box, grey | `software-system-external.svg` |
| Container | — | Box | `container.svg` |
| Container | `Database` | Vertical cylinder | `database.svg` |
| Container | `Queue`, `Topic` | Horizontal cylinder (pipe) | `queue.svg` |
| Container | `Web Browser` | Browser window | `web-browser.svg` |
| Container | `Desktop App` | Application window | `desktop-app.svg` |
| Container | `Mobile App` | Phone | `mobile-app.svg` |
| Container | `File Store` (folder or file system) | Folder | `file-store.svg` |
| Container | `File Store` (bucket, blob store) | Bucket | `bucket.svg` |
| Container | `Function` | Box | `container-function.svg` |
| Component | — | Box, lighter fill, dark text | `component.svg` |
| Software system or container boundary | — | Dashed rounded rectangle, label bottom-left | `boundary.svg` |
| Group | — | Dotted rounded rectangle, label bottom-left | `group.svg` |
| Deployment node | — | White box with grey border, label bottom-left, instance count bottom-right | `deployment-node.svg` |
| Infrastructure node | — | White box, dark border, dark text | `infrastructure-node.svg` |
| Relationship | — | Solid arrow (synchronous), dashed arrow (asynchronous) | `relationship.svg` |

An element tagged `Assumed` keeps its shape and gets a dashed border, with "Assumed" in the legend.

## Colours

The SVGs use the classic C4 palette by default. Every colour is a CSS variable with that default as its fallback. Override the variables to restyle, or map them onto a design system's tokens.

| Variable | Default | Used for |
|----------|---------|----------|
| `--c4-person-fill` / `-stroke` | `#08427b` / `#073b6f` | People |
| `--c4-system-fill` / `-stroke` | `#1168bd` / `#0b4884` | Software system in scope |
| `--c4-container-fill` / `-stroke` | `#438dd5` / `#3c7fc0` | Containers |
| `--c4-component-fill` / `-stroke` | `#85bbf0` / `#78a8d8` | Components |
| `--c4-external-fill` / `-stroke` | `#999999` / `#8a8a8a` | External people and systems |
| `--c4-node-fill` / `-stroke` | `#ffffff` / `#888888` | Deployment nodes |
| `--c4-infra-fill` / `-stroke` | `#ffffff` / `#444444` | Infrastructure nodes |
| `--c4-boundary-stroke` | `#444444` | Boundaries and groups |
| `--c4-detail-stroke` | `rgba(255,255,255,.75)` | Inner detail lines (cylinder lips, browser bar) |
| `--c4-line` / `--c4-line-text` | `#707070` | Relationship lines, arrowheads and labels |
| `--c4-text-light` / `--c4-text-dark` | `#ffffff` / `#000000` | Text on dark fills / on light fills |
| `--c4-font` | Arial, Helvetica, sans-serif | All text |

Fill darkens as you zoom out: person and system darkest, component lightest. Keep that order in any palette so the level reads at a glance. In dark mode keep the fills and lift `--c4-line`, `--c4-line-text` and `--c4-boundary-stroke` to a light grey.

## Text Inside Shapes

Three lines, centred, top to bottom:

1. **Name**, bold, about 15px
2. **Type and technology** in square brackets, about 11px: `[Person]`, `[Software System]`, `[Container: PostgreSQL]`, `[Component: Spring Bean]`
3. **Description**, about 12px, wrapped to two or three short lines

Boundaries, groups and deployment nodes put their name and `[type: technology]` at the bottom-left so nested elements keep the space above.

## Lines

- Arrowhead at the destination only. Never double-headed.
- Solid line for synchronous request/response, dashed for asynchronous messages and events. Say so in the legend.
- Label at the middle of the line: the description, then `[technology]` on its own line.
- Prefer straight or orthogonal lines; avoid crossings by moving elements, not by curving lines round them.

## Layout

- Context and container diagrams read best with people at the top, the system or containers in the middle, and external systems and data stores below or to the side.
- Draw the boundary of the system in scope on container diagrams, and of the container in scope on component diagrams. External elements sit outside it.
- Keep every element the same size unless size means something, and if it does, put it in the legend.
- No more than 20 elements on one diagram. The model's focused views (`containers-<slice>`) exist to keep to this.

## Using the SVG Files

- Inline the SVG and replace the `Name`, bracket and description text. Each file is self-contained with a `<title>` for accessibility.
- Every file carries the same `<style>` block, so inlining several on one page is safe. Override colours with the CSS variables on any ancestor.
- `relationship.svg` defines a marker with id `c4-arrowhead`. When drawing many lines in one SVG, define the marker once in `<defs>` and reuse it.
- Scale with `width` and `height`; the `viewBox` keeps proportions.
