---
name: derive-metric
description: Use when a requested measure is missing, a saved custom metric needs reuse, or an ephemeral formula or derived scalar is needed.
allowed-tools: Read, AskUserQuestion
---

# Resolve a metric gap without saving definitions

Use the [shared contract](../../references/analysis-contract.md) and
[filters/units](../../references/filters-and-units.md). Follow this order; stop at the first sufficient option.

For a business-derived measure, confirm case/event entity, outcome definition/provenance,
units, time basis and aggregation. Are amounts incremental transactions or cumulative snapshots?
Never assume sum, latest or maximum: nonmonotonic snapshots require authoritative ordering and
refund/correction semantics. Missing definitions mean **inconclusive**; ask before computing.
Do not infer formula grammar from an example name or business description.

1. **Native output first.** Use the existing metric and its correct scope/aggregation.
   For cases over one day append
   `{metric:"CaseDuration",comparisonOperator:"GreaterThan",values:["1.00:00:00"],isInclusive:true}`
   to F's `caseMetricConditionFilters`, then
   `get_cases_with_metrics_v2 {S,filterOptions:Fplus,itemsPerPage:5,itemsToSkip:0}`.
   No formula is needed for ordinary duration/waiting/counts; use native grouped statistics
   instead of summing a truncated cases page.
2. **Enabled saved metric.** Reuse fresh details' `CustomMetrics` ID/name/type/dataType.
   Details is not a generic metric catalog and contains no saved formula text.
   Match Case/Event/Edge scope and scalar type. For a Boolean Case metric C append
   `{metric:"CustomMetric",customMetricId:C,comparisonOperator:"EqualTo",values:[true],isInclusive:true}`
   to `caseMetricConditionFilters`; query `get_process_overall_metrics_v2 {S,filterOptions:Fplus}`
   for a count. An ID filter needs no formula validation.
   A saved-name output expression, e.g. synthetic `EscalatedCase()`, **does** require
   the validation/column path below; do not guess escaping or missing dependencies.
3. **Exact local scalar.** Reuse complete, definition-compatible, same-scope totals with a nonzero
   denominator. Label the result derived, not saved. Never average averages or use overlapping
   groups/top-N samples as population totals.
4. **Ephemeral formula only if necessary.** Load [formula execution](../../references/formulas.md).
   Reuse PV/PMV from current details, not process/view IDs; refresh when stale.
   Fetch needed targeted reference pages without a lookup quota; then validate:
   `validate_custom_metric_formula {processVersionId:PV,processExtendedMetadataVersionId:PMV,formula:Fexpr}`.
   For a candidate and its repairs, allow **three validation attempts total**, not endless retries.
   Repair only from structured errors/definitions; stop early on an unavailable prerequisite.
   Require `isValid:true`, a compatible `dataType` and the **exact target context in types**.
   Validation alone neither executes nor saves anything.
5. Execute the smallest matching filter/query or default page-five column query.
   For cases: `get_cases_with_metrics_v2 {S,filterOptions:F,itemsPerPage:5,itemsToSkip:0,formulaMetricInput:{name:N,formula:Fexpr}}`.
   N must not collide with returned built-ins. Never invent `computedColumns` or `metrics`.

Continue necessary pages or distinct evidence queries without ordinary-call or total-row quotas.
Reuse completed results; stop when answered or no new evidence is available.
Missing validator forbids unvalidated execution even if the output field is advertised.
Column and formula-filter capabilities are independent; stop after an explicit gate rejection.
No create/save metric tool exists. If a prerequisite cannot be inlined, explain creation/enablement
outside MCP, then refresh metadata and revalidate after the user's action.

Report definition/formula, units/context, validation state, at most five headline rows and **ephemeral/not saved**.
Retain definition provenance and scoped evidence/status using the [investigation method](../../references/investigation-method.md).
