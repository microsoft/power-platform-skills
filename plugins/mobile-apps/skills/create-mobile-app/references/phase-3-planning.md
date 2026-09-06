# Foreground Planning and Approval Contracts

Follow the retained
[`Live Build Plan protocol`](./build-plan.md). Mark `experience`, then
`architecture`, then conditional `data-model` active/complete around their
owning work below. Mark the owning phase `waiting` during Gates 1–2 and return
it to `active` for a repair. A not-applicable data model is a completed
milestone, not missing work.

### Step 3 — Plan with foreground ownership

Planning uses one canonical artifact path on every host. The foreground skill owns requirement
resolution, all questions, Product Experience and Product Scope, capability and
connector decisions, persistence ownership, conditional data-model planning,
the screen graph, Workflow Journey, build packs, deterministic validation, plan
rendering, approvals, and recovery. This order is mandatory: requirements plus
Product Experience and Product Scope, native-capability decisions, connector
decisions, exactly one persistence owner per Product Scope data concept,
compiled persistence contract, conditional Dataverse planning, then Workflow
Journey and build packs. Do not dispatch a general planner or screen-planning
agent. Conditional Dataverse planning may dispatch the tool-free return-only
`mobile-app:data-model-architect`; the foreground still owns every artifact and
deterministic decision gate.

There are two bounded child-agent boundaries in `/create-mobile-app`: one compact
Dataverse proposal and one screen implementation at Step 11. If the host cannot
dispatch the Dataverse child, the foreground authors the same compact proposal
schema and continues through the identical compiler and validators. This changes
only who infers the proposal, not the execution path or safety contract.

Create the planning directories and timing artifact:

```bash
mkdir -p <working_dir> <working_dir>/.tmp
PLANNING_TIMINGS_PATH="<working_dir>/.tmp/mobile-planning-timings.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --interrupt-open \
  --reason "planning-session-resumed"
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --stage foregroundPlanning --action start
```

The `foregroundPlanning` wall remains open through Gate 4 and is finished in
Phase 4. Time semantic work with these nested diagnostic stages:

| Work | Stage |
|---|---|
| Confirm and lock requirements | `requirementsPlanning` |
| Product Experience + Product Scope | `experienceScopePlanning` |
| Native capabilities + confirmed connectors | `capabilityConnectorPlanning` |
| Concept ownership + persistence compilation | `persistenceContractPlanning` |
| Conditional Dataverse snapshot and plan-only output | `dataModelPlanning` |
| Owner-bound Workflow Journey + screen packs | `journeyPackPlanning` |
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
| Product Scope navigation projection | `.tmp/navigation-manifest.json` | `compile-navigation-manifest.js` |
| Architecture decisions | `.tmp/architecture-decisions.json` | `compile-persistence-contract.js` |
| Persistence contract | `.tmp/persistence-contract.json` | `compile-persistence-contract.js --check-artifacts` |
| Dataverse concept projection (conditional) | `.tmp/dataverse-concepts.json` | exact match to `persistence.dataverseConceptIds` |
| Dataverse semantic proposal (conditional) | `.tmp/dataverse-model-proposal.json` | `compile-dataverse-model-proposal.js` |
| Workflow Journey | `.tmp/workflow-journey-contract.json` | `validate-workflow-journey.js` |
| Authored screen packs | `.tmp/screen-build-pack.json` | `compile-screen-build-pack.js` |
| Compiled screen packs | `.tmp/compiled-screen-build-pack.json` | `compile-screen-build-pack.js --check` |
| Scenario-facts input | `.tmp/scenario-facts-input.json` | AI-authored records, relationships, invariants, media, and screen bindings |
| Compiled scenario facts | `.tmp/scenario-facts.json` | `validate-fixture-scenarios.js --check` |
| Dataverse schema contract (conditional) | `.tmp/dataverse-schema-contract.json` | `build-dataverse-operation-manifest.js` and `validate-dataverse-planning-decisions.js` |
| Data-model usage input | `.tmp/data-model-usage-input.json` | AI-authored mapping consumed by `validate-data-model-usage.js` |
| Compiled data-model usage | `.tmp/data-model-usage.json` | `validate-data-model-usage.js --check` |
| Human plan | `native-app-plan.md` | section hashes in `.tmp/mobile-plan-status.json` |

