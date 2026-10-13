---
name: analyze-performance
description: Use when investigating slow activities, waiting, handoff duration, bottlenecks or cumulative activity workload.
allowed-tools: Read, AskUserQuestion
---

# Performance: averages are not total impact

Use the [shared contract](../../references/analysis-contract.md) and
[units/filter semantics](../../references/filters-and-units.md).
Reuse S, baseline F and metadata; do not request a baseline overview for an exact top-bottleneck question.

## Ordered recipe

Choose the smallest entry branch:

1. **Slow activities by mean:**
   `get_bottleneck_analysis_v2 {S,itemsPerPage:5,itemsToSkip:0,mcpFilterOptions:F}`.
   Omit absent F. `Duration` is **average activity duration**, already ranked descending.
   Do not pass `attributeName`, `metrics`, `aggregation` or `limit`.
2. **Cumulative activity duration:** skip step 1 if this alone was requested.
   From metadata take the exact Activity import attribute A; never assume its name is "Activity".
   If advertised, call
   `get_attribute_statistics {S,attributeName:A,filterOptions:F,itemsPerPage:5,itemsToSkip:0,metricToSortBy:"TotalDuration",sortOrder:"Descending"}`.
   There is **no `_v2` suffix**. For an event-level Activity, TotalDuration sums matching
   events; AvgDuration is their mean. Keep EventFrequency and CaseFrequency distinct.
   RelativeCaseFrequency is a ratio; overlapping activity groups' case counts are not additive.
3. Only for unresolved evidence, choose a targeted drilldown:
   `get_edges_with_metrics_v2 {S,filterOptions:F,itemsPerPage:20,itemsToSkip:0}` for handoffs,
   or `get_cases_with_metrics_v2 {S,filterOptions:F,itemsPerPage:5,itemsToSkip:0,metricToSortBy:"WaitingTime",sortOrder:"Descending"}`.
   Reuse earlier compatible results. Continue relevant drilldowns/pages without fixed call or
   total-row ceilings; each query must resolve missing evidence, not repeat an answered question.

## Boundaries and stopping

Missing statistics: report the cumulative-measure gap, optionally average-only bottleneck evidence.
Never derive population totals from top-five averages or call a hidden statistics tool.
Edges expose no sort input: local ranking of one incomplete page is **page-local**, not global.
Report the native edge Duration mean; do not relabel it as an independently established waiting metric.
For a requested global edge ranking, retrieve necessary pages to complete coverage before ranking;
if coverage is incomplete, explicitly leave the global result unresolved.
Event/attribute filters retain whole cases, not just matching events.
Check timestamp imports before interpreting utilization: zero-duration conventions with
start-only data can produce nonzero ratios without measured active work. Keep raw values
and use same-scope cohort evidence; see the unit reference.

Stop once answered or evidence/capability is exhausted. Show at most five headline rows with separate
mean, total and frequency columns only when returned, scope/units and coverage.
High duration is an investigation lead, not proof of cause or a guaranteed time saving.
Mean activity duration times process case count is not total workload: cases are not activity
occurrences. Even known workload is not an intervention's removable delay.
Use the [investigation method](../../references/investigation-method.md) to label observations
and tested findings, retain counterevidence and identify a discriminating next check.
