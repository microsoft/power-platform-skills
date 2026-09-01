# Foreground Planning and Approval Contracts

Follow the retained
[`Live Build Plan protocol`](./build-plan.md). Mark `experience`, `data-model`,
and `architecture` active/complete around their owning work below. Mark the
owning phase `waiting` during Gates 1–2 and return it to `active` for a repair.

### Step 3 — Plan in the foreground

Planning uses one path on every host. The foreground skill owns requirement
resolution, all questions, Product Experience and Product Scope, data-model
planning, capability and connector decisions, the screen graph, Workflow
Journey, build packs, deterministic validation, plan rendering, approvals, and
recovery. Do not dispatch a planning agent and do not load a second degraded
planning algorithm.

The only child-agent boundary in `/create-mobile-app` is screen implementation
at Step 11. Planning must succeed when no child-agent tool exists.

Create the planning directories and timing artifact:

```bash
mkdir -p <working_dir> <working_dir>/.tmp
PLANNING_TIMINGS_PATH="<working_dir>/.tmp/mobile-planning-timings.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --stage foregroundPlanning --action start
```

The `foregroundPlanning` wall remains open through Gate 4 and is finished in
Phase 4. Time semantic work with these nested diagnostic stages:

| Work | Stage |
|---|---|
| Confirm and lock requirements | `requirementsPlanning` |
| Product Experience + Product Scope | `experienceScopePlanning` |
| Data-model decisions and plan-only output | `dataModelPlanning` |
| Native capabilities + connectors | `capabilityConnectorPlanning` |
| Workflow Journey + screen packs | `journeyPackPlanning` |
| Human plan projection | `planRendering` |
| Targeted semantic correction | `planRepair` |

For each stage, use `planning-timings.js --action start` before work and
`--action finish` after validation. Use `needs-context` or `fail` with a short
non-sensitive classification when blocked. Wrap every actual foreground
approval wait with `userApproval` start/finish; it may overlap the
`foregroundPlanning` wall and is subtracted from execution time. Never record
prompts, requirements, credentials, URLs, or contract content in timing data.

## Canonical artifacts

Keep the existing contracts and tools. Do not introduce a whole-plan schema.

| Authority | Path | Validator/compiler |
|---|---|---|
| Product Experience | `.tmp/product-experience-contract.json` | `validate-product-experience.js` |
| Product Scope | `.tmp/product-scope-contract.json` | `validate-product-scope.js` |
| Workflow Journey | `.tmp/workflow-journey-contract.json` | `validate-workflow-journey.js` |
| Authored screen packs | `.tmp/screen-build-pack.json` | `compile-screen-build-pack.js` |
| Compiled screen packs | `.tmp/compiled-screen-build-pack.json` | `compile-screen-build-pack.js --check` |
| Dataverse schema contract | `.tmp/dataverse-schema-contract.json` | `build-dataverse-operation-manifest.js` and `validate-dataverse-planning-decisions.js` |
| Human plan | `native-app-plan.md` | section hashes in `.tmp/mobile-plan-status.json` |

Read each exact current schema before authoring its contract. A path or schema
name alone is not sufficient context. The foreground may infer semantic values
from the confirmed brief, but deterministic scripts own shape validation,
normalization, binding hashes, compilation, and repeated mechanical rendering.

The human plan and executable contracts must be projections of the same
canonical in-memory decisions. Never parse free-form plan prose to reconstruct
an executable contract when the structured sidecar exists.

## Resume and repair

Before authoring a section, read `.tmp/mobile-pipeline-state.json` and
`.tmp/mobile-plan-status.json` when present. Reuse a section only when its input
and artifact hashes still match the current confirmed brief and upstream
contracts.

- Preserve every validated, unaffected contract and checkpoint.
- Normalize harmless key ordering, whitespace, casing, and generated hash
  differences locally, then validate again.
- A bookkeeping mismatch repairs only bindings or the affected rendered
  section. Never regenerate the complete plan for it.
- A semantic failure reopens only its owning section and downstream contracts
  whose embedded revision changed.
- A changed Product Experience invalidates Product Scope, Journey, and packs.
- A changed Product Scope invalidates Journey and packs, not Product Experience.
- A changed Journey invalidates packs only.
- A data-model correction does not rewrite Product Experience or Product Scope.

Block only for an unsafe capability claim, missing explicit requirement,
invalid data relationship, a user decision/approval that is actually required,
or output that cannot validate or compile.

