# Phase 2 of 10 — Planning

**Steps:** 3. **Previous:** [1 — Intake](phase-01-intake.md). **Next:** [3 — Scaffold](phase-03-scaffold.md).
[Phase index](../SKILL.md#load-only-the-active-phase). Advance only after this phase's exit condition passes.

### Step 3 — Plan and approve architecture

**Telemetry checkpoint: `plan_app_architecture`**

Precondition: explicit Step 2c proceed; resolved intended environment; installed fresh template
or confirmed resume. Create project-local `.tmp/` only now.
All app mutations are deferred. Allowed planning files: `native-app-plan.md`, `_dm_section.md`,
`_screens_section.md`, `.tmp/*`. Queue concerns/discovery notes until the bank exists.

The foreground dispatches each leaf directly. Do not dispatch an agent to orchestrate other
agents or hold human gates. Apply the [root status handler](../SKILL.md#step-30--sub-agent-return-status-switch-canonical)
after each real dispatch; if agent tooling is unavailable, execute that same leaf contract here.
No no-op probes, second fallback workflow, or skipped approvals.

## 3.0 — Experience and information needs before data

Before snapshot discovery, table proposals or fixed routes, foreground shapes the working
experience from the confirmed brief. Preserve the user's requirements verbatim and separately
record a compact `### Experience outline` and `### Information needs` under `## App Requirements`.
These extend the existing plan; do not create a second product contract or invoke another planner.

Trace the primary job through entry, repeated decisions/actions, necessary context, completion
and interruption/recovery. Keep sequential work on the same object together when usable; use
a separate surface only for a distinct decision, durable destination or focused capture.
This is a provisional journey, not an approved route graph or a commitment to a screen count.
Apply [experience synthesis](${PLUGIN_ROOT}/shared/references/design-planning.md#experience-synthesis):
identify recognition, working rhythm, decision evidence, useful grouping/density and disclosure.
Choose fields and relationships from these needs, not extra cards or every noun in the prompt.

Classify each addition as explicit requirement, safe presentation, sample value or proposed scope.
Safe presentation may group existing facts or clarify an action; new business operations, roles,
integrations, offline persistence or evidence history are proposed scope, not implicit permission.
Resolve consequential uncertainty through the existing owning gate before depending on it.
No new questionnaire or approval gate; `--no-design` still requires useful journeys/data coverage.

Information needs pair the user decision/fact/action with its semantic source: stored field,
derived inputs/units, related read, write/transition, retained artifact or native/local capability.
Record required versus explicitly deferred scope. Do not invent exact existing columns before
evidence. Preserve useful needs while assessing feasibility; do not minimize the schema first.

## 3.1 — Architecture proposal and Gate 1

Dispatch `mobile-app:native-app-planner` for **only** native capabilities, connector needs and
provisional design context with the confirmed brief, wizard facts, provisional data-platform choices,
the Experience outline/Information needs, plugin root, working directory and output `.tmp/native-integration-proposal.md`.
It cannot ask questions, run gates, assemble approval records or invoke architects.
Resolve its `NEEDS_CONTEXT` in foreground. Surface excluded capabilities before approving scope.
No publisher discovery, Dataverse snapshot or data-model-architect dispatch occurs before Gate 1.
Use [connectivity intent ownership](${PLUGIN_ROOT}/shared/references/connectivity-intent-ownership.md)
throughout proposals; connectivity wording alone adds no storage, services, routes or sync UI.

Foreground assembles the human plan skeleton. Keep these independent top-level sections:
`## Overview`, `## App Requirements`, `## Data Model`, `## Native Capabilities`,
`## Design Direction`, `## Design` (existing design execution fields), `## Connectors`,
`## Screens`, `## Approvals`. Provenance may be a short separate section.
The confirmed brief stays verbatim, compact and separate from architecture; do not nest schema
under a `## Brief`. **Do not duplicate raw evidence**: embed proposal decisions, not raw
rankings/columns/timings; retain the separately referenced evidence appendix.
Keep data-model implementation notes under one concise `### Notes`; queue discovery diagnostics
for the bank. Do not write links to nonexistent operational documents.

Use the host's actual question interface and available plan-mode tools per the shared core.
Present each section, capture an explicit user answer, then record what was approved and when.
`DONE`, empty answers, entering plan mode and recommendations never approve a section.
On rejection revise only that section, invalidate dependent approvals, then present it again.
If no permitted question interface exists, stop with the pending approval; do not dispatch more work.

### Gate 1 — Data platform + native capabilities + connectors

Foreground presents each source of truth, proposed Dataverse mode and both capability/connector
matrices including `None`, exclusions, capture/output and retained-artifact destinations.
Approve these together before modeling. Empty matrices are not self-approval.
Before acceptance and whenever a platform, connector or storage choice changes, revalidate
every native capability against its supported input/output and storage path:

- Connector-owned storage needs a supported upload/write operation, not just a connector name.
- Dataverse File/Image host controls require Dataverse. Continuous `geolocation` requires
  its supported Dataverse target; one-shot `location` is not an automatic replacement.
- Do not silently remove capabilities to fit connector-only mode. Foreground resolves the
  incompatible combination or asks for an explicit scope change before acceptance.

Record the accepted data platform, confirmed `required`/`connector-only` mode, native capabilities,
connectors and actual approval timestamps in `native-app-plan.md` under `## App Requirements`,
the owning sections and `## Approvals`. Keep recommendations separate from these approvals.
Do not create an architecture sidecar or a Dataverse receipt before a schema exists.
Validate these recorded decisions before discovery and architect dispatch, including on resume.
Missing, malformed, stale or contradictory approval returns to Gate 1, not a generic worker
retry or a silent fallback to required mode. Changed architecture invalidates dependent model,
graph/spec and receipt approvals. The foreground owns this check even without agent tooling.

## 3.2 — Verified data evidence and remaining approval gates

For Gate 1-approved `required`, execute deferred Step 1.7 prefix detection, then read and execute
[planning-snapshot.md](planning-snapshot.md). The foreground owns evidence, progress rendering
and bounded exact-name expansions. For approved `connector-only`, skip prefix discovery,
snapshot and data-model-architect entirely; create an explicit zero-table/no-Dataverse
`## Data Model` proposal. No Dataverse schema contract or receipt is created in that mode.

Dispatch `mobile-app:data-model-architect` directly in required mode:

```text
Requirements brief: <confirmed brief verbatim, including workflow/domain context>
Experience outline and Information needs: <foreground-derived journey, decisions, fact/action needs and classified assumptions>
Original prompt and wizard facts: <verbatim facts>
Approved native capabilities: <exact Gate 1-approved matrix, including None and storage/output>
Approved connectors: <exact Gate 1-approved list, including None and source-of-truth boundaries>
Working directory: <absolute working_dir>
Plugin root: ${PLUGIN_ROOT}
Dataverse planning mode: required
Target environment: <foreground URL and tenant>
Normalized Dataverse foreground planning snapshot: <SNAPSHOT_PATH verbatim>
Dataverse planning evidence: <EVIDENCE_PATH verbatim>
Structured schema contract output: <working_dir>/.tmp/dataverse-schema-contract.json
Publisher prefix (detected from env): <literal prefix, or explicitly provisional cr>
Write _dm_section.md and normalize the structured schema contract per your agent contract.
Snapshot-only: no live Dataverse discovery or environment resolution.
Include all retained artifact storage, relationships, alternate keys and service requirements.
Reconcile every required information/interaction need; overlap ranks candidates, never completeness.
No user questions, approvals, receipt writes or nested agents; return the standard first-line status.
```

Require both `_dm_section.md` and normalized `.tmp/dataverse-schema-contract.json`.
Missing/malformed sidecar is `BLOCKED`, never Markdown parsing. Revision prompts preserve the
same snapshot/evidence paths and still-approved architecture. Bounded missing-metadata signals
route to planning-snapshot.md. New platform/native/connector needs return to Gate 1 before
revising the model, not to a mutation worker.

2. **Gate 2 — Data model:** show reuse/extend/create decisions, Mermaid ER with columns,
   relationships, alternate keys, tiers, risks and retained-artifact targets.
   In required mode, normalize and verify proposed publisher names **before** acceptance.
   On acceptance initialize the foreground-owned receipt using [approval-receipt.md](approval-receipt.md).
   Connector-only still requires explicit approval of the no-Dataverse decision, recorded in the plan.
   Transfer only still-valid Gate 1 native/connector approvals and their original timestamps
   into the receipt; model acceptance never approves architecture retrospectively.
3. **Gate 3 — Screen graph:** dispatch the graph worker below, embed its section, review the
   journey coverage, screen list, useful first-entry surfaces, scan/deep-link returns, navigation
   contracts and shared conventions **before specs**.
   Show the derived scope breakdown from Navigation Pattern: main destinations, unique business
   routes (including routed modals/sheets), local overlays/states, and platform routes separately.
   Review what was consolidated and why remaining similar surfaces cannot be combined usefully.
   A large graph needs task-based justification, not automatic approval or arbitrary truncation.
   Approve the navigation pattern and explicit visible tab/drawer destination IDs with their
   hierarchy/access rationale; detail, status and action routes do not count as peer destinations.
4. **Gate 4 — Screen specs:** dispatch specs only against the approved graph, review compact
   per-screen behavior, independent domain states and authorized transitions, initial filters,
   data/permissions, JS dependencies and open questions.
   Run the full information/interaction audit in Step 3.4 before acceptance in every data mode,
   not only when related-field annotations exist. Resolve gaps and reapprove affected earlier gates.
   Gate 4 rejection reruns specs only. Structural changes return to Gate 3.

Brand selection is deferred to Step 6.75. Both screen phases use `skip_preview: true`; there is
no plan-time browser open, style-picker early return, or requirement to render before Gate 4.
Gate 4 approves behavior, data/permissions and navigation, not model-inferred visual arrangement.
Label suggested layout/media/emphasis as provisional until visual approval; explicit user brand
and presentation constraints remain binding. Apply the
[presentation authority boundary](${PLUGIN_ROOT}/shared/references/design-planning.md#entry-composition-and-reference-transfer).

## 3.3 — Direct screen-planner contract

For each phase dispatch `mobile-app:screen-planner` with:

```text
phase: graph | specs
Requirements brief: <confirmed brief verbatim>
Experience outline and Information needs: <current proposed/approved journey, required facts/actions and classified assumptions>
Workflow/domain context and explicit constraints: <from intake, not entity-count guesses>
Wizard facts: <users, platforms, supplied design context>
Approved data model / native capabilities / connectors: <relevant sections verbatim>
Design Direction and Design: <provisional/deferred context, never falsely approved brand>
Explicit JS library requests / use cases: <from brief>
Working directory: <absolute working_dir>
Plugin root: ${PLUGIN_ROOT}
plan_path: <working_dir>/native-app-plan.md
skip_preview: true
No interactive tools, gate approval, receipt writes, application source or nested agents.
Return the standard first-line status and output path.
```

For `phase: graph`, request Navigation Pattern, Screen Map, `### Primary journeys`,
`### Preview selection`, Navigation Contracts and Shared Conventions only.
Keep both new subsections within `## Screens`: journeys record actor/entry/decision,
action + operation, outcome and recovery; preview selection records screen IDs and rationale.
They extend the existing human plan, not a new UX JSON authority.
Require the [scope/consolidation review](${PLUGIN_ROOT}/shared/references/screen-planning/spec-contract.md#screen-scope-and-consolidation) before returning the graph. Every approved job must remain covered.
Output is `_screens_section.md`; no per-screen specs or preview.
Foreground reviews/embeds that graph into `plan_path` before dispatching specs.
For `phase: specs`, read the locked `## Screens` in `plan_path`, not graph scratch; preserve
graph, stable IDs, journeys, preview selections and conventions immutably. Update compact delta
specs only in `plan_path` (never `_screens_section.md`), not repeated universal defaults.
That lock applies to the spec worker's assigned phase; it does not promote provisional styling
into fixed requirements for the later design author.
Before generation, pass the approved normalized schema/evidence for semantic requirements;
never require or invent generated services that cannot exist until Step 8. Resolve actual
exports/signatures at Step 10.7 before skeletons/builders. On edits, supply verified existing
services now. Research JS packages read-only and record exact versions/evidence in
`### JavaScript Dependencies`; do not install.
Resolve blocking open questions in foreground before acceptance.

Foreground alone embeds graph output; specs worker writes only its assigned plan section,
never approval records. If a screen requires new
schema, native or connector scope, revise/reapprove that earlier gate and regenerate dependent
graph/specs before returning to Gate 4. Never silently revise locked input.
Handle `NEEDS_CONTEXT: graph missing` and `NEEDS_CONTEXT: graph revision required` before a
generic specs retry: return to graph planning and explicit Gate 3 approval, then regenerate specs.

## 3.4 — Information/interaction audit and final integrity

After detailed specs are drafted and **before Gate 4 acceptance**, run
[information and interaction coverage](${PLUGIN_ROOT}/shared/references/screen-data-coverage.md).
Pass explicit `plan_path: <working_dir>/native-app-plan.md` to the read-only extraction helper
and audit every intended spec against App Requirements/Information needs, not graph scratch.
Connector-only, local and auth-only screens are included; no related annotations is not a skip.

Foreground owns this audit for all data modes. For required Dataverse context it may dispatch
`mobile-app:data-model-architect` with `mode: screen-data-audit`, the explicit plan_path, locked
`_dm_section.md`, normalized contract, matching snapshot/evidence, original prefix and relevant
native/connector scope. Supply the Experience outline/Information needs and extracted specs.
The worker returns coverage findings and a related-read addendum where relevant; it cannot
mutate the plan/schema, approve scope or create a receipt. If dispatch is unavailable,
foreground executes the same audit.

Foreground embeds `### Information and interaction coverage` inside `## Screens`. Resolve
required gaps with the owning earlier gate and revise only affected specs before acceptance.
Keep `### Cross-entity Reads` when relevant. `external-projection-required` remains unresolved
until supplied externally or the affected scope is explicitly revised; approval alone is not
an executable read path. No schema mutation or computed metadata invention occurs in this audit.

Verify final plan, schema and the foreground receipt following approval-receipt.md. Validate
every planning file written using `validate-mobile-files.js` with exact file paths.
Do not advance on unverified contract rows or mismatched service dependencies.
Do not perform a post-approval prefix sweep: any correction needs normalized contract revision
and affected gate reapproval. Existing table/schema names remain their verified names.

Only after these checks is Step 3 complete. Load the scaffold phase next.