Read each exact current schema before authoring its contract. A path or schema
name alone is not sufficient context. The foreground may infer semantic values
from the confirmed brief, but deterministic scripts own shape validation,
normalization, binding hashes, compilation, and repeated mechanical rendering.

The human plan and executable contracts must be projections of the same
canonical in-memory decisions. Never parse free-form plan prose to reconstruct
an executable contract when the structured sidecar exists.

## Resume and repair

Before authoring a section, read `.tmp/pipeline-state.json` and
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
- A changed Product Experience invalidates Product Scope, architecture
  decisions, persistence, conditional Dataverse artifacts, Journey, and packs.
- A changed Product Scope invalidates architecture decisions, persistence,
  conditional Dataverse artifacts, Journey, and packs, not Product Experience.
- A changed architecture decision invalidates the persistence contract and all
  mode-dependent Dataverse, Journey, and pack artifacts.
- A changed persistence contract invalidates conditional Dataverse artifacts,
  Journey, and packs.
- A changed Journey invalidates packs and their downstream scenario projection,
  not Product Experience, Product Scope, or persistence ownership.
- A changed Product Scope, persistence contract, navigation manifest, Journey,
  or compiled pack invalidates scenario facts. Repair its AI-owned input,
  recompile, and rerun `--check`; never restamp an old `scenarioRevision`.
- A data-model correction invalidates Gate 2 and downstream bindings, but does
  not rewrite Product Experience, Product Scope, or architecture unless it
  adds/removes a Product Scope concept or changes that concept's owner.
- Any Product Scope, persistence, Journey, or schema change invalidates the
  compiled data-model usage artifact. Repair its AI-owned input, recompile it,
  and rerun `--check`; never restamp its old revision.

Block only for an unsafe capability claim, missing explicit requirement,
invalid data relationship, a user decision/approval that is actually required,
or output that cannot validate or compile.

## Step 3.0 — Product Experience and Product Scope

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

Prefer one coherent bounded workspace when sequential steps share the same
recognizable object, source context, and final commit. Measurements, status
choices, identifiers, evidence, location, and confirmation may be sections,
rows, sheets, or contextual actions on that workspace when they remain usable
in one scroll. Split only for a durable return destination, a genuinely distinct
decision context, or capture that requires an immersive/full-screen surface.
Never split the same job merely because its facts map to different entities,
capabilities, or user roles.

Loading, empty, error, permission, success, and domain retry conditions are
screen states, never routes. Offline runtime conditions are package-owned
integration states, not screen states or routes. Do not create
List/Detail/Create/Edit for every entity. Equivalent record categories share
parameterized list/detail/form surfaces.

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
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-navigation-manifest.js" \
  --project-root "<working_dir>"
