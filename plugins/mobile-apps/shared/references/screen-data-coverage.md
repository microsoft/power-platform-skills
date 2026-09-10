# Information and interaction coverage

Use during creation/edit planning, after detailed screen specs and before their approval,
and again when a design revision changes visible information or interaction semantics.
This is a review of the existing plan and data/capability evidence, not a new product
contract, schema generator, approval gate or permission to mutate a data source.

## Start from the authoritative plan

Foreground supplies an explicit `plan_path`: the current creation plan or the staged edit
plan, normally `.tmp/edit-native-app-plan.md`. Never prefer `_screens_section.md`; it is
graph scratch and does not contain the authoritative detailed specs. Never fall back to
an older live plan when the supplied staged plan is missing or incomplete.

Extract all detailed specs, including screens without `related_entity_fields`:

```bash
node "${PLUGIN_ROOT}/scripts/read-screen-data-audit.js" \
  --project-root "<working_dir>" --plan "<plan_path>"
```

For a bounded edit, repeat `--screen-id "<id>"` for every affected screen and shared
consumer; validate the intended set against the Screen Map. Missing/duplicate IDs,
graph-only input and unknown requested IDs are errors, not an empty successful audit.
The helper is read-only. Its plan hash identifies input bytes; it cannot establish
semantic completeness, approve the plan or validate the truth of an authored mapping.

Read the plan's App Requirements, Information needs, relevant journeys, Screen Map,
shared conventions and supplied detailed specs. Use approved native/connector scope and
the normalized schema/planning evidence for creation; use actual generated contracts on
edits. Do not require generated files before their generation phase or infer an existing
column, capability or service from a plausible name.

## Audit every decision-bearing fact and action

For every intended screen, inspect Data, UX contract, Layout delta, State delta, Key user
actions, filters/search/sort, related fields, lookup writes and artifact persistence.
Compare these to the requirements, not merely to whatever the spec happens to list.

| Kind | Required evidence |
|---|---|
| Primary field | Verified/planned column or connector field, read scope and selected property; required input validation and write target when editable |
| Derived value or metric | Named inputs, units, calculation, complete aggregation scope and freshness; never count a capped page as the whole dataset |
| Related fact | Direct formatted lookup, bounded related read or supported projection per the existing data-performance contract; no per-row fan-out |
| Filter/search/sort | Actual source property, supported query and preserved scope; empty-filter recovery cannot silently change the selection |
| Action or transition | Actor, prerequisites, affected records, checked operation, observable outcome and retry/cancel behavior; distinguish edits from committed values |
| Artifact | Parent relationship, count/cardinality, capture/read/upload support and failure state; one Image column is not a multi-photo history |
| Native or external capability | Shipped control/connector, permission/error behavior and durable output if required; preview success is not capability evidence |
| Auth, local or static content | Explicit supported source; no invented account fields, hidden business-data fallback or unnecessary Dataverse dependency |
| Sample-only detail | Clearly isolated synthetic values for supported concepts; additional product facts/capabilities remain proposed scope until accepted and supported |

Use [data-performance.md](data-performance.md#cross-entity-reads) as the sole authority for
related-read strategies. A requirement needing a missing projection remains unresolved;
the audit never synthesizes formulas, metadata, services or new architecture decisions.

Record the result in `### Information and interaction coverage` inside the authoritative
plan's `## Screens` section, using one concise row per distinct fact/action and grouping
identical consumers. The foreground alone embeds the result and updates approvals.

| Screen IDs | Fact or action / user decision | Kind | Supporting source or operation | Status / remaining decision |
|---|---|---|---|---|
| receipt-workspace | Compare expected, received and damaged units | Derived | Verified quantity fields; same unit; full selected-receipt scope | Covered in plan; generated exports resolved at Step 10.7 |
| receipt-review | Browse two damage photos | Artifact | Only one Image column planned | Unresolved: approve repeated evidence storage or a single-image experience |
| reading | Resume a lesson | Action | Approved progress source and update operation | Covered in plan; preserve last committed position on retry |

This table records support, not duplicate schema definitions or executable request bodies.
Creation may say "covered in plan; export/signature pending generation" only when schema,
operation and native feasibility are already supported. Step 10.7 resolves those exports
and lookup/upload signatures before builders. A missing business source is not a routine
generation placeholder.

## Resolve gaps before acceptance

- Missing required information returns to its data/capability/requirements owner. Reuse
  the existing table when compatible and extend only missing requirements. Do not add
  duplicate columns for derivable values or remove useful facts merely to reduce schema.
- Changed operations, routes, artifact multiplicity or authorization require the owning
  foreground gate. Reapprove affected schema and dependent specs; preserve unaffected work.
- An intentionally narrower release must be explicitly accepted and removed consistently
  from required scope, specs and preview. "Optional" invented by a worker is not a resolution.
- No `related_entity_fields` is not evidence of completeness. Primary-field writes,
  filters, metrics, artifacts, local state and auth-only screens still need this review.
- Every required row must be supported before spec approval, design acceptance and building.
  Unresolved required support returns `NEEDS_CONTEXT`; unavailable required evidence remains
  `BLOCKED`. Never manufacture a covered row or approval to advance.

The separate `### Cross-entity Reads` addendum remains useful when related fields exist.
It is a subset of this audit, not a replacement. After design, compare rendered facts and
affordances against coverage; after building, inspect actual handlers and sources. A checked
table or a fresh hash alone does not prove working UX or native behavior.
