---
name: compare-cohorts
description: Use when comparing process cohorts, departments, periods or before-and-after results under matched definitions.
allowed-tools: Read, AskUserQuestion
---

# Matched cohort comparisons

Use the [shared contract](../../references/analysis-contract.md) and
[filters/units](../../references/filters-and-units.md).
Fix the outcome definition/provenance, metric, aggregation, units, timezone and one selector S.
Freeze the user's agreed baseline F, separately from current exploratory filters.
Reuse metadata versions and exact typed cohort values. Use the
[investigation method](../../references/investigation-method.md) for findings/status.

## Ordered trace

1. Copy baseline F twice. For attribute cohorts append
   `{attributeName:A,dataType:T,attributeValues:[X],isInclusive:true}` to
   `attributeValueFilters` for A's cohort value, and the same shape with Y for B.
   Preserve other agreed baseline conditions; retain rework restrictions only if part of that
   baseline. Do not leak an exploratory/outcome-only subset into a full-population comparison.
   Change only the intended cohort condition. If values are unknown, request
   `get_attribute_values_v2 {S,attributeName:A,itemsPerPage:20,itemsToSkip:0,filterOptions:F}`;
   it returns values, not frequencies.
2. `get_process_overall_metrics_v2 {S,filterOptions:F_A}` ->
   `get_process_overall_metrics_v2 {S,filterOptions:F_B}`.
   No `metrics`, `groupBy` or aggregation parameter exists. Use the same returned metric definitions;
   native `CaseDuration`/`CaseWaitingTime` are means.
3. Only if a grouped explanation is needed and statistics is advertised, make a **matched pair**:
   `get_attribute_statistics {S,attributeName:A,filterOptions:F_A,itemsPerPage:5,itemsToSkip:0,metricToSortBy:"TotalDuration",sortOrder:"Descending"}`,
   then exactly the same call with F_B. Do not treat independent top-five pages as a complete aligned population.

Continue relevant value/group pages or matched follow-ups when needed, without fixed call quotas.
Stop at sufficient evidence, no new information or a capability/error boundary; no blind sweeps.
Do not create views or use two inclusive timeframes in one query as an A/B comparison.

## Time and reproducibility

For periods, change only one explicit `timeframeFilters` start/end pair in each copied F.
Case windows mean **Contained**, not cases Started/Completed/Intersecting or all events during the period.
If completed-only membership including earlier starts is essential, stop/reframe or route
to derive-metric/a user-confirmed existing matching view. Never invent a date-mode field
or promise unknown end-boundary behavior.

If refresh is reported or reproducibility is at risk, recheck details.
Changed PV/PMV invalidates the pair: mark **inconclusive**, stop or deliberately rerun both,
not just the second.
Process selection resolves latest; no direct version selector or atomic comparison snapshot exists.
Views pin version context but their configuration is mutable/cached.

Report A/B counts, mean metrics, absolute delta and relative change only for a nonzero baseline.
Empty cohorts mean insufficient evidence, not zero duration/infinite improvement.
State scope/version and unmatched-group coverage; at most five headline rows.
Recorded means do not establish closure, equal maturity or complete lifecycles. Report those
as unknown unless supported; qualify the comparison, not an assumed causal improvement.
Retain baseline/cohort filters, evidence references, status and alternatives. Overlapping groups
cannot be added as unique-case totals.
Object-centric comparisons belong in analyze-objects, not case-filter fallbacks.
