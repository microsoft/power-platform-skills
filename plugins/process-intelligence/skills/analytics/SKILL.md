---
name: analytics
description: Use when a Process Mining overview, initial process selection, or an analytical follow-up needs routing.
allowed-tools: Read, AskUserQuestion
---

# Process overview and routing

Use the [shared contract](../../references/analysis-contract.md) once per fresh analysis context.
Recipes name native functions, not provider-prefixed host tools; bind them to discovered schemas.

## Shortest trace

1. Reuse the selected process and fresh metadata. Otherwise `get_processes {}` ->
   resolve the returned `P` (ask on duplicates) -> `get_process_details_v2 {processId:P}`
   when metadata is missing. An empty process list stops analysis.
2. `get_process_overall_metrics_v2 {S,filterOptions:F}`. Omit absent filters.
   Report returned case/event/variant counts and mean `CaseDuration`/`CaseWaitingTime`;
   preserve native units. Missing metrics are not zero.
   For utilization with zero active time or start-only data, check the zero-duration convention
   in [filters and units](../../references/filters-and-units.md); do not infer productive time.
3. Only for requested path concentration:
   `get_variants_with_metrics_v2 {S,filterOptions:F,itemsPerPage:5,itemsToSkip:0,metricToSortBy:"CaseCount",sortOrder:"Descending"}`.

Reuse completed evidence; continue necessary pages or checks without fixed analytical-call
or total-row quotas. Stop at an answer, not an arbitrary count; do not sweep or repeat unchanged queries.
Do not force an overview or investigation loop before a specialist's exact query.
Broad business questions or competing explanations use investigate-process: establish only
missing outcome definitions that change interpretation, then test the relevant claim.

| Follow-up | Load only this skill |
|---|---|
| Broad business question, observed pattern, competing explanations | investigate-process |
| Slow activities, waiting, handoffs, cumulative workload | analyze-performance |
| Common/slow variants, repeated work, a specific case | analyze-variants |
| Explanatory attributes, association hypotheses | analyze-drivers |
| Before/after or A/B cohorts | compare-cohorts |
| Missing metric, saved metric reuse, ephemeral formula | derive-metric |
| Interacting objects or leading-object executions | analyze-objects |

Stop when answered. Return a brief finding, at most five headline rows, scope/version,
metric aggregation/units and coverage; retain compact context for the next question.
Views, visualizations and saved metrics cannot be created through these tools.
