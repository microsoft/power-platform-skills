---
name: preview-screens
description: Validates and opens the final mobile experience HTML, or renders a separately named neutral structural storyboard when no final preview exists.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash
model: sonnet
---

**Shared instructions: [shared-instructions-core.md](../../shared/shared-instructions-core.md)** - read first.

# Preview Screens

Validate and open the existing model-authored product-experience storyboard. Do
not inspect or translate TSX, author another final design, call another model, or
create a second preview-only design system.

## When to use

- Before implementation, to review approved product intent at Gate 3.
- After screen generation or `/edit-app`, to rerender the same approved intent
  beside the native implementation.
- To inspect representative frames plus the complete approved screen graph
  without starting Metro.

React Native is authoritative after implementation. The HTML must correspond in
hierarchy, navigation, visual character, media prominence, and primary actions,
but it is not proof of native layout, behavior, or pixel fidelity.

## Locate the project

Use `--working-dir <path>` when supplied; otherwise use the current directory.
Require the following current artifacts:

```text
.tmp/product-experience-contract.json
.tmp/product-scope-contract.json
.tmp/navigation-manifest.json
.tmp/workflow-journey-contract.json
.tmp/screen-build-pack.json
.tmp/compiled-screen-build-pack.json
.tmp/scenario-facts.json
```

Complete `brand/tokens.ts` and `brand/signature-components.ts` are required to
validate a final design preview. When `_plan_preview.html` does not exist, this
skill may render only a clearly labelled neutral structural diagnostic. Missing
or stale canonical contracts remain `BLOCKED`.
Never reconstruct them from `native-app-plan.md`, app routes, TSX source,
screen names, or entity names.

## Validate or render structure

Run the deterministic gates. Validate an existing final preview; only when it
does not exist, render the separate structural diagnostic:

```bash
node "${PLUGIN_ROOT}/scripts/compile-screen-build-pack.js" \
  --project-root "<working_dir>" --check
node "${PLUGIN_ROOT}/scripts/validate-fixture-scenarios.js" \
  --project-root "<working_dir>" --check
if test -f "<working_dir>/_plan_preview.html"; then
  node "${PLUGIN_ROOT}/scripts/validate-product-experience-preview.js" \
    --project-root "<working_dir>"
else
  node "${PLUGIN_ROOT}/scripts/render-product-experience-preview.js" \
    --project-root "<working_dir>"
fi
```

If final validation fails, stop and return the finding to `/design-system`; do
not overwrite the final file or hide the failure behind structural output. When
no final file exists, surface the renderer's `neutral-structural-preview`
warning and direct the user to `/design-system` for final visual intent.

The renderer consumes the same authorities as screen building:

- root `experienceDirective` for product-wide tone, expressiveness, density,
  tempo, emphasis, media necessity, risk treatment, region order,
  accessibility priorities, and forbidden defaults;
- selected compiled screen packs for screen-specific hierarchy, identity,
  chrome, first viewport, media, signature interaction, and primary action;
- the navigation manifest for durable destinations, parent tabs, headers, back
  behavior, and visible navigation;
- canonical scenario facts for all concrete records, metrics, statuses, media
  keys, fallbacks, and relationships.

The default storyboard renders at most three distinct frames: primary product
destination, key-flow entry, and strongest decision/action screen. Short flows
remain one or two frames. Expandable `All screens` exposes the rest of the graph
and required states without turning every route into a phone column.

The validated final result remains `<working_dir>/_plan_preview.html`. The
fallback result is `<working_dir>/_plan_preview.structural.html` and never
replaces the final artifact. Neither path writes app source, starts Metro,
launches Dev Player, calls another model, or captures a native screenshot.

## Open the result

Read `visual_companion` from `memory-bank.md`; default to `yes` when absent.

- `visual_companion: no`: print the selected artifact's absolute file URL and
  stop.
- `visual_companion: yes` or missing: print the selected artifact URL and open
  it with the first available platform command.

```bash
open "<validated-final-or-structural-path>" 2>/dev/null \
  || xdg-open "<validated-final-or-structural-path>" 2>/dev/null \
  || powershell.exe -NoProfile -Command \
    "Start-Process '<validated-final-or-structural-path>'" 2>/dev/null \
  || echo "Open: file://<validated-final-or-structural-path>"
```

Report artifact kind, selected screen IDs, complete graph count, scenario
revision, compiled fingerprint, and target viewport when returned. Do not claim
native rendering or pixel verification.