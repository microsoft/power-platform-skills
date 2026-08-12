---
name: sync-from-plan
description: Use when an existing Power Apps mobile app must be brought back into alignment with native-app-plan.md after prototype creation, prototype-to-real conversion, Dataverse/schema changes, connector changes, native capability changes, or design refreshes. Rebuilds affected screens and runs the mobile quality gates without scaffolding a new app.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task, AskUserQuestion
model: opus
---

**Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** — read first.

# Sync From Plan

Update an existing mobile app from `native-app-plan.md`. This is the final reconciliation step for `/prototype-to-real-app` and a useful repair path after standalone data/connector/native/design edits.

## Inputs

- `--working-dir <path>` — optional; default current directory.
- `--changed-screens <comma-list>` — optional.
- `--force` — rebuild every build screen.
- `--no-preview` — skip static preview.

## Workflow

### Step 1 — Read State And Plan

Print:

```text
→ [sync 1/8] Reading project state and plan…
```

Verify `app.config.js`, `package.json`, and `native-app-plan.md`. Read `.code-apps-native/state.json`, `.datamodel-manifest.json`, `brand/design-system.md`, `power.config.json`, and generated service files when present.

If state is missing, infer `prototype` when seed JSON/mock markers exist and `.datamodel-manifest.json` is absent; infer `dataverse` when `.datamodel-manifest.json` exists and no mock markers remain. Ask if ambiguous.

### Step 2 — Validate Or Refresh Screen Contracts

Print:

```text
→ [sync 2/8] Validating screen contracts…
```

When `dataMode` is `dataverse`, first prove prototype artifacts are gone:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/cleanup-prototype-artifacts.js" "<PROJECT_DIR>" --check
```

If `.datamodel-manifest.json` changed since last sync, refresh data-bound per-screen specs mechanically from manifest where possible: real logical names, entity sets, lookup schema names, picklist labels/integers, file/image columns, and calculated-column strategy. If the mapping is ambiguous, stop and ask the user before writing screens.

Run available contract checks. At minimum:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
```

If future `validate-screen-contracts.js` exists in this plugin, run it too. Do not silently skip a present validator.

### Step 3 — Reconcile Navigation Shell

Print:

```text
→ [sync 3/8] Reconciling navigation shell…
```

Use the Screen Map in `native-app-plan.md` as source of truth. Create route folders and layouts needed by the plan. Do not create nested `_layout.tsx` files that would fight the orchestrator; do not infer routes from filesystem alone. Run `npm --prefix <PROJECT_DIR> run type-check` after layout edits.

### Step 4 — Update Shared Code And Skeletons

Print:

```text
→ [sync 4/8] Updating shared code and typed skeletons…
```

Generate or repair missing shared primitives and typed skeletons for missing/changed screens only, unless `--force` is set. Skeletons contain imports, typed params, service/hook calls, and `return null`; they must not contain generic placeholder UI.

Run `npm --prefix <PROJECT_DIR> run type-check` before launching builders.

### Step 5 — Rebuild Changed Screens

Print:

```text
→ [sync 5/8] Rebuilding changed screens…
```

Determine target screens from `--force`, `--changed-screens`, missing files, spec changes, or data-mode rebinding. Spawn `mobile-app:screen-builder` for each target file. Builders may edit only their assigned screen file.

### Step 6 — Run Final Gates

Print:

```text
→ [sync 6/8] Running route, quality, contrast, and TypeScript gates…
```

Run in this order:

```bash
cd "<PROJECT_DIR>"
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-quality.js" --report app
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report app
npm run generate-schemas || true
npm run type-check
```

In Dataverse mode, `generate-schemas` failure is blocking. In prototype mode, it may fail because no real connector schema exists; record the concern and continue only when TypeScript still passes.

Use failures as routing information: repair route failures before visual quality, and visual quality before TypeScript cleanup.

### Step 7 — Render Preview

Print:

```text
→ [sync 7/8] Rendering static preview…
```

Unless `--no-preview`, invoke `/preview-screens --working-dir <PROJECT_DIR>` after gates pass.

### Step 8 — Record State

Print:

```text
→ [sync 8/8] Recording sync state…
```

Update `.code-apps-native/state.json` with:

- current `dataMode`
- SHA-256 of `native-app-plan.md` as `lastSyncedPlanHash`
- SHA-256 of `.datamodel-manifest.json` as `lastDataverseManifestHash` in Dataverse mode, otherwise `null`
- current ISO `lastSyncAt`

Append a concise `memory-bank.md` entry with changed screens, validation result, and preview path.

Final response starts with `DONE`, `DONE_WITH_CONCERNS: ...`, or `BLOCKED: ...`.