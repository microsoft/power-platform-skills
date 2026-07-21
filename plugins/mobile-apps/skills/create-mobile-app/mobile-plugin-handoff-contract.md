# Canvas/MSAPP → Mobile Plugin Handoff Contract

This document defines the local artifact contract between:

1. `scripts/validate-power-apps-yaml.js` + `scripts/extract-msapp-brief.v2.cjs` (official schema validation + Canvas source → canonical brief)
2. `scripts/adapt-app-brief-for-mobile-plugin.js` (canonical brief → migration package)
3. `/create-mobile-app --adapted-from <migration-package>` (migration package → current native app)

The contract carries source behavior and data semantics into the existing public mobile generator. It never replaces the current template, package versions, authentication flow, offline workflow, native capability allowlist, `edit-app`, or deployment behavior.

## Ownership invariant

> **Deterministic code preserves business/data/connector contracts. AI owns all React Native implementation.**

This is a new native app, not a Canvas-to-TypeScript transpilation. Deterministic extraction, adaptation, approval projection, and validation own the **what**: business rules, validation/authorization/calculation obligations, Dataverse tables/columns/relationships and read/write fields, connector/flow operations and arguments, workflow order/control flow and approved policy, source ownership, and explicit unsupported gaps. The AI workflow/screen/bootstrap builders own the **how**: React Native components, hooks, state representation, navigation code, helper/module structure, native progress/error/empty UX, accessibility, and TypeScript implementation within those contracts.

Do not build, invoke, generate, or introduce a deterministic Canvas-to-TypeScript operation emitter at any handoff stage. Deterministic outputs may provide typed target-service facts, write guards, skeleton interfaces, markers, and semantic test oracles, but business handlers, workflow implementations, and JSX remain AI-owned. AI implementation freedom never authorizes changing business meaning, Dataverse fields/lookups, connector/flow arguments, workflow policy, or approved unsupported behavior.

## Pipeline