### Step 3.0 — Foreground Dataverse planning snapshot and evidence

Planning is read-only. Branch on `<dataverse_planning_mode>`:

- `connector-only`: skip Dataverse metadata reads and set the snapshot/evidence
  paths to not supplied.
- `required`: resolve the selected environment in the foreground and create one
  normalized snapshot. No planning child may rediscover the environment.

Build `.tmp/dataverse-concepts.json` from the confirmed brief. Mark only
persistent records with independent lifecycle as `kind: entity` and
`discoverTable: true`. Classify actors as roles, fields as attributes, workflow
verbs as actions, enum values as statuses, and operating limits as constraints.
Do not turn every noun into a table candidate.

Use the existing bounded snapshot path:

```bash
SNAPSHOT_PATH="<working_dir>/.tmp/dataverse-foreground-planning-snapshot.json"
CONCEPTS_PATH="<working_dir>/.tmp/dataverse-concepts.json"
ARCHITECT_EVIDENCE_PATH="<working_dir>/.tmp/dataverse-architect-evidence.json"
PLANNING_TELEMETRY_PATH="<working_dir>/.tmp/dataverse-planning-telemetry.json"
INVENTORY_CACHE_PATH="<working_dir>/.tmp/dataverse-inventory-cache.json"

PLANNING_ENV_JSON=$(node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$ACTIVE_ENV_ID" --no-cache)
ACTIVE_ENV_URL=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.environmentUrl || '')" "$PLANNING_ENV_JSON")
ACTIVE_TENANT_ID=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.tenantId || '')" "$PLANNING_ENV_JSON")

node "${CLAUDE_SKILL_DIR}/../../scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --output "$SNAPSHOT_PATH" \
  --concepts-file "$CONCEPTS_PATH" \
  --tables "<EXPLICIT_TABLES>" \
  --proposed-tables "<PROPOSED_TABLES>" \
  --progressive-detail \
  --combined-base-read \
  --read-concurrency 1 \
  --inventory-cache "$INVENTORY_CACHE_PATH" \
  --inventory-cache-ttl-ms "<TTL, default 1800000>" \
  --telemetry-output "$PLANNING_TELEMETRY_PATH" \
  --planning-timings-output "$PLANNING_TIMINGS_PATH"

node "${CLAUDE_SKILL_DIR}/../../scripts/render-dataverse-architect-evidence.js" \
  --snapshot "$SNAPSHOT_PATH" \
  --output "$ARCHITECT_EVIDENCE_PATH"
```

Required exact-name metadata failures block Dataverse planning. Advisory
candidate failures remain visible evidence but cannot authorize Reuse, Extend,
or Adapt. Proposed names are collision checks, not required existing tables.
Reuse the one bounded exact-name expansion when a selected target lacks full
detail; never rerun broad discovery.

## Step 3.1 — Product Experience and Product Scope

Read `shared/references/product-experience-compiler.md` and the exact Product
Experience and Product Scope schemas. The foreground authors both contracts.

### Explicit requirements

Lock every explicit requirement from the confirmed brief with a stable ID and
evidence. Group requirements into user jobs without dropping functionality.
Anything intentionally deferred remains visible with a reason. Missing
explicit requirement coverage is blocking.

### Product Experience

Resolve the existing semantic dimensions from prompt evidence: primary user and
goal, intent, workflow shape, operating context, session pattern, density,
tempo, risk, content emphasis, collaboration, visual personality, media,
accessibility, first viewport, signature experience, and forbidden defaults.
Industry may supply vocabulary only; it cannot choose scope or visual style.

Offline may be selected only when the user requested it, the brief explicitly
describes limited/intermittent connectivity, or an evidence-backed operating
context assumption is recorded for user approval. Mobile or operational work
alone is not offline evidence.

### Product Scope

Map every shipping job to a concrete screen, section, sheet, modal, flow step,
contextual action, or domain operation. Screen count follows user jobs and
interaction boundaries, never entities, roles, states, native capabilities, or
tables.

A user-facing screen is justified only by at least one of:

- a distinct user job;
- a durable destination revisited independently;
- a decision boundary requiring its own context;
- a capture/workflow step that cannot safely fit an existing surface;
- an independently revisited record, queue, history, or workspace.

Loading, empty, error, permission, success, retry, and offline conditions are
states, never routes. Do not create List/Detail/Create/Edit for every entity.
Equivalent record categories share parameterized list/detail/form surfaces.

Classify every user-facing screen as `durable-destination`, `nested-detail`,
`bounded-flow-step`, or `modal-or-immersive-utility`. Above 12 user-facing
screens, every retained screen requires structured `cannotMergeBecause`
evidence. A role, table, entity, state, or capability name alone is not valid
evidence. Review ceilings are focused 6, standard 9, complex 12, and multi-role
12. Falling below a ceiling is never a warning. Exceeding a ceiling triggers
review and consolidation, never deletion of explicit functionality.

Resolve navigation after the graph exists:

- `tabs-plus-stacks` for 3-5 durable destinations;
- `stack-only` for one bounded linear or immersive journey, with reason and
  return-home mechanism;
- `drawer` only for more than five durable destinations or a real hierarchy;
- at most five visible tabs;
- nested details normally retain their parent tab bar;
- hide tabs only for justified immersive/capture surfaces;
- Home is primary when multiple ongoing jobs or durable destinations exist;
- authenticated apps keep Profile/account and sign-out reachable, but Profile
  is a tab only when account work is itself durable.

Write and validate:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-product-experience.js" \
  --project-root "<working_dir>"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-product-scope.js" \
  --project-root "<working_dir>"
```

Repair only the rejected contract. Do not proceed with warnings that represent
an unresolved user-visible assumption; surface those in Gate 1.

## Step 3.2 — Data model plan-only

Read and execute `/setup-datamodel` in the foreground with:

```text
--plan-only
--working-dir <working_dir>
--requirements <confirmed requirement artifact>
--product-scope <working_dir>/.tmp/product-scope-contract.json
--snapshot <SNAPSHOT_PATH or NOT SUPPLIED>
--evidence <ARCHITECT_EVIDENCE_PATH or NOT SUPPLIED>
--publisher-prefix <DETECTED_PUBLISHER_PREFIX>
```

The skill writes `_dm_section.md` and, in Dataverse-required mode,
`.tmp/dataverse-schema-contract.json`. It does not ask for approval or mutate
Dataverse in plan-only mode. Require exact snapshot-bound validation before a
Reuse, Extend, or Adapt decision can reach Gate 1.

## Step 3.3 — Capabilities and connectors

The foreground reads `template/package.json`; it is the native package
allowlist. Do not claim an unavailable native capability. Pure-JavaScript
dependencies follow `shared/references/javascript-dependency-planning.md` and
remain separate from native capabilities.

Build a native-capability matrix with requirement/job, owning screen/action,
package/wrapper, retained output, persistence consequence, permissions,
platform behavior, fallback state, and availability evidence. Scanning,
barcode printing, inspections, repairs, warranty, photography, GPS, signatures,
and every other explicit job must map to a screen action/domain operation or be
visibly deferred.

Assign exactly one persistence owner to every record/evidence concept:
Dataverse, a confirmed connector, local configuration, or transient UI state.
Then follow `shared/references/connector-planning.md` in the foreground. In
normal create flow, infer candidates from confirmed requirements and include
unresolved choices in Gate 2 rather than opening another pre-gate prompt.

Write `_native_section.md` and `_connectors_section.md` from these canonical
values. Screen/build-pack generation consumes the confirmed lists directly.

## Step 3.4 — Workflow Journey and screen build packs

Read the exact Workflow Journey and screen-build-pack schemas. Build the screen
graph from Product Scope screens and the navigation contract; do not infer
routes from the data model.

For each core job, author ordered journey steps whose `satisfies` IDs cover the
job's locked `criticalSteps`. A step may reuse an existing screen as a section,
sheet, modal, flow step, or contextual action. Preserve route parameters,
navigation intent, domain operations, success, recovery, and resumability.

For every user-facing screen, author one pack preserving UX quality:

- one obvious first-viewport focal point and visible primary action;
- product-specific hierarchy and realistic content;
- signature interaction/component usage;
- media role, source, treatment, aspect/crop intent, and fallback when needed;
- trust and decision-support evidence;
- applicable loading, empty, error, permission, offline, and success states;
- navigation consistent with durable destinations and bounded flows;
- accessibility, Dynamic Type, keyboard, touch-target, and safe-area needs;
- forbidden defaults preventing generic dashboard/CRUD substitution.

Do not add an offline state when Product Experience did not select offline.
Do not create an operational dashboard for a discovery/commerce product unless
the approved jobs justify it.

Home may expose a clearly labeled action that launches an approved scanner
workflow, but Home must never mount `BarcodeScannerView` or a live camera. The
scanner surface is a dedicated full-screen route whose pack/spec declares
`Scanner surface: dedicated-full-screen` and operational pattern
`scan-geofence-gate`, including permission, unavailable, no-match, duplicate,
and manual-entry fallback states.

Validate and compile:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-workflow-journey.js" \
  --project-root "<working_dir>"
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-screen-build-pack.js" \
  --project-root "<working_dir>"
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-screen-build-pack.js" \
  --project-root "<working_dir>" --check
```

