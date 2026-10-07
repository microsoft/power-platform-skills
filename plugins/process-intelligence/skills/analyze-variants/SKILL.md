---
name: analyze-variants
description: Use when investigating common or slow variants, repeated work, unusual paths, or a specific Process Mining case.
allowed-tools: Read, AskUserQuestion
---

# Variants, rework and exact cases

Use the [shared contract](../../references/analysis-contract.md) and
[filters/units](../../references/filters-and-units.md).
Choose the branch answering the question; do not run a variant overview before an exact-case or rework request.

## Ordered traces

**Common or slow variants**

1. `get_variants_with_metrics_v2 {S,filterOptions:F,itemsPerPage:5,itemsToSkip:0,metricToSortBy:"CaseCount",sortOrder:"Descending"}`.
2. Only if mean-case slowness still needs comparison, repeat with `metricToSortBy:"CaseDuration"`.
   If the first complete result already answers it, stop. `CaseDuration` is a mean;
   variant `Duration` is not its substitute.

**Cases with repeated work**

1. Copy F, appending to `caseMetricConditionFilters`:
   `{metric:"CaseReworkCount",comparisonOperator:"GreaterThan",values:[0],isInclusive:true}`.
2. `get_cases_with_metrics_v2 {S,filterOptions:Fplus,itemsPerPage:5,itemsToSkip:0,metricToSortBy:"ReworkCount",sortOrder:"Descending"}`.
   A native count suffices; no formula or saved metric is needed.
3. Only for unresolved transition evidence:
   `get_edges_with_metrics_v2 {S,filterOptions:Fplus,itemsPerPage:10,itemsToSkip:0}`.
   No edge sort exists; mark incomplete evidence page-local.

**A specific case**

1. Reuse details to identify the metadata-proven case-key attribute K and its type T.
   Bind the exact user/returned value X, e.g. synthetic `"Demo-17"`.
2. Append `{attributeName:K,dataType:T,attributeValues:[X],isInclusive:true}` to F's
   `attributeValueFilters`; call
   `get_cases_with_metrics_v2 {S,filterOptions:Fcase,itemsPerPage:5,itemsToSkip:0}`.
3. An optional same-cohort bottleneck/edge query can summarize activities/handoffs.
   If no exposed key expresses the case, stop; do not scan all cases or invent `caseId`.

## Guardrails

Continue relevant pages or drilldowns until the question is answered or evidence cannot discriminate;
no fixed call/total-row quota or automatic repeated queries. Show at most five headline rows by default.
Use `filterOptions`, `itemsPerPage` and `itemsToSkip`, not `filters`, `metrics`, `limit` or `offset`.
No `variantId` filter exists. For a user-specified sequence use only discovered attribute values
and the advertised sequence-filter schema; do not reconstruct unavailable variant `Values`.
No event-timeline or conformance-check tool exists. Rework/variation alone proves neither
event order nor a conformance violation. Retain scope, versions, metric units and partial coverage.

Activity occurrence is not full payment, successful dismissal, business closure or compliance.
Check the business outcome definition and available attributes/measures; route missing measures
to derive-metric, never infer success from an event name.
Missing events or terminal-looking traces may be censored, ongoing, legitimately ended or
incompletely recorded. Do not choose without closure, recording and observation-coverage evidence.
Use the [investigation method](../../references/investigation-method.md): distinguish observed
presence/counts from tested outcomes; mark an unresolved outcome **inconclusive** and retain
definition provenance, baseline/test filters, evidence references and the next discriminating check.