```text
Canvas source (`Src/*.pa.yaml`, optional supported sidecars)
  → immutable official Power Apps YAML v3.0 schema validation
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
      behavior-contract.json
      behavior-shards/*.json
      workflow-shards/*.json
      workflows.json
      workflow-gate-summary.json
      control-intent-coverage.json
      pcf-plan.json
      server-side-assets.json
      optional components/flows/localization/assets artifacts
  → /create-mobile-app --adapted-from mobile-plugin-input/
```

All artifacts remain local. Do not include credentials, access tokens, customer record payloads, private registry configuration, or connection secrets.

## Required package files

| File | Required content | Consumer |
|---|---|---|
| `.mobile-app-modernizer-output` | Exact adapter ownership marker; proves the package was emitted by the deterministic adapter | Safe importer ownership guard |
| `native-app-plan.md` | Approved-plan baseline with data, capabilities, connectors, navigation, and screen specs | Four one-tap import gates, data/native/connector/screen phases |
| `mobile-plugin-input.json` | Machine-readable schema v3 payload | Orchestrator and specialized skills |
| `screens/<Name>.plan.md` | Lossless source workflow/control/formula provenance and upgrade evidence | Human review/debug audit only; never model-facing during generation |
| `state/app-state.md` | Source variable/collection readers, writers, and recommended native placement | Bootstrap and builders |
| `behaviors.json` | Lossless normalized global ledger: actions, visibility, validation, derivations, unmatched formulas | Deterministic validation and final coverage only; never builders |
| `behavior-contract.json` | Conservative dependency closure, core/regenerable disposition, raw-free native intent mapping, shard index | Validator, report, coverage gate, orchestrator routing |
| `behavior-shards/<Screen>.json` | One screen's compact builder-owned exact core behavior, structured native intent hints, semantic control rows, and unmatched statements | One screen builder; `App` shard feeds bootstrap |
| `workflow-shards/<Workflow>.json` | One pathological handler's exact workflow-owned actions and intent hints | Workflow orchestrator only; never screen builders |
| `workflows.json` | Pathological event detection, ordered named-step proposals, exception-only questions, user approval | Gate 2c, shared workflow generation, builders, workflow coverage gate |
| `workflow-gate-summary.json` | Deterministic bounded projection of workflow evidence, step summaries, questions, and approvals; no exact formulas/payloads | Model-facing Gate 2c review only |
| `control-intent-coverage.json` | Global one-row-per-control semantic ledger | Deterministic validation; per-screen rows are copied into builder shards |
| `pcf-plan.json` | One proposed and explicitly approved disposition per PCF | Gate 2b, native/connector routing, builders, PCF coverage gate |
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
    "generatedAt": "<ISO timestamp>",
    "powerAppsYamlSchemaValidation": {
      "schema": "power-apps-yaml-validation-report-v1",
      "version": "3.0",
      "sourceCommit": "<immutable PowerApps-Tooling commit>",
      "sha256": "<pinned schema digest>"
    }
  },
  "app": {
    "name": "Example",
    "startScreen": "Home",
    "auth": "entra",
    "formFactor": {}
  },
  "bootstrap": {},
  "forms": [],
  "behaviorPlan": {},
  "dataModelPlan": {},
  "screenPlan": {},
  "nativePlan": {},
  "qualityGates": {},
  "riskReport": [],
  "unsupported": []
}
```

Required validation:

- Source YAML passed the immutable official v3.0 schema preflight before semantic extraction; the canonical brief and migration package retain the validated schema commit/digest.
- Source YAML used the canonical block-style subset consumed by semantic extraction; tags, aliases/anchors/merges, directives, complex or quoted keys, flow maps, and nonempty flow sequences were rejected rather than interpreted differently across stages.
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

It remains the lossless global ledger. It is copied into the target for deterministic checks but is never passed to a screen builder or read by the model-driven bootstrap/workflow materialization phases.

`behavior-contract.json` deterministically derives one disposition for every stable behavior ID:

- `core` — exact behavior required in a builder shard
- `regenerable` — disconnected Canvas UI plumbing represented by a structured native intent hint

Core selection is conservative:

1. Seed core with every validation, visibility/authorization, derivation/default/items rule, unmatched/unknown operation, Dataverse mutation, connector/flow/AI call, persistent local operation, and device/external effect.
2. Extract state writes and reads from normalized leaf statements and their control-flow frames.
3. Walk dependencies backward from every core sink and promote every upstream writer into core.
4. Promote writers consumed by unmatched formulas.
5. Allow regeneration only for explicitly allowlisted UI operations and transient state names after closure proves they do not reach a core sink.
6. Default ambiguity, business-looking state, unknown intents, and unsafe-to-classify operations to core.

Every classification row records state reads/writes, dependency behavior IDs, core consumers, reason codes, shard path, and optional intent-hint ID. The contract also hashes `behaviors.json`; package validation recomputes the complete contract and every shard from the global ledger and rejects any drift.

Each `behavior-shards/<Screen>.json` uses `behavior-shard-v2` and contains:

- compact `screenIntent` (route, archetype, purpose, data sources, params, navigation)
- compact semantic `controlIntents[]` (`mustPreserve`, source event/data-binding names, contextual role + evidence, layout role, and compact approved PCF disposition when applicable) with no verbatim formulas; repeated defaults/guidance live once in `controlIntentDefaults` and `controlRoleGuidance`
- compact `workflowRefs[]` (workflow ID, core/hint ownership, target import/export/call site) so builders never receive global `workflows.json`
- builder-owned exact core `actions[]`, `visibility[]`, `validations[]`, and `derivations[]`
- exact unmatched source statements for review; repeated full handlers remain in the global ledger
- raw-free `intentHints[]` with stable `hintId`, native intent, compact control-flow role, structured target/state/query/form data, and nearest core anchors; repeated guidance lives once in `intentGuidance`

The shard intentionally omits source formulas/statements for regenerable entries and removes repeated screen names, owner labels, templates, generic hints, duplicate `formula`/`expression` values, and complete unmatched handlers retained globally. Paths are relative to `screen`. Exact core action leaves retain `sourceStatement`, normalized payload, order, and control flow but omit repeated full-handler `sourceFormula`; that lossless formula remains in the global ledger. Builders implement each exact core entry with `// source-behavior: <behaviorId>` and each native equivalent with `// source-intent: <hintId>`. The only zero-runtime hint is `discard-no-side-effect`, which records an intentionally discarded source expression that had no effect. Verbose screen/control formula files plus global behaviors, workflows, workflow implementation shards, and control coverage remain audit/orchestrator artifacts and are never passed to screen builders. Validation rejects any screen or workflow implementation feed over 512 KiB so oversized context cannot silently reach one model invocation.

Rules:

- `droppedEventActionCount` must be zero before import.
- Nested branch/loop/error/concurrent frames remain nested after translation.
- Each real implementation carries `// source-behavior: <behaviorId>` immediately beside its owning handler/rule/expression. Markers beside TODOs, placeholders, logs, or unrelated code are invalid.
- An approved unrepresentable behavior carries `// source-unsupported: <behaviorId> — <reason>` beside clear user-facing unavailable UX and remains a reported concern. Marker-only/TODO suppression is invalid.
- Data mutation, validation, authorization/visibility, connector, and flow behavior remain exact core and must be implemented or explicitly unsupported. Navigation/feedback/refresh/form/reset plumbing may use intent markers only when the contract proves it is disconnected from core state.
- Final generated coverage reads the global ledger plus contract: at least 80% per screen and overall, 100% critical core accounting, and 100% regenerable intent accounting. No source behavior ID may disappear merely because builders did not receive its raw formula.

## Pathological workflow contract

`workflows.json` is a compact architecture index over `behaviors.json`. It does not summarize away Power Fx. The adapter emits one row only when an event handler crosses deterministic complexity thresholds such as high action/statement count, mixed responsibilities, several remote side effects, a mutating loop, or deep control flow.

`workflow-gate-summary.json` is the only model-facing Gate 2c overview. It contains source labels, behavior counts, detection metrics, named-step summaries, target paths, implementation-shard routing, correctness-critical questions, and approval state—but no exact formulas, payloads, or full control-flow frames. `sync-workflow-gate-summary.js` regenerates it after approvals; package validation rejects drift or a summary over 512 KiB. Exact implementation remains split across bounded workflow shards.

Each row carries:

- stable `workflowId` plus source screen/control/path/event
- the exact ordered global `behaviorIds[]`, partitioned into `coreBehaviorIds[]` and `regenerableBehaviorIds[]`
- deterministic detection reasons and metrics
- an ordered `proposal.steps[]` list containing exact core behavior only, plus `proposal.intentHintIds[]` for regenerated UI outcomes
- an orchestrator-owned target module/export/call-site path
- `requiredDecisions[]` only for correctness-critical ambiguity
- a separate user-owned `approval`

Decision ownership is intentionally narrow:

- AI owns helper/module names, step boundaries, native progress/error presentation, Canvas UI-state/reset/toast replacement, and other routine code/UX choices. These remain visible in the proposal and are approved once; they are not individual questions.
- User answers are required only when source evidence cannot prove partial-failure/transaction policy, cross-system retry/idempotency, mutating batch failure behavior, asynchronous completion semantics, or an unclassified critical business operation.

Safe import resets every workflow approval and decision answer. Gate 2c records each resolution (`decisionId`, value, `resolvedBy`, reason), approves every step ID, locks client/server execution ownership and UX mode, and records the user/timestamp. A server transaction/batch/idempotency choice must reference an actual target connection requirement; client compensation requires a concrete compensation plan. A blocking answer stops generation.

Implementation ownership is split deliberately:

- `attachWorkflowRefs()` moves every workflow-owned exact action and native intent out of its screen builder feed into one deterministic `workflow-shards/<workflowId>.json`; global behavior accounting remains unchanged.
- The orchestrator reads only the owning workflow implementation shard and writes each approved module under `src/features/<domain>/workflows/` before screen builders run.
- Each named step has `// source-workflow-step: <stepId>` and its exact `source-behavior` markers beside real operations.
- Every full `step.controlFlow[]` frame has an exact `source-control-flow` marker beside its native branch/loop/error/concurrency structure.
- The exported orchestrator has `// source-workflow: <workflowId>` and invokes named steps according to preserved branch/loop/error/concurrency semantics.
- The owning screen or bootstrap invokes the export under `// source-workflow-call: <workflowId>` and renders typed progress/result/retry UX.
- Every workflow-owned regenerated outcome has a real `// source-intent: <hintId>` implementation at the module or call site.
- Screen builders receive only each workflow's compact ref/import/call contract; they never read implementation shards or inline, duplicate, or rewrite workflow-owned operations.

`check-workflow-coverage.js --strict` verifies approval readiness, safe target paths, module/export/call-site existence, exact markers, named step functions, behavior accounting, and orchestrator invocation order. `check-behavior-coverage.js` follows local `@/` imports so behavior markers implemented in approved workflow modules remain part of screen coverage.

## Control-intent contract

`control-intent-coverage.json` has one row per source control. It is a semantic guardrail, not a component map.

Each row carries:

- source control kind/path and inferred role plus raw-free `roleEvidence`
- business risk/support status
- `mustPreserve[]`
- source events and data bindings
- layout intent
- native suggestions and upgrade hints
- flags for components, PCF, data controls, and generated form cards

Gallery roles are contextual rather than control-kind-only: `record-list`, `navigation-menu`, `picker-options`, `dashboard-sections`, or conservative `repeating-records-review`. Evidence includes only categories/signals such as Items source kind, action intents, child count, row-binding presence, and dynamic-destination presence—not source formulas.

Canvas component instances similarly resolve to `domain-component`, `shared-app-chrome`, `navigation-component`, `form-composite`, `disposable-canvas-scaffolding`, or `component-review`. A component is disposable only when deterministic evidence shows a single layout-scaffold instance with no data, output, event, function, action, navigation, internal-control, app-scope, or external-library contract. The source brief does not expose internal component formulas, so any definition with internal controls remains review/preserve rather than disposable. Ambiguity never becomes disposable.

Every high-risk row must have a native implementation, explicit unsupported UI, or named blocker.

## PCF disposition contract

PCF binaries cannot execute in the native rewrap runtime. `pcf-plan.json` therefore contains exactly one stable `pcfId` row for every control-intent row where `flags.isPcf === true`.

`discovery.complete` must also be true. If Properties/package metadata signals PCF content but no per-control contracts can be enumerated (common in an incomplete YAML-only export), the plan carries `PCF_INVENTORY_INCOMPLETE` and generation stops until a supported sidecar export or verified inventory/specification is supplied. Zero enumerated rows never overrides a positive source PCF signal.

Each row carries:

- source screen/control/path and redacted template identity presence
- public PCF property/event/data-binding contract
- premium flag
- connector/flow/AI dependencies joined to target `connectionRequirementId` values
- conservative essentiality evidence
- deterministic proposal
- separate user-owned `approval`

Allowed terminal dispositions:

1. `native-replacement` — exact built-in or package already present in target `package.json`
2. `server-dependency` — approved native UI plus generated-service requirements
3. `explicit-unsupported` — optional only, with approved visible unavailable-state copy
4. `blocker` — missing source/spec/backend/native strategy; prevents generation

Adapter proposals are never approvals and never propose unsupported loss automatically. Safe import clears all incoming approval fields to `pending`, so a stale/crafted package cannot bypass Gate 2b. Gate 2b sets `approval.status`, disposition, essentiality, strategy, reason, `approvedBy: user`, and timestamp. Before screen fan-out, `validate-mobile-plugin-input.js --require-pcf-approval` must pass. Generated screens use exact `source-pcf: <id> <disposition>` or `source-pcf-unsupported` markers, enforced by `check-pcf-coverage.js --strict`.

After any Gate 2b edit, `sync-pcf-control-intents.js` atomically recomputes PCF summaries and projects the authoritative decision into the matching global control row plus its per-screen shard. Pending/blocked controls become `pcf-review`/`pcf-blocker`; approved outcomes become `pcf-known-capability`, `pcf-native-rebuild`, `pcf-server-backed`, or `pcf-optional-unsupported`. The projection contains only public property/event/data-binding names and an allowlisted target-strategy summary. A SHA-256 digest over stable PCF identity, public contract names, and backend dependencies binds the plan and coverage to one source inventory; mixing an old plan with a new extraction fails before any file is changed. Builders receive this per-screen projection and never read global `pcf-plan.json`. Validation independently recomputes the projection and rejects stale coverage or shards.

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
STRICT=1 npm run check:pcf
STRICT=1 npm run check:workflows
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