```

`.tmp/navigation-manifest.json` is the canonical deterministic navigation
projection of validated Product Scope. Product Scope remains the planning
authority: never hand-author the manifest or use it to make scope decisions.
Recompile it after every Product Scope repair. Do not compile screen build
packs until the manifest exists and its `scopeRevision` matches Product Scope.

Repair only the rejected contract. Do not proceed with warnings that represent
an unresolved user-visible assumption; surface those in Gate 1.

## Step 3.1 — Architecture decisions and persistence contract

Resolve architecture in the foreground before any publisher-prefix query,
Dataverse snapshot/cache/schema work, seed/service planning, Data Model
approval.

Read `template/package.json`; it is the native package allowlist. Do not claim
an unavailable native capability. Pure-JavaScript dependencies follow
`shared/references/javascript-dependency-planning.md` and remain separate from
native capabilities. Build the native-capability matrix with requirement/job,
owning screen/action, package/wrapper, retained output, persistence consequence,
permissions, platform behavior, fallback state, and availability evidence.

Follow `shared/references/connector-planning.md`. Confirm connector candidates
from the requirements, but do not treat confirmation as system-of-record
ownership. Ask a foreground architecture question only when an unresolved
capability, connector, or owner would change the architecture; batch related
unresolved choices into one question. Do not create a separate gate for each
decision.

Assign exactly one compatible owner to every `Product Scope.dataEntities`
concept:

- `dataverse` for Dataverse-owned durable data;
- `connector:<api-name>` for a concept owned by that approved connector;
- `local` for local configuration/prototype data;
- `transient` for non-persistent UI/view-model state.

Record a plain-language reason for every owner. A confirmed connector may be an
integration without owning any concept. Never duplicate a connector-owned
concept as a Dataverse table. Offline support is not a requirement, Product
Experience value, architecture decision, or persistence-contract field. The
create flow asks about it explicitly only after Dataverse materialization.

Write compact `.tmp/architecture-decisions.json` in the compiler's exact input
shape. Arrays contain approved decisions only; keep `approved: true` because the
compiler rejects connector ownership that is not backed by an approved
connector:

```json
{
  "schemaVersion": 1,
  "nativeCapabilities": [
    {
      "id": "camera",
      "displayName": "Camera",
      "persistenceConsequence": "Produces retained photo evidence",
      "approved": true
    }
  ],
  "connectors": [
    {
      "apiName": "sharepointonline",
      "displayName": "SharePoint Online",
      "approved": true
    }
  ],
  "conceptOwners": [
    {
      "conceptId": "inspection",
      "owner": "dataverse",
      "reason": "Inspections are app-owned records with an independent lifecycle."
    }
  ]
}
```

Compile the sole persistence authority and validate mode-forbidden artifacts
before continuing:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-persistence-contract.js" \
  --project-root "<working_dir>" --check-artifacts
```

The command writes `.tmp/persistence-contract.json` and derives exactly one of
`dataverse`, `mixed`, `connector-only`, or `local-prototype`. Stop on missing,
duplicate, unknown, incompatible, or unapproved ownership. Write
`_native_section.md` and `_connectors_section.md` from the same architecture
decisions; do not reconstruct them from plan prose later.

## Step 3.2 — Gate 1: experience, scope, and architecture

Gate 1 reviews Product Experience, Product Scope, requirement coverage,
navigation, approved native capabilities/connectors, every concept owner, the
compiled persistence mode. It does not review a physical Data Model because
that work is conditional on the approved persistence contract and has not run
yet. Offline support is asked separately after Dataverse materialization and is
not part of Gate 1.

Start `userApproval` immediately before the foreground `AskUserQuestion` and
finish it immediately after the response, before any repair, rendering, or
receipt work. On rejection, repair only the
owning Product Experience, Product Scope, or architecture value; rerun its
validators; recompile navigation and persistence; and invalidate only changed
downstream artifacts. After an accepted response and the post-response Build
Plan edit-journal check, record exact experience, scope, navigation,
architecture, persistence, section, and plan hashes atomically:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-plan-approval.js" approve \
  --project-root "<working_dir>" --gate 1
```

The command projects approved names into
`architectureSummary.nativeCapabilities[]` and
`architectureSummary.connectors[]` directly from architecture decisions. Never
hand-write, partially patch, or independently hash `.tmp/mobile-plan-status.json`.

Record the resumable Gate 1 boundary. Contracts are immutable authorities;
the approval receipt is explicitly mutable because later gates add bindings:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-pipeline-state.js" \
  --project-root "<working_dir>" --record --step "3.2" \
  --artifact "experience=.tmp/product-experience-contract.json" \
  --artifact "scope=.tmp/product-scope-contract.json" \
  --artifact "navigation=.tmp/navigation-manifest.json" \
  --artifact "architecture=.tmp/architecture-decisions.json" \
  --artifact "persistence=.tmp/persistence-contract.json" \
  --mutable-artifact "approval=.tmp/mobile-plan-status.json"
```

In `--consolidated-review`, preserve the same sequencing and resolved
persistence mode but defer this approval response to the consolidated review.
Do not use consolidated review to start Dataverse reads before persistence has
compiled.

## Step 3.3 — Conditional physical data model

Read `.tmp/persistence-contract.json` and branch only on `persistence.mode`.

### `connector-only` or `local-prototype`

Run `compile-persistence-contract.js --project-root "<working_dir>"
--check-artifacts` again. Do not query a publisher prefix, resolve Dataverse
planning identity, create a snapshot/evidence/cache, invoke
`/setup-datamodel`, or create `.tmp/dataverse-concepts.json`, `_dm_section.md`,
`.tmp/dataverse-schema-contract.json`, `.datamodel-manifest.json`, sample data,
  generated Dataverse services, or Mobile Offline Profile artifacts. A selected
  connector/local package integration contract remains valid and is not a
  Dataverse artifact.

Render `## Data Model` as `Not applicable` and list each concept with its
approved connector/local/transient owner from the persistence contract. Mark
the Build Plan `data-model` milestone complete with that owner summary. There
is no Data Model approval in these modes.

### `dataverse` or `mixed`

Only now detect the publisher prefix, resolve the selected environment for
planning, and create the bounded Dataverse snapshot:

```bash
PUBLISHER_PREFIX_JSON=$(node "${CLAUDE_SKILL_DIR}/../../scripts/detect-publisher-prefix.js" \
  "$ACTIVE_ENV_URL" --tenant-id "$ACTIVE_TENANT_ID")
DETECTED_PUBLISHER_PREFIX=$(node -e \
  "const j=JSON.parse(process.argv[1]); process.stdout.write(j.prefix || '')" \
  "$PUBLISHER_PREFIX_JSON")

PERSISTENCE_CONTRACT="<working_dir>/.tmp/persistence-contract.json"
CONCEPTS_PATH="<working_dir>/.tmp/dataverse-concepts.json"
SNAPSHOT_PATH="<working_dir>/.tmp/dataverse-foreground-planning-snapshot.json"
ARCHITECT_EVIDENCE_PATH="<working_dir>/.tmp/dataverse-architect-evidence.json"
PLANNING_TELEMETRY_PATH="<working_dir>/.tmp/dataverse-planning-telemetry.json"
INVENTORY_CACHE_PATH="<working_dir>/.tmp/dataverse-inventory-cache.json"

PLANNING_ENV_JSON=$(node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" \
  "$ACTIVE_ENV_ID" --no-cache)
ACTIVE_ENV_URL=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.environmentUrl || '')" "$PLANNING_ENV_JSON")
ACTIVE_TENANT_ID=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.tenantId || '')" "$PLANNING_ENV_JSON")

node "${CLAUDE_SKILL_DIR}/../../scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --output "$SNAPSHOT_PATH" \
  --concepts-file "$CONCEPTS_PATH" \
  --tables "<EXPLICIT_TABLES_FROM_DATAVERSE_CONCEPTS>" \
  --proposed-tables "<PROPOSED_TABLES_FROM_DATAVERSE_CONCEPTS>" \
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

If a selected Reuse, Extend, or Adapt target lacks full detail, reuse one
bounded, monotonic exact-name expansion for only the missing target names.
Never rerun broad discovery, and never repeat a name already attempted.

Before snapshot invocation, deterministically build
`.tmp/dataverse-concepts.json` by projecting Product Scope through
`persistence.dataverseConceptIds`. It must contain every and only those IDs.
Connector, local, and transient concepts must never appear, including as
convenience mirror tables. Classify actors as roles, fields as attributes,
workflow verbs as actions, enum values as statuses, and operating limits as
constraints rather than table candidates.

The full snapshot is validator-only from this point onward. Do not read, grep,
print, summarize, or paste it into model context. Validate the schema-version-2
compact sidecar once, then build one sealed architect work order containing:

- a run ID;
- confirmed requirement/job statements relevant to Dataverse;
- only Product Scope concepts listed in `persistence.dataverseConceptIds`;
- the publisher prefix;
- the complete `schema-dataverse-model-proposal.json` schema;
- the complete compact architect evidence JSON;
- validator feedback when this is one bounded correction attempt.

Do not include paths, the full Product Scope, the full persistence contract,
the raw snapshot, environment URL, tenant ID, credentials, plan prose, Journey,
or screen packs. Invoke `mobile-app:data-model-architect` in return-only mode.
The child has no tools and returns exactly one run-scoped proposal envelope. It
never writes files or asks the user. Save its return bytes unchanged to
`.tmp/dataverse-model-architect-response.txt`, then parse them mechanically:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/parse-dataverse-model-proposal-envelope.js" \
  --project-root "<working_dir>" \
  --run-id "<SEALED_WORK_ORDER_RUN_ID>"
```

The parser rejects a mismatched run ID, text outside the envelope, malformed or
schema-invalid JSON, inconsistent concerns, or more than one content block. It
atomically writes only the validated JSON body to
`.tmp/dataverse-model-proposal.json`. Exit `3` carries the bounded
`NEEDS_CONTEXT` detail; exit `4` is an explicit architect `BLOCKED`; exit `2`
means the response itself violated the envelope contract.

If `Task` is unavailable or cannot invoke plugin agents, author exactly the same
proposal shape in the foreground from the same sealed inputs. Do not fall back
to `/setup-datamodel`, live discovery, raw-snapshot reasoning, or Markdown-first
schema authoring. The compact proposal compiler remains the sole downstream
path:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-dataverse-model-proposal.js" \
  --project-root "<working_dir>"
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-dataverse-model-proposal.js" \
  --project-root "<working_dir>" --check
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-dataverse-planning-decisions.js" \
  --contract "<working_dir>/.tmp/dataverse-schema-contract.json" \
  --snapshot "$SNAPSHOT_PATH"
```

Handle validator outcomes mechanically:

- Exit `0`: continue. The compiler wrote `_dm_section.md` and the normalized
  schema contract from one proposal.
- Exit `3` with `detailed-dataverse-metadata:<names>` or
  `proposed-dataverse-names:<names>`: run one monotonic expansion for only those
  previously unattempted names, overwrite the snapshot atomically, rerender the
  compact evidence, and redispatch/re-author the proposal once.
- Exit `4` with `NEEDS_REVISION: dataverse-plan-validation`: correct the proposal
  once from the same compact evidence. Do not query Dataverse or ask the user
  unless the correction changes business semantics.
- Exit `2`, a repeated exit `3` for an already attempted name, or a repeated
  exit `4`: stop with the exact safe diagnostic.

The expansion command reuses the current snapshot and never repeats inventory:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --output "$SNAPSHOT_PATH" \
  --base-snapshot "$SNAPSHOT_PATH" \
  --tables "<ONLY_MISSING_FULL_DETAIL_NAMES>" \
  --proposed-tables "<ONLY_UNCHECKED_PROPOSED_NAMES>" \
  --combined-base-read \
  --read-concurrency 1 \
  --telemetry-output "$PLANNING_TELEMETRY_PATH" \
  --planning-timings-output "$PLANNING_TIMINGS_PATH"
node "${CLAUDE_SKILL_DIR}/../../scripts/render-dataverse-architect-evidence.js" \
  --snapshot "$SNAPSHOT_PATH" \
  --output "$ARCHITECT_EVIDENCE_PATH"
```

Require snapshot-bound validation before Reuse, Extend, Create, Adapt, or M:N
approval. In `mixed` mode, reject the proposal if any connector, local, or
transient concept appears in the schema contract. A null publisher detection may
use a visible placeholder, but it never broadens the persistence projection.

## Step 3.4 — Workflow Journey and screen build packs

Read the exact Workflow Journey, screen-build-pack, and persistence contracts.
Build the screen graph from Product Scope screens and its compiled
`.tmp/navigation-manifest.json` projection; do not infer routes from the data
model.

For each core job, author ordered journey steps whose `satisfies` IDs cover the
job's locked `criticalSteps`. A step may reuse an existing screen as a section,
sheet, modal, flow step, or contextual action. Preserve route parameters,
navigation intent, domain operations, success, recovery, and resumability.

Every read, create, update, delete, sync, upload, download, or retained-artifact
operation must name its Product Scope `conceptId` and the exact owner from
`.tmp/persistence-contract.json`. Bind Dataverse concepts only to their
Dataverse service, connector concepts only to that connector's generated
service, local concepts only to the approved package/local adapter, and
transient concepts only to view-model state. Reject missing or contradictory
bindings. `mixed` never routes a connector/local concept through a mirrored
Dataverse table.

For every user-facing screen, author one pack preserving UX quality:

- one obvious first-viewport focal point and visible primary action;
- product-specific hierarchy and realistic content;
- signature interaction/component usage;
- media role, source, treatment, aspect/crop intent, and fallback when needed;
- trust and decision-support evidence;
- applicable loading, empty, error, permission, and success states;
- navigation consistent with durable destinations and bounded flows;
- data operations bound to the concept's compiled persistence owner;
- accessibility, Dynamic Type, keyboard, touch-target, and safe-area needs;
- forbidden defaults preventing generic dashboard/CRUD substitution.

Journey and build packs must never declare `states.offline`, an offline
component, or an offline-only route/job. The installed package integration owns
connection status, queued, syncing, failed, retry, and conflict UX outside the
screen contract. Planning must not turn prompt language about connectivity into
an offline state, component, table, route, or job. Do not create an operational
dashboard for a discovery/commerce product unless the approved jobs justify it.

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

The screen-pack compiler's `screen-owned-offline-state` finding is blocking.

### Compile canonical scenario facts

After Journey and compiled packs exist, the foreground authors
`.tmp/scenario-facts-input.json`. The model owns realistic records,
relationships, cross-record invariants, media choices and stable asset keys,
and each screen binding. The deterministic validator only resolves declared
references, enforces supported invariant operators, and binds revisions; it
never invents copy, dates, statuses, counts, images, or domain facts.

Author one compact happy-path scenario for each primary journey plus only the
contrasting records/states required by the approved graph. Do not create an
independent fixture set per screen. Every preview value, seed obligation, and
builder fixture must trace to this one artifact.

Compile and check the exact bindings to Product Scope, persistence, navigation,
Workflow Journey, and compiled screen packs:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-fixture-scenarios.js" \
  --project-root "<working_dir>"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-fixture-scenarios.js" \
  --project-root "<working_dir>" --check
```

### Compile data-model usage traceability

After the conditional physical-schema branch and after Journey and build packs
are authored, the foreground writes `.tmp/data-model-usage-input.json`. This is
a compact AI-owned mapping, not a deterministic projection: each schema table
binds its Product Scope concept, and each field and relationship binds canonical
requirement, job, screen, domain-operation, integration, reporting, or audit
consumer IDs. A field with no product consumer may instead carry one supported
typed system exemption. The deterministic validator never infers consumers
from table, field, relationship, screen, or operation names.

For `connector-only` and `local-prototype`, write exactly the same input shape
with `tables: []` and keep the Dataverse schema absent. Every shipping
requirement with a persistable Journey operation must still resolve through
Journey plus `.tmp/persistence-contract.json` to exactly one connector, local,
or transient owner as applicable. Empty schema coverage never means empty
requirement ownership.

Compile and then check the bound artifact:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-data-model-usage.js" \
  --project-root "<working_dir>"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-data-model-usage.js" \
  --project-root "<working_dir>" --check
```

