---
name: preview-screens
description: Re-renders the approved mobile product experience as a self-contained HTML storyboard without starting Metro or a simulator.
user-invocable: true
allowed-tools: Read, Glob, Grep, Bash
model: sonnet
---

**Shared instructions: [shared-instructions-core.md](../../shared/shared-instructions-core.md)** - read first.

# Preview Screens

Render the existing canonical product-experience storyboard. Do not inspect or
translate TSX into a separate preview representation and do not create a second
preview-only design system.

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

`brand/tokens.ts` is optional only for an older approved project; the renderer
uses its safe defaults when tokens are absent. Missing or stale canonical
contracts are `BLOCKED`. Never reconstruct them from `native-app-plan.md`, app
routes, TSX source, screen names, or entity names.

## Validate and render

Run the deterministic gates and existing renderer:

```bash
node "${PLUGIN_ROOT}/scripts/compile-screen-build-pack.js" \
  --project-root "<working_dir>" --check
node "${PLUGIN_ROOT}/scripts/validate-fixture-scenarios.js" \
  --project-root "<working_dir>" --check
node "${PLUGIN_ROOT}/scripts/render-product-experience-preview.js" \
  --project-root "<working_dir>"
```

Stop on a nonzero result. Do not hand-author a fallback.

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

The result is `<working_dir>/_plan_preview.html`. It replaces the prior
storyboard atomically for the current approved contracts. It never writes app
source, starts Metro, launches Dev Player, calls another model, or captures a
native screenshot.

## Open the result

Read `visual_companion` from `memory-bank.md`; default to `yes` when absent.

- `visual_companion: no`: print the absolute file URL and stop.
- `visual_companion: yes` or missing: print the URL and open it with the first
  available platform command.

```bash
open "<working_dir>/_plan_preview.html" 2>/dev/null \
  || xdg-open "<working_dir>/_plan_preview.html" 2>/dev/null \
  || powershell.exe -NoProfile -Command \
    "Start-Process '<working_dir>\\_plan_preview.html'" 2>/dev/null \
  || echo "Open: file://<working_dir>/_plan_preview.html"
```

Report the selected screen IDs, complete graph count, scenario revision,
compiled fingerprint, and target viewport returned by the renderer. Do not
claim native rendering or pixel verification.