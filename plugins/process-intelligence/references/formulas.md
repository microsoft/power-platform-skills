# Formula references and execution targets

Fetch `get_custom_metric_language_reference {}` only if its primer is not cached.
Then prefer `{search:INTENT}` for needed overloads, not a full language sweep.
Use `functionNames` only if present in the advertised input schema, never merely because a
description recommends it. Otherwise search for exact names from returned references.
Use `index:true` only when advertised and targeted lookup cannot orient the task. Search/category
results are bounded; honor `hasMore`/`nextCursor`. Replay identical query arguments with the
returned cursor and retain the returned catalogVersion in context; do not invent version/page-size
arguments or mix exclusive query modes. Continue targeted pages until the needed syntax is known
or no useful continuation exists, without a lookup quota. No blind full-language sweep.

Build expressions from exact metadata attributes and returned syntax; quote attribute literals
where required. Examples are not process-ready formulas. Use explicit aggregation defaults when
testing against zero/false; default null is not zero. Cache only needed signatures/catalogVersion
and the validated expression, type and contexts under the exact PV/PMV pair.
Confirm entity, business/time definition and incremental-versus-snapshot aggregation before
constructing an expression. Sum/latest/maximum require evidence, not assumptions.
For a candidate and its repairs, at most three validation attempts are allowed; stop earlier
on missing prerequisites, incompatible context or an explicit capability failure.

| Execution | Required validation types member |
|---|---|
| `get_cases_with_metrics_v2` column | Case |
| `get_variants_with_metrics_v2` column | Variant |
| `get_edges_with_metrics_v2` column | **EdgeValue**, not Edge |
| `get_attribute_statistics` column, case/event-level attribute | **CaseAttributeValue / EventAttributeValue**, not Case/Event |
| Case/event/edge scoped FormulaMetric filter | **Case / Event / Edge** |

For supported columns pass `formulaMetricInput:{name:N,formula:Fexpr}` with page five.
Statistics additionally requires the exact `attributeName`; variants/cases use advertised native
sorts, edges have no sort. No columns exist on overall, bottleneck, correlation, attribute-values
or object tools. A mismatch stops execution; do not silently change a requested column into a filter.

For a filter, append `{metric:"FormulaMetric",formula:Fexpr,comparisonOperator:Q,values:[X],isInclusive:true}`
to `caseMetricConditionFilters`, `eventMetricConditionFilters` or `edgeMetricConditionFilters`.
Bind Q/X to validated scalar type and discovered operator rules; event/edge Any/All selects whole cases.
Then execute a suitable native query, e.g. `get_process_overall_metrics_v2 {S,filterOptions:Fplus}`.

Reference/validation and formula filtering share an ad-hoc capability. Result columns require
an independent capability (and statistics requires its own tool). Schema presence is not enablement.
First explicit rejection -> mark that capability unavailable; retain any prior valid native results,
not fabricated formula values. No alternative endpoint probing or hidden-tool fallback.