The first command writes `.tmp/data-model-usage.json`; the second verifies its
Product Scope, persistence, Journey, conditional schema, and content-revision
bindings. A failure repairs the owning mapping or upstream contract and then
reruns both commands. Do not infer a replacement mapping from names.

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
## Native Capabilities
## Connectors
## Persistence
## Data Model
## Design
## Screens
## Approval Status
## Plan Provenance
```

`## App Requirements` contains the confirmed brief without expansion. `##
Product Scope` contains jobs, deferred functionality, review ceilings, and
requirement coverage. `## Persistence` projects mode and the owner/reason for
every concept from the persistence contract. `## Data Model` is `Not
applicable` with those owners in `connector-only` and
`local-prototype`; otherwise it projects only Dataverse-owned concepts. `##
Screens` contains navigation, classification, Screen Map, journey, and
per-screen pack summaries. Discovery diagnostics belong in `memory-bank.md`,
not the plan.

## Step 3.6 — Gate 2: conditional Data Model and execution contracts

All questions and approvals use foreground `AskUserQuestion` and plan mode. No
child may ask the user or enter/exit plan mode. Gate 2 reviews:

- the snapshot-validated Data Model for `dataverse` or `mixed`, limited to
  `persistence.dataverseConceptIds`;
- `Not applicable` ownership rendering for `connector-only` or
  `local-prototype`, without a Data Model approval;
- screen graph/navigation, Workflow Journey, compiled packs, and every
  operation-to-owner binding;
- compiled data-model usage traceability for every mode, including requirement
  ownership when the physical Data Model is not applicable;
- scenario consistency across records, relationships, media keys, invariants,
  screen bindings, and the primary journey.

Immediately before presenting Gate 2, rerun
`validate-fixture-scenarios.js --project-root "<working_dir>" --check` and
`validate-data-model-usage.js --project-root "<working_dir>" --check`. Gate 2
cannot approve a missing, stale, or rejected scenario or usage artifact.

Immediately before Gate 2 and again after its response, check
`.tmp/mobile-build-plan-edits.json` as specified by the Build Plan protocol. A
schema-only edit within already Dataverse-owned concepts cancels the handoff,
reruns affected Data Model/Journey/pack validation, and reopens Gate 2. An edit
that adds/removes a Product Scope concept or changes ownership reopens Gate 1,
recompiles persistence, and invalidates all mode-dependent downstream work.

Start `userApproval` immediately before the question and finish it immediately
after the response. On rejection, edit only the owning canonical values, rerun affected validators,
recompile downstream contracts, and rerender affected plan sections. On
acceptance and the post-response edit-journal check, run:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-plan-approval.js" approve \
  --project-root "<working_dir>" --gate 2
```

On acceptance, update `.tmp/mobile-plan-status.json` only through this command.
It validates Gate 1 section hashes and records exact contract revisions,
the compiled `scenarioRevision` and `usageRevision`, Data Model hash when applicable,
operation-owner binding status, approval state, and current plan hash. It marks
`approvals.scenarioFacts` and `approvals.dataModelUsage` approved in the same
atomic receipt update. Preserve prior approved
sections whose hashes did not change. Any bound upstream change invalidates from
the owning gate through the same approval library and requires a fresh compile,
check, and review.

Record the completed planning boundary after Gate 2. Re-supply the mutable
receipt and introduce the human plan as mutable because Gate 3 adds design and
approval status without changing the previously approved canonical contracts:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-pipeline-state.js" \
  --project-root "<working_dir>" --record --step "3.9" \
  --artifact "journey=.tmp/workflow-journey-contract.json" \
  --artifact "build-pack=.tmp/compiled-screen-build-pack.json" \
  --artifact "scenario-facts=.tmp/scenario-facts.json" \
  --artifact "data-model-usage=.tmp/data-model-usage.json" \
  --mutable-artifact "plan=native-app-plan.md" \
  --mutable-artifact "approval=.tmp/mobile-plan-status.json"
```