Normalize mechanical differences locally and rerun the failed validator. A
semantic finding repairs only Product Scope, Journey, or the affected pack and
then recompiles downstream bindings.

## Step 3.5 — Render one editable human plan

Render `native-app-plan.md` from the same canonical values. Mechanical tables,
Mermaid, job coverage, Screen Map, navigation contracts, and repeated pack
fields should be rendered deterministically where practical. Do not reconstruct
contracts by parsing this Markdown.

Use exactly these top-level headings:

```markdown
## Overview
## App Requirements
## Product Experience
## Product Scope
## Data Model
## Native Capabilities
## Design
## Connectors
## Screens
## Approval Status
## Plan Provenance
```

`## App Requirements` contains the confirmed brief without expansion. `##
Product Scope` contains jobs, deferred functionality, review ceilings, and
requirement coverage. `## Screens` contains navigation, classification, Screen
Map, journey, and per-screen pack summaries. Discovery diagnostics belong in
`memory-bank.md`, not the plan.

## Step 3.6 — Foreground approvals

All questions and approvals use foreground `AskUserQuestion` and plan mode.
No child may ask the user or enter/exit plan mode.

Immediately before each approval and again after each response, check
`.tmp/mobile-build-plan-edits.json` as specified by the Build Plan protocol.
A newer data-model revision cancels the pending handoff, reruns only affected
validators/rendering, and reopens Gate 1 before any downstream approval.

Gate 1 reviews Product Experience, Product Scope, requirement coverage, and the
data model. Gate 2 reviews capabilities, persistence ownership, connectors,
screen graph/navigation, Workflow Journey, and pack compilation. In
`--consolidated-review`, keep these sections pending and defer the single user
approval until the required experience preview is materialized.

On rejection, edit only the owning canonical values, rerun affected validators,
recompile downstream contracts, and rerender affected plan sections. On
acceptance, update `.tmp/mobile-plan-status.json` with exact contract revisions,
section hashes, approval state, and current plan hash. Preserve prior approved
sections whose hashes did not change.

Time each rejection/repair loop as `planRepair`, with `--retry` on subsequent
attempts. The approval wait ends as soon as the user responds; repair time is
never recorded as approval latency.

Gate 3 remains the required design/experience preview approval. Gate 4 remains
the final implementation confirmation. No mutation begins until the current
approval receipt binds all four required states and artifact hashes.

## Step 3.7 — Prefix and Dataverse execution gate

Recheck `.tmp/mobile-build-plan-edits.json` before normalizing or binding the
schema contract. Never restamp an approval receipt invalidated by a browser
edit; return through Gate 1 and every invalidated downstream gate.

In Dataverse-required mode, verify the approved structured contract and plan use
the detected publisher prefix. Correct mechanical prefix drift in both outputs,
normalize the contract, and validate it again. Do not proceed from a missing or
malformed schema contract and do not parse Mermaid as an executable fallback.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/build-dataverse-operation-manifest.js" \
  --normalize-contract "<working_dir>/.tmp/dataverse-schema-contract.json" \
  --output "<working_dir>/.tmp/dataverse-schema-contract.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-dataverse-planning-decisions.js" \
  --contract "<working_dir>/.tmp/dataverse-schema-contract.json" \
  --snapshot "$SNAPSHOT_PATH"
```

Record the validated Phase 3 contract artifacts in
`.tmp/mobile-pipeline-state.json`. Step 6.75 may update design and approval
artifacts, but it must not regenerate Product Experience, Product Scope, data
model, Journey, or screen packs merely to restamp bookkeeping.

Finally record measured planning history:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-eta.js" \
  --project-root "<working_dir>" --record
```