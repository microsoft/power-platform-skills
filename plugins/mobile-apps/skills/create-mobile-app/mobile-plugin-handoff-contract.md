# Canvas/MSAPP → Mobile Plugin Handoff Contract

This document defines the local artifact contract between:

1. `scripts/extract-msapp-brief.v2.cjs` (Canvas source → canonical brief)
2. `scripts/adapt-app-brief-for-mobile-plugin.js` (canonical brief → migration package)
3. `/create-mobile-app --adapted-from <migration-package>` (migration package → current native app)

The contract carries source behavior and data semantics into the existing public mobile generator. It never replaces the current template, package versions, authentication flow, offline workflow, native capability allowlist, `edit-app`, or deployment behavior.

## Pipeline

```text
Canvas source (`Src/*.pa.yaml`, optional supported sidecars)
  → app-brief/
      app-brief.json
      app-brief.md
      screens/*.{json,md}
      tables/*.json
  → mobile-plugin-input/
      native-app-plan.md
      mobile-plugin-input.json
      screens/*.plan.md
      state/app-state.md
      behaviors.json
      control-intent-coverage.json
      server-side-assets.json
      optional components/flows/localization/assets artifacts
  → /create-mobile-app --adapted-from mobile-plugin-input/
```

All artifacts remain local. Do not include credentials, access tokens, customer record payloads, private registry configuration, or connection secrets.

## Required package files

| File | Required content | Consumer |
|---|---|---|
| `native-app-plan.md` | Approved-plan baseline with data, capabilities, connectors, navigation, and screen specs | Four one-tap import gates, data/native/connector/screen phases |
| `mobile-plugin-input.json` | Machine-readable schema v3 payload | Orchestrator and specialized skills |
| `screens/<Name>.plan.md` | Source workflow, control evidence, upgrade hints | One screen builder |
| `state/app-state.md` | Source variable/collection readers, writers, and recommended native placement | Bootstrap and builders |
| `behaviors.json` | Normalized actions, visibility, validation, derivations, unmatched formulas | Bootstrap, builders, coverage gate |
| `control-intent-coverage.json` | One semantic row per source control | Builder accounting |
| `server-side-assets.json` | Dataverse calculated/rollup/managed column rules | Data/write guard |
| `migration-checklist.md` | Manual blockers/follow-ups | Final summary |

Optional artifacts become required when declared by the source:

- `components.md` for reusable component definitions/instances
- `flows.json` for Power Automate calls
- `localization.json` for translation keys/strategy
- `assets.json` for bundled image/media references
- `screens/<Name>.controls.md` when a large screen inventory is split
- `requirements-brief.md` for imported requirement wording

## `mobile-plugin-input.json`

Top-level shape:

```jsonc
{
  "schemaVersion": "3",
  "source": {
    "appBriefPath": "<local path>",
    "generatedAt": "<ISO timestamp>"
  },
  "app": {
    "name": "Example",
    "startScreen": "Home",
    "auth": "entra",
    "formFactor": {}
  },
  "bootstrap": {},
  "forms": [],
  "dataModelPlan": {},
  "screenPlan": {},
  "nativePlan": {},
  "qualityGates": {},
  "riskReport": [],
  "unsupported": []
}
```

Required validation:

- `app.name` and `app.startScreen` are non-empty.
- `screenPlan.screens[]` is non-empty for runnable apps.
- Every screen has an existing `planFile`.
- Navigation edges reference known screens.
- `migrationCheck` is absent for a runnable app. Component-library-only inputs stop before creation.

## Dataverse table contract

`dataModelPlan.dataverseTables[]` entries carry:

```jsonc
{
  "logicalName": "cr_inspection",
  "displayName": "Inspections",
  "entitySetName": "cr_inspections",
  "primaryIdAttribute": "cr_inspectionid",
  "primaryNameAttribute": "cr_name",
  "status": "reuse | extend | new",
  "tier": 1,
  "operations": ["read", "create", "update"],
  "screens": ["InspectionList"],
  "columns": []
}
```

Rules:

- `status: reuse` binds the existing table and refreshes generated services.
- `status: extend` adds only approved missing columns before service generation.
- `status: new` creates in tier order.
- Lookups retain targets/dependency edges.
- Choice options retain numeric values and labels.
- File/Image columns retain their distinct host-control/write behavior.
- Calculated, rollup, virtual, and server-managed columns are never included in create/update payloads; details live in `server-side-assets.json`.
- Live target metadata remains authoritative. The migration package is planning evidence, not permission to overwrite an incompatible target table.

## Connector and flow contract

Prefer `dataModelPlan.connectionRequirements[]`:

```jsonc
{
  "id": "office365users-main",
  "connector": "Office365Users",
  "apiId": "shared_office365users",
  "classification": "action",
  "connectionId": null,
  "status": "needs-connection-id",
  "requiredParameters": [],
  "parameters": {},
  "usedByScreens": ["Home"],
  "usedOperations": ["UserProfileV2"],
  "authResources": [],
  "resolutionSkill": "/add-connector"
}
```

Rules:

- Full provider API paths are normalized to the final API ID.
- Missing API IDs, connection IDs, datasets, and resource names remain explicit statuses.
- Source custom-connector API IDs are environment-bound and redacted; resolve the exact custom API ID in the target. Imported dataset/resource/procedure values remain hints until target discovery confirms them.
- SharePoint routes through `/add-sharepoint`.
- Power Automate flows route through `npx power-apps add-flow`, never `add-data-source`.
- Source connection IDs, flow IDs, and workflow entity IDs are environment-bound and emitted only as `source*Present` booleans. They are never copied into a target command.
- A flow is emitted as `needs-flow-id`; resolve and confirm its `flowId` with `npx power-apps list-flows --json` in the selected target before screen generation.
- Runtime connection routing and OAuth remain owned by the current native host.

## Screen contract

Each `screenPlan.screens[]` row includes the source screen name, intended route/file, workflow purpose, data sources, executable `nativeCapabilities`, source-only `sourceNativeIntents`, navigation edges, and per-screen plan path. Only `nativeCapabilities` may drive `/add-native`; source intents such as `form`, `list`, `dialog`, `notification`, or unsupported host packages remain builder/review evidence.

Builders must preserve:

- business workflow and user-visible outcome
- data reads/writes and lookup relationships
- navigation destinations and parameter semantics
- validation, visibility, and authorization intent
- connector/flow calls
- reusable component input/output/event bindings

Builders may redesign:

- pixel coordinates and fixed Canvas dimensions
- HTML/stacked-label layout workarounds
- control chrome and visual hierarchy
- loading, error, empty, and responsive behavior

The complete translation policy is in [canvas-to-native-mapping.md](../../shared/references/canvas-to-native-mapping.md).

## Behavior contract

`behaviors.json` contains:

- `actions[]` with stable `behaviorId`, normalized intent, source event, source statement, and optional `controlFlow[]`
- `visibility[]`, `validations[]`, and `derivations[]`, each with a stable `behaviorId`
- `unmatchedFormulas[]`
- accounting statistics including dropped event actions

Rules:

- `droppedEventActionCount` must be zero before import.
- Nested branch/loop/error/concurrent frames remain nested after translation.
- Each real implementation carries `// source-behavior: <behaviorId>` immediately beside its owning handler/rule/expression. Markers beside TODOs, placeholders, logs, or unrelated code are invalid.
- An approved unrepresentable behavior carries `// source-unsupported: <behaviorId> — <reason>` beside clear user-facing unavailable UX and remains a reported concern. Marker-only/TODO suppression is invalid.
- Data mutation, navigation, validation, authorization/visibility, connector, and flow behavior must be implemented or explicitly unsupported.
- Final generated coverage must be at least 80% per screen and overall; critical behavior has a 100% accounting requirement even when some entries remain explicit unsupported items.

## Control-intent contract

`control-intent-coverage.json` has one row per source control. It is a semantic guardrail, not a component map.

Each row carries:

- source control kind/path and inferred role
- business risk/support status
- `mustPreserve[]`
- source events and data bindings
- layout intent
- native suggestions and upgrade hints
- flags for components, PCF, data controls, and generated form cards

Every high-risk row must have a native implementation, explicit unsupported UI, or named blocker.

## State contract

`state/app-state.md` is an analysis report. Use its scope recommendations rather than recreating all Canvas globals:

- route params: navigation identity and primitive filters
- local/form state: screen-only flags and temporary input
- React Query/domain hooks: server-backed collections
- app/provider state: only truly cross-screen workflow state and optional paint caches
- bootstrap: static defaults, choice metadata, translation prewarm, and narrowly justified app-wide initialization

The current `PowerAppsProvider` already owns `QueryClientProvider`; never add a second provider.

## Assets and localization

- `assets.json` is a manifest, not the bytes. Copy only manifest-listed files from a verified extraction directory.
- Missing bytes render as placeholders and remain explicit follow-ups; never generate a broken `require()`.
- `localization.json` lists valid keys and strategy. It does not authorize inventing new keys or seeding blank translation rows.
- Missing translations render literal fallback text rather than blank labels.

## Quality gates

Adapted apps install and run:

```bash
npm run gen:assets
STRICT=1 npm run check:i18n
MIN_COVERAGE=80 npm run check:coverage
STRICT=1 npm run check:scaffold
npx tsc --noEmit
```

All commands must pass before Metro starts. Greenfield apps retain the existing public generation path and do not require migration sidecars.

## Compatibility and ownership

- `/modernize-canvas-app` owns acquisition, extraction, adaptation, and assessment.
- `/create-mobile-app` owns the current public template and app generation.
- `/edit-app` remains the canonical post-generation editor; use `--plan-only` for documentation-only changes.
- `/add-dataverse`, `/add-sharepoint`, `/add-connector`, `/add-native`, and offline/auth skills retain their existing responsibilities.
- The migration pipeline never modifies the source Canvas app.
