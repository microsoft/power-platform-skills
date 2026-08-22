# Internal Style Picker

**Shared instructions: [shared-instructions.md](../../../../shared/shared-instructions.md)** — read first.

A chat-native direction chooser for `/design-system`. It resolves one complete
design bundle before tokens are generated. It never writes or opens an HTML
preview; the live plan panel carries decisions and the running device is visual
truth.

## Inputs

- `working_dir` — project root containing `native-app-plan.md`
- `default_direction` — optional registered direction slug
- `sub_step_mode` — return the bundle to `/design-system` instead of writing it
- `brand_notes` and `logo_palette` — optional sanitized recommendation inputs

## Step 0 — Load The Catalogue

Read [`design-directions.md`](./design-directions.md), then every direction file
registered there. A direction is selectable only when its catalogue row and
source file both exist. Read [`design-bundle-schema.md`](./design-bundle-schema.md)
for the required output dimensions.

## Security

Apply [`../input-modes.md`](../input-modes.md) to every external file or text
input. Hybrid text is limited to 500 characters, contains no URL/path/code, and
is stripped of HTML, control characters, and shell metacharacters. On failure,
return `BLOCKED: <input> contains <issue>` without echoing the input.

## Step 1 — Infer A Recommendation

Read `## Project`, `## Design`, and the Screen Map. Use the catalogue routing
rules to select a recommendation. Explicit `--direction` always wins. The
recommendation never hides other compatible catalogue entries.

## Step 2 — Ask Once

Use `AskUserQuestion` when available. Present at most four compatible direction
options with the catalogue's short description and mark the inferred direction
recommended. Also allow free text for a hybrid. Do not describe visual choices
that are not present in the source bundle.

Example:

```text
Choose a design direction:
- Inspection — status-first, dense, outdoor operations
- SaaS — familiar enterprise hierarchy and restrained surfaces
- Product — editorial hierarchy and expressive typography
- Use recommended — <name> based on <brief signal>
```

An unclear or empty response defaults to the recommendation after one retry.
The user can mix named bundle dimensions, for example “Product typography with
Inspection density.” Resolve the merge dimension by dimension and state the
result before continuing. Cap refinement at two rounds.

## Step 3 — Persist The Decision

Copy every required dimension from the selected direction source. For a hybrid,
record the source direction of every overridden dimension. Never invent a
partial bundle.

When `sub_step_mode` is false, replace or insert `## Design Direction` before
`## Design` (or `## Screens`) in `native-app-plan.md` using the schema. Append a
dated decision and any rejected directions to `memory-bank.md` under
`## Design history`.

When `sub_step_mode` is true, return:

```text
DESIGN_VIBE_RESULT
direction: <registered direction or Hybrid>
surface: <value>
palette: <value>
typography: <value>
list_style: <value>
density: <value>
motion: <value>
status_saturation: <value>
empty_state: <value>
tone: <value>
primary_action_shape: <value>
accent_color: <name (#hex)>
heading_font: <font>
body_font: <font>
reference_apps: <comma-separated>
```

Refresh the live panel after persistence:

```bash
node "${PLUGIN_ROOT}/skills/create-mobile-prototype/panel/install.js" "<working_dir>"
```

## Contract

- Writes only `native-app-plan.md` and `memory-bank.md` outside sub-step mode.
- Never writes an ephemeral preview file or modifies app source.
- Re-running replaces the plan block and appends design history.
- Screen planner and builders consume `## Design Direction`; absent blocks use
  the catalogue's routed default.
