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

## 3.0 — Verified data evidence and proposal

For `required`, read and execute [planning-snapshot.md](planning-snapshot.md). The foreground
owns environment resolution, evidence, progress rendering and bounded exact-name expansions.
For `connector-only`, do not read that reference or create a snapshot/contract/receipt; propose
an explicit zero-table/no-Dataverse `## Data Model` section for foreground review.

Dispatch `mobile-app:data-model-architect` directly in required mode:

```text
Requirements brief: <confirmed brief verbatim, including workflow/domain context>
Original prompt and wizard facts: <verbatim facts>
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
No user questions, approvals, receipt writes or nested agents; return the standard first-line status.
```

Require both `_dm_section.md` and normalized `.tmp/dataverse-schema-contract.json`.
Missing/malformed sidecar is `BLOCKED`, never Markdown parsing. Revision prompts preserve the
same snapshot/evidence paths. Bounded missing-metadata signals route to planning-snapshot.md.

## 3.1 — Native/integration proposal and assembly

Dispatch `mobile-app:native-app-planner` for **only** native capabilities, connector needs and
provisional design context with the confirmed brief, wizard facts, approved/drafted data needs,
plugin root, working directory and output `.tmp/native-integration-proposal.md`.
It cannot ask questions, run gates, assemble approval records or invoke architects.
Resolve its `NEEDS_CONTEXT` in foreground. Surface excluded capabilities before approving scope.
Send storage changes back to the data architect before Gate 1, not to a mutation worker.

Foreground assembles the human plan. Keep these independent top-level sections:
`## Overview`, `## App Requirements`, `## Data Model`, `## Native Capabilities`,
`## Design Direction`, `## Design` (existing design execution fields), `## Connectors`,
`## Screens`, `## Approvals`. Provenance may be a short separate section.
The confirmed brief stays verbatim, compact and separate from architecture; do not nest schema
under a `## Brief`. **Do not duplicate raw evidence**: embed proposal decisions, not raw
rankings/columns/timings; retain the separately referenced evidence appendix.
Keep data-model implementation notes under one concise `### Notes`; queue discovery diagnostics
for the bank. Do not write links to nonexistent operational documents.

## 3.2 — Foreground approval gates

Use the host's actual question interface and available plan-mode tools per the shared core.
Present each section, capture an explicit user answer, then record what was approved and when.
`DONE`, empty answers, entering plan mode and recommendations never approve a section.
On rejection revise only that section, invalidate dependent approvals, then present it again.
If no permitted question interface exists, stop with the pending approval; do not dispatch more work.

1. **Gate 1 — Data model:** show reuse/extend/create decisions, Mermaid ER with columns,
   relationships, alternate keys, tiers, risks and retained-artifact targets.
   In required mode, normalize and verify proposed publisher names **before** acceptance.
   On acceptance initialize the foreground-owned receipt using [approval-receipt.md](approval-receipt.md).
   Connector-only still requires explicit approval of the no-Dataverse decision, recorded in the plan.
2. **Gate 2 — Native capabilities + connectors:** review both matrices including `None`,
   exclusions and storage/output. Both empty is not self-approval: record the user's acceptance
   of the empty scope. Update `nativeCapabilities` and `connectors` records only after acceptance.
3. **Gate 4a — Screen graph:** dispatch the graph worker below, embed its section, review the
   journey coverage, screen list, useful first-entry surfaces, scan/deep-link returns, navigation
   contracts and shared conventions **before specs**.
   Show the derived scope breakdown from Navigation Pattern: main destinations, unique business
   routes (including routed modals/sheets), local overlays/states, and platform routes separately.
   Review what was consolidated and why remaining similar surfaces cannot be combined usefully.
   A large graph needs task-based justification, not automatic approval or arbitrary truncation.
   Approve the navigation pattern and explicit visible tab/drawer destination IDs with their
   hierarchy/access rationale; detail, status and action routes do not count as peer destinations.
4. **Gate 4b — Screen specs:** dispatch specs only against the approved graph, review compact
   per-screen behavior, independent domain states and authorized transitions, initial filters,
   data/permissions, JS dependencies and open questions.
   Gate 4b rejection reruns specs only. Structural changes return to Gate 4a.

Brand selection is deferred to Step 6.75. Both screen phases use `skip_preview: true`; there is
no plan-time browser open, style-picker early return, or requirement to render before Gate 4b.

## 3.3 — Direct screen-planner contract

For each phase dispatch `mobile-app:screen-planner` with:

```text
phase: graph | specs
Requirements brief: <confirmed brief verbatim>
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
Before generation, pass the approved normalized schema/evidence for semantic requirements;
never require or invent generated services that cannot exist until Step 8. Resolve actual
exports/signatures at Step 10.7 before skeletons/builders. On edits, supply verified existing
services now. Research JS packages read-only and record exact versions/evidence in
`### JavaScript Dependencies`; do not install.
Resolve blocking open questions in foreground before acceptance.

Foreground alone embeds graph output; specs worker writes only its assigned plan section,
never approval records. If a screen requires new
schema, native or connector scope, revise/reapprove that earlier gate and regenerate dependent
graph/specs before returning to Gate 4b. Never silently revise locked input.

## 3.4 — Cross-entity audit and final integrity

After Gate 4b, only when specs contain `related_entity_fields`, dispatch the data architect with
`mode: cross-entity-audit`, the locked `_dm_section.md`, screen plan, original prefix, working
directory and plugin root. Run only its cross-entity algorithm: no schema mutation, computed
metadata invention, or changes to the approved normalized contract.
It proposes formatted lookup, bounded chained fetch or external server-owned projection read
paths per [data-performance.md](${PLUGIN_ROOT}/shared/references/data-performance.md).
Present any addendum as a Gate 1 addendum and reapprove affected dependent screen specs.
`external-projection-required` remains blocked until supplied externally; approval alone cannot
make an unavailable projection executable. With no related fields, record audit not applicable.

Verify final plan, schema and the foreground receipt following approval-receipt.md. Validate
every planning file written using `validate-mobile-files.js` with exact file paths.
Do not advance on unverified contract rows or mismatched service dependencies.
Do not perform a post-approval prefix sweep: any correction needs normalized contract revision
and affected gate reapproval. Existing table/schema names remain their verified names.

Only after these checks is Step 3 complete. Load the scaffold phase next.
