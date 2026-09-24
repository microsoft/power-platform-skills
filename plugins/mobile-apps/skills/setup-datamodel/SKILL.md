---
name: setup-datamodel
description: Use when the user wants to design or redesign the Dataverse schema and connector plan for an existing mobile app, or has an ER diagram (image, Mermaid, or text) to apply. Skip when the user is creating a brand-new app — /create-mobile-app handles the data model inline.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, EnterPlanMode, ExitPlanMode, Task, Skill
model: opus
---

**📋 Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

# Set Up Data Model + Connectors

**Entry routing:** use the shared [App feature entry points](../../shared/shared-instructions.md#app-feature-entry-points)
preflight before the workflow below.

This standalone workflow implements the data-only choice or a project without
a complete app plan, subject to the shared missing-plan safeguards.

Combined orchestrator for standalone data source planning. Designs the Dataverse schema, plans connectors, gets approval on both, then delegates execution to `/add-dataverse` and `/add-connector`.

| Use this skill when | Use `/add-dataverse` directly when |
|---|---|
| Standalone schema + connector design (project may or may not exist yet) | The plan already exists and you just need to apply tables + generate services |
| You have an existing ER diagram (image / Mermaid / text) to import | `/create-mobile-app` is invoking this as a sub-step with approved scoped context |
| Re-planning the schema or connectors mid-project | You only need to add a single table or a single connector |

## Workflow

1. Resolve project root & verify auth → 2. Design data model → 3. Plan connectors → 4. Combined approval → 5. Execute additions/refreshes → 6. Execute connectors → 6.25 Retire approved bindings → 6.5 Reconcile offline profile → 7. Reconcile inventory & summarize

---

### Phase 1 — Verify Project & Auth

Resolve one absolute `working_dir` before reading project files or discovering
the environment:

- For a nested call, inherit the owner's absolute `working_dir`. If
  `--working-dir` is also supplied, both must resolve to the same directory;
  a mismatch returns `NEEDS_CONTEXT` before any project or cloud work.
- For a direct call, resolve an explicit `--working-dir` against the invocation
  directory. Only a direct call without an override may use that invocation
  directory as its project root.
- Require the selected directory to exist, normalize it to one absolute path,
  and retain it for this invocation. A missing nested owner path is an error:
  never fall back to the shell's current directory or search neighboring apps.

All relative app paths below, including diagram inputs, `native-app-plan.md`,
`_dm_section.md`, `.datamodel-manifest.json`, `offline-profile.json`, and
`memory-bank.md`, are relative to this resolved root, not a later tool's cwd.
Use absolute paths with file tools. Begin every shell invocation that reads or
writes app-local files with `cd "<working_dir>" || exit 1`; shell state does not
carry across tool calls.

Confirm the selected root is a Power Apps mobile app:

For `--plan-only` or a planning-phase handoff, perform the file/environment
checks read-only and use the shared proposal-only environment-context rule.
Skip the resolver command below in that mode; incomplete or conflicting context
returns `NEEDS_CONTEXT`, not permission to persist environment configuration.
The shell block below is for the implementation-mode workflow only.

```bash
cd "<working_dir>" || exit 1
if [ ! -f power.config.json ] || [ ! -f app.config.js ]; then
  printf '%s\n' 'ERROR: selected working directory is not an initialized mobile app' >&2
  exit 1
fi
environment_id="$(node -p "require('./power.config.json').environmentId || ''")" || exit 1
if [ -z "$environment_id" ]; then
  printf '%s\n' 'ERROR: selected app has no environmentId' >&2
  exit 1
fi
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$environment_id"
```

Stop on failure; do not switch directories or re-scaffold. Capture the
**environment URL**, **environment ID**, **tenant ID**, and **organization ID**
for this root for Phase 5. Pass this same absolute root in every planner/skill
handoff and on retries.

### Phase 2 — Design Data Model

**Telemetry checkpoint: `design_dataverse_schema`**

Check whether the request needs Dataverse schema first; connector-only requests
take Path C. Otherwise check `$ARGUMENTS` for diagram hints (`*.png`, `*.jpg`,
`erDiagram`, `||--o{`). If present, take Path A. If a Dataverse requirement is
already supplied, take Path B for a read-only proposal. If the choice is still
unknown, ask:

> "How would you like to define the data model?"

| Option | What happens |
|---|---|
| Upload an existing ER diagram | Provide a PNG/JPG path, Mermaid block, or text description |
| Let the Data Model Architect propose one (default) | Spawns `data-model-architect` agent to infer from requirements |
| Skip — no Dataverse tables needed | Jump to Phase 3 |

Recommend "architect propose" only when Dataverse schema is needed. Connector-only
requirements take Path C without inventing Dataverse tables. Empty/cancel input
does not approve a choice; wait for an answer or stop.

#### Artifact storage rules for PDFs and signatures

When requirements mention signatures, sign-off, ink, drawings, generated PDFs, exported reports, evidence packets, or retained documents, make the storage target explicit in `## Data Model` before approval:

| User signal | Dataverse model implication |
|---|---|
| "capture signature", "sign off", "approval signature", "ink" | Ask whether retention is needed; only when Dataverse retention is selected, reuse or propose an Image/File column or child Evidence/Signature table |
| "generate PDF", "export report", "evidence packet", "certificate PDF" | Ask whether the generated PDF should be retained. If yes, use a Dataverse File column, usually on the parent record or a child Evidence/Attachment table. If no, document on-device/share-only behavior and add no column. |
| "upload PDF", "attach file", "import document" | File column or child Attachment table with lookup to parent |
| "view PDF" | Store or reference an HTTPS URL if the app has a durable source. Native PDF viewer 0.2.9+ also supports local `file://` URIs; `content://`, `blob:`, and `http://` remain unsupported. |

PDF content must never be modeled as long text/base64 text. Use Dataverse File columns for retained PDFs. Signature PNGs may use Image columns when the generated service supports image payloads; use File columns or child Evidence rows when the capture should behave like an attachment.

#### Path A — Parse user-provided diagram

Accept PNG/JPG (use `Read` to view), Mermaid syntax (paste in chat), or text
description. Parse tables, columns, and relationships. Query existing Dataverse
tables to mark each as new / extend / reuse. Draft the Mermaid diagram and Data
Model section for the combined Phase 4 approval; do not update the live plan yet.

#### Path B — Spawn data-model-architect

```
Task: mobile-app:data-model-architect

Prompt:
  You are the data-model-architect agent for a Power Apps mobile app.
  Requirements: <$ARGUMENTS or ask the user what the app does>
  Working directory: <working_dir>
  Output proposal: <working_dir>/_dm_section.md
  Plugin root: ${PLUGIN_ROOT}

  Follow your agent file. Return a ## Data Model section with Mermaid ER diagram,
  reuse/extend/create table, and dependency-tier ordering. If requirements mention
  signatures, pen/ink, generated PDFs, report exports, evidence packets, or uploaded
  documents, include the artifact storage target: on-device/share-only, Dataverse
  Image column, Dataverse File column, or child Evidence/Attachment table. Retained
  PDF content must use a File column, not long text/base64.
```

Parse the agent's first-line status using the `AGENTS.md` return protocol.
Keep the returned section as a proposal for Phase 4; stop on `BLOCKED` and return
missing context to the foreground rather than treating the proposal as approved.

#### Path C — No Dataverse

Propose no Dataverse changes. Preserve any existing Data Model section; only use
"None — no Dataverse tables needed" when the project has no Dataverse model.
Continue to Phase 3 without overwriting the plan.

### Phase 3 — Plan Connectors

**Telemetry checkpoint: `plan_connector_integrations`**

Follow [`shared/references/connector-planning.md`](${PLUGIN_ROOT}/shared/references/connector-planning.md):

1. **Infer** — if `$ARGUMENTS` describes what the app does, scan for connector keywords. Build a candidate list.
2. **Confirm** — present via `AskUserQuestion`. Let the user add, remove, or confirm.
3. **Record** — build the `## Connectors` section.

If the user provided no requirements context, ask:

> "What does your app need to connect to? (e.g. SharePoint, Teams, email, Excel, OneDrive, Azure DevOps — or none)"

### Phase 4 — Combined Approval

**Telemetry checkpoint: `approve_data_model_and_connectors`**

For an existing data-only plan, compare current bindings with the proposal before
writing it. Apply [data-source-removal.md](../../shared/references/data-source-removal.md)
to classify and approve removals explicitly. Omitted tables are not automatic
deletions; retain anything required by existing consumers or route the feature
through `/edit-app` for their planned update.

**Proposal-only exit:** if `--plan-only` is present or the caller's phase is
planning, present the proposed Data Model, Connectors, and retirement/offline
impact, then return to the caller and STOP before the execution approval below.
Do not save `native-app-plan.md`, mint approval receipts, update the materialized
manifest, or invoke Phases 5–7. A scratch proposal is not an applied plan.
Approval to review the proposal does not override `--plan-only`; implementation
requires a separate request without that flag and approval of its exact delta.

Present the full plan — data model + connectors — together in a single `EnterPlanMode` block:

```
## Plan: Data Sources

### Data Model
[reuse/extend/create table]
[Mermaid ER diagram]
[creation order tiers]

### Connectors
[connector table or "None"]

Approve both to proceed with execution?
```

- **Approved** → save both approved sections to `native-app-plan.md`, preserving
  unrelated sections, then proceed to Phase 5. This applies to every Phase 2 path,
  including architect output and connector-only plans.
- **Change data model** → loop back to Phase 2 for that section only, then re-present Phase 4
- **Change connectors** → loop back to Phase 3, then re-present Phase 4
- **Cancel** → stop without applying the proposed plan or data-source mutations.

Save the accepted proposal into `<working_dir>/native-app-plan.md`; scratch
`_dm_section.md` is not a second source of truth. Do not reuse operation manifests
or approval receipts bound to the previous plan. The verified materialized
manifest is updated after execution/verification, not by copying proposed rows.

### Phase 5 — Execute Data Model

**Telemetry checkpoint: `apply_dataverse_schema`**

Invoke `/add-dataverse` with `--skip-planning` so it reads the approved plan directly without re-prompting:

Apply only additions/refreshes here. Skip this phase for a removal-only delta;
approved retirements have their own Phase 6.25 handoff.

For a service-only refresh of an already registered table, use the leaf's
`--refresh --data-source-name "<registered-name>"` branch and pass its exact
registered identity in `approved_scope`; do not execute the schema-add handoff
below for that row. For schema changes, retain the normal handoff below.

```
Invoke skill: /add-dataverse

Context:
  MOBILE_APP_ORCHESTRATING=1
  orchestrator: setup-datamodel
  working_dir: <working_dir>
  phase: implementation
  approved_scope: <approved Data Model operations and answers>

Arguments:
  --working-dir "<working_dir>"
  --plan-section "<working_dir>/native-app-plan.md#data-model"
  --skip-planning
```

`/add-dataverse` creates tables in tier order, runs `npx power-apps add-data-source --api-id dataverse --org-url <envUrl> --resource-name <name>` per table from the app root, publishes customizations, writes `.datamodel-manifest.json`, and type-checks. Wait for it to return before Phase 6.

**Cross-entity reads from the screen plan** — the approved
`### Cross-entity Reads` subsection contains formatted lookups, bounded chained
fetches, or `external-projection-required` blockers. `/add-dataverse` never
synthesizes calculated/formula definitions through code. A user-supplied,
maker-created computed column is validated as an existing dependency during
reconciliation before it can be reused.

Skip if Phase 2 chose Path C (no Dataverse).

### Phase 6 — Execute Connectors

**Telemetry checkpoint: `generate_connector_data_sources`**

Read `## Connectors` from `native-app-plan.md`. For each approved added/refreshed
connector row (not retained or retiring rows), invoke `/add-connector`:

Separate the operation before dispatch: an added row takes the normal handoff;
a refreshed row adds `--refresh --data-source-name "<registered-name>"` and
includes the verified API/dataset/connection identity in `approved_scope`.
Do not infer the registered name from the connector display label. The refresh
branch must return without connection creation or `add-data-source`.

```
Invoke skill: /add-connector

Context:
  MOBILE_APP_ORCHESTRATING=1
  orchestrator: setup-datamodel
  working_dir: <working_dir>
  phase: implementation
  approved_scope: <approved connector row and answers>

Arguments:
  --working-dir "<working_dir>"
  --connector <api-name>
```

Run sequentially. Skip if `## Connectors` is "None".

### Phase 6.25 — Retire unused app bindings

For each explicitly approved retirement, invoke the matching leaf with
`--remove`, `MOBILE_APP_ORCHESTRATING=1`, `orchestrator: setup-datamodel`,
`phase: implementation`, `working_dir: <working_dir>`, the argument
`--working-dir "<working_dir>"`, and its `approved_scope`.
Follow [data-source-removal.md](../../shared/references/data-source-removal.md).
This standalone data-only flow does not edit consumers: if any remain, stop and
return their integration work to `/edit-app` instead of breaking them.
Verify the CLI cleanup and reconcile the actual remaining generated-service
snapshot and app manifest before the summary. No retirement set means skip.
Preserve each leaf's `offlineRetirement` outcome from the shared removal contract,
including unresolved outcomes recorded in memory-bank by an earlier attempt.
App-binding cleanup and offline-profile migration have separate completion states.

### Phase 6.5 — Offline profile reconciliation

**Telemetry checkpoint: `reconcile_offline_profile`**

If Phase 5 created or extended Dataverse tables, an existing Mobile Offline Profile may now be missing those tables/columns. Because Phase 5 invoked `/add-dataverse` with `--skip-planning` (which suppresses that skill's own Step 8.5 reconciliation), this orchestrator owns the check. Skip the addition check when Phase 2 chose Path C (no Dataverse), but never discard a recorded `offlineRetirement` outcome.

Run the local, no-network delta check:

```bash
cd "<working_dir>" || exit 1
node "${PLUGIN_ROOT}/scripts/offline-profile-delta.js" --project-root "<working_dir>"
```

Branch on the JSON `status` per [offline-profile-reconciliation.md](${PLUGIN_ROOT}/shared/references/offline-profile-reconciliation.md): `no-manifest` / `no-profile` / `in-sync` → no addition work; continue to Phase 7 with the existing `offlineRetirement` outcomes unchanged (do not nag when no profile exists). `delta` → prompt to update, then read and execute `${PLUGIN_ROOT}/skills/add-table-to-offline-profile/SKILL.md` for `missingTables[]` and `${PLUGIN_ROOT}/skills/edit-offline-profile/SKILL.md` for `tablesWithNewColumns[]`, passing the arguments documented by each workflow, and re-check to `in-sync`. Declined or incomplete addition work remains a separate concern.

These offline helpers also inherit the same absolute `working_dir`; no new root
discovery is permitted during reconciliation.

### Phase 7 — Summary

Before success, reconcile each affected plan section with this project's verified
output and refresh the Generated Services snapshot. For Dataverse changes, also
reconcile `.datamodel-manifest.json`, retaining a valid empty inventory after
removing the last Dataverse binding. Connector-only work without Dataverse does
not require or create a Dataverse manifest. Record partial execution or unresolved
removals in memory-bank and return a non-success status rather than claiming the plan is fully applied.

Render the summary from verified results, not the example's possible artifacts.
For connector-only work without a Dataverse inventory, report Data Model and
Manifest as `not applicable`; do not print a nonexistent manifest path. If a
verified inventory already exists but was untouched, label it `unchanged`.

Include every affected table's `offlineRetirement` status in memory-bank and the
final response. `pending` returns `DONE_WITH_CONCERNS`, not a clean `DONE`:
"App changes completed. The offline profile still includes Orders; deciding
whether to retain or remove that coverage is pending."
Use actual table names and verified app results; if app cleanup failed, report
that failure instead of claiming completion. `retained` reports the approved
reason; `reconciled` requires verified profile migration, not an `in-sync` result.

```
✅ Data sources set up
─────────────────────────────────────────────
Data model:
  Tables reused  : <list>
  Tables extended: <list>
  Tables created : <list>
  Manifest      : <verified manifest path and updated/unchanged status, or "not applicable">

Connectors:
  <list of added connectors, or "None">

Generated services:
  src/generated/services/ × <N>
  src/generated/models/   × <N>

Type-check: PASS

Next steps:
  /add-datasource   — add more data sources
  /add-native       — add device capabilities
  /edit-app         — integrate these services into app screens
─────────────────────────────────────────────
```

## Reference

- [shared/references/connector-planning.md](${PLUGIN_ROOT}/shared/references/connector-planning.md) — connector inference + confirmation logic
- [shared/references/offline-profile-reconciliation.md](${PLUGIN_ROOT}/shared/references/offline-profile-reconciliation.md) — Phase 6.5 offline delta check + reconciliation flow
- [skills/add-dataverse/SKILL.md](../add-dataverse/SKILL.md) — full data model execution workflow
- [agents/data-model-architect.md](../../agents/data-model-architect.md) — read-only architect agent