For `dataverse` or `mixed`, add immutable `dataverse-concepts`, `architect-evidence`,
`dataverse-proposal`, and `dataverse-contract` artifact flags to this command.
For connector/local modes, omit them. Never record a placeholder file.

In `--consolidated-review`, keep Gate 1 and Gate 2 sections pending and defer
their single response until the required experience preview is materialized.
The artifacts, mode branch, and validation order remain identical.

Time each rejection/repair loop as `planRepair`, with `--retry` on subsequent
attempts. The approval wait ends as soon as the user responds; repair time is
never recorded as approval latency.

Gate 3 remains the required design/experience preview approval. Gate 4 remains
the final implementation confirmation. No mutation begins until the current
approval receipt binds the applicable review states and artifact hashes.

## Step 3.7 — Persistence and conditional Dataverse execution gate

Recheck `.tmp/mobile-build-plan-edits.json` before binding the Phase 3
checkpoint. Never restamp an approval receipt invalidated by a browser edit;
return through Gate 2 for a schema-only change or Gate 1 when scope/ownership
changed.

Always recompile and check mode-forbidden artifacts first:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-persistence-contract.js" \
  --project-root "<working_dir>" --check-artifacts
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-fixture-scenarios.js" \
  --project-root "<working_dir>" --check
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-data-model-usage.js" \
  --project-root "<working_dir>" --check
```

Require the resulting `persistenceRevision` to match the Gate 1 receipt and
branch on `persistence.mode`:

- `connector-only` / `local-prototype`: require `## Data Model` to be `Not
  applicable` with every concept owner rendered. Require no publisher prefix,
  Dataverse concepts/snapshot/evidence/cache/schema, `_dm_section.md`,
  `.datamodel-manifest.json`, generated Dataverse service, seed, or Offline
  Profile artifact. Do not run schema normalization or snapshot validation.
- `dataverse` / `mixed`: require `.tmp/dataverse-concepts.json` IDs to equal
  `persistence.dataverseConceptIds` exactly. Verify the approved schema contract
  uses the detected publisher prefix and realizes only those concepts. In
  `mixed`, any connector/local/transient concept represented as a Dataverse
  table is blocking. Normalize and validate against the Phase 3 snapshot:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/build-dataverse-operation-manifest.js" \
  --normalize-contract "<working_dir>/.tmp/dataverse-schema-contract.json" \
  --output "<working_dir>/.tmp/dataverse-schema-contract.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-dataverse-planning-decisions.js" \
  --contract "<working_dir>/.tmp/dataverse-schema-contract.json" \
  --snapshot "<working_dir>/.tmp/dataverse-foreground-planning-snapshot.json"
```

For every mode, require the checked data-model usage artifact to bind Workflow
Journey operations and persistable requirements to matching
`persistence.conceptOwners` entries. Do not parse Mermaid or plan prose as an
executable fallback, and never permit `states.offline` in Journey or build-pack
data. No mutation phase, and specifically no Dataverse write, may begin from a
missing, invalid, or stale usage artifact.

The Gate 1 and Gate 2 commands above are the checkpoint owners in
`.tmp/pipeline-state.json`. They preserve Product Experience, Product Scope,
navigation, architecture, persistence, Journey, build packs, scenario facts,
data-model usage, human plan, and receipt revisions. For `dataverse` / `mixed`,
the Gate 2 checkpoint also records Dataverse concepts, architect evidence,
compact proposal, and schema contract. Connector/local modes record no
placeholder Dataverse files.

Step 6.75 may update design and approval artifacts, but it must not regenerate
Product Experience, Product Scope, architecture decisions, persistence, data
model, Journey, or screen packs merely to restamp bookkeeping.

Finally record measured planning history:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-eta.js" \
  --project-root "<working_dir>" --record
```