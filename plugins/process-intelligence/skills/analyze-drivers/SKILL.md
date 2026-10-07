---
name: analyze-drivers
description: Use when seeking explanatory attributes or hypotheses for differences in process duration, waiting, utilization or rework.
allowed-tools: Read, AskUserQuestion
---

# Drivers: association before explanation

Use the [shared contract](../../references/analysis-contract.md) and
[filter/unit reference](../../references/filters-and-units.md).
Reuse metadata and frozen baseline scope; choose a specific defined outcome and relevant case-level
attributes from the user's context, without a candidate quota. If none is known, ask; do not sweep.
State a testable hypothesis, possible competing explanation and what would distinguish them.
Load the [investigation method](../../references/investigation-method.md) for evidence/status tracking.
For utilization, first check timestamp imports and the zero-duration convention in the unit
reference. A cohort-mix convention is not resource efficiency or measured productive time.

## Ordered trace

1. Check A's metadata level before correlation. Reuse a cached signal instead of repeating it.
   `get_correlation_v2 {S,attributeName:A,influenceFormula:I,sortOrder:"Descending",filterOptions:F}`.

   | Outcome | I |
   |---|---|
   | Duration / waiting / active time | DurationInfluence / WaitingTimeInfluence / ActiveTimeInfluence |
   | Utilization / event count | CaseUtilizationInfluence / EventCountInfluence |
   | Rework / loops / self-loops | ReworkCountInfluence / LoopCountInfluence / SelfloopCountInfluence |

   Use the advertised enum and exact spelling. There are **no** `itemsPerPage`, `itemsToSkip`,
   `top`, `metrics` or `limit` arguments. The service ranks at most 20 groups.
2. Only if prevalence or mean evidence is needed and statistics is advertised:
   `get_attribute_statistics {S,attributeName:A,filterOptions:F,itemsPerPage:5,itemsToSkip:0,metricToSortBy:"CaseFrequency",sortOrder:"Descending"}`.
   Match returned values explicitly. Influence-ranked groups may differ from
   frequency-ranked groups; an absent match is unknown, not zero.
3. For a remaining hypothesis, use a discriminating matched comparison via compare-cohorts,
   focused statistics/cases, or another relevant candidate. Derive each test from frozen F,
   never an outcome-only exploratory subset. A cached signal can go directly to its test.
   Continue needed checks/pages without fixed analytical-call or candidate quotas.
   If matched evidence contradicts the proposed direction, mark it **contradicted** within that
   scope; do not privilege the earlier influence score or claim it proves a cause.

## Non-case branch

An event-level Resource cannot be sent to correlation. If useful and advertised, use the
statistics call above for that attribute, but describe grouped **event** duration/frequencies,
not case-duration drivers. Otherwise ask for a case-level candidate or report the capability gap.
Do not silently substitute a different causal analysis.

## Report and stop

Influence is a prevalence-weighted descriptive score, **not Pearson correlation, significance,
causal effect or confidence**. Its formula already scales by 100; do not multiply again.
Return at most five useful signals with available counts/means, units, scope and partial coverage.
Label explanations as hypotheses, note selection/confounding, and state one falsifiable evidence check.
Record tested versus merely observed claims, alternatives and missing evidence; revise or stop
when the next check cannot discriminate. No assumed outcome maturity or closure.
Stop when no discriminating evidence remains; do not paginate correlations or invent sample sizes.
