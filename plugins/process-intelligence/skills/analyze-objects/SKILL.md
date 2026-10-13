---
name: analyze-objects
description: Use when analyzing interacting object types, object-centric processes, leading-object executions or cross-object delay.
allowed-tools: Read, AskUserQuestion
---

# Object-centric analysis, not relabeled cases

Use the [shared contract](../../references/analysis-contract.md). Require the **needed**
advertised OCPM tools; absence stops this workflow, never falls back to case analytics.
Keep separate object context and `filters:Fobj`; do not copy case `filterOptions`.

## Ordered trace

1. Only if unknown: `get_ocpm_processes {}` -> select returned P ->
   `get_process_details_v2 {processId:P}` for missing metadata.
   Case `get_processes` does not discover object-centric processes.
2. Unless cached:
   `get_ocpm_object_types {S,itemsPerPage:20,itemsToSkip:0}`.
   Choose **returned** leading type O from the user's objective; ask if ambiguous.
3. `get_ocpm_process_execution_statistics {S,leadingObjectTypeName:O,filters:Fobj}`.
   `ProcessExecutionCount` counts executions; `ProcessExecutionDuration` is their mean.
4. Choose the requested evidence branch:
   `get_ocpm_process_executions {S,leadingObjectTypeName:O,filters:Fobj,itemsPerPage:5,itemsToSkip:0}`,
   or `get_ocpm_objects {S,objectTypeName:O,filters:Fobj,itemsPerPage:5,itemsToSkip:0}`,
   or `get_ocpm_edges {S,filters:Fobj,itemsPerPage:10,itemsToSkip:0}`.

An exact object/execution request with cached type/scope can go directly to its drilldown;
do not force a new summary. Continue needed pages or discriminating follow-ups without fixed
call/row/drilldown quotas. Reuse complete results; stop when answered or no new evidence remains.
No OCPM sort, generic metrics/grouping or formula-column inputs exist.
Search is supported only on object types, objects and edges; aggregate statistics has no paging.

## Filter construction

Use exact returned type names, attributes and object identifiers (objects expose `Name`, not invented GUIDs).
Declare leading type, propagation and date mode. For a selected-type-only timeframe:

```text
objectTimeframeFilters:[{objectTypeName:O,startDate:START,endDate:END,
  filteringType:"Contained",isInclusive:true,propagation:"SelectedObjectTypeOnly"}]
```

SelectedObjectTypeOnly forbids propagationDepth. RelatedObjects defaults to depth 2;
depth N means N-1 relation hops. Choose explicitly when ambiguity changes scope.
OCPM timeframe requires start before end and describes an exclusive end; unlike case filters,
its discovered modes can include Started, Completed, Intersecting and PassThrough.

For a first-to-last path threshold with known activity values FROM/TO:

```text
processExecutionFilters:[{leadingObjectTypeName:O,
  from:{selectionType:"First",value:FROM},to:{selectionType:"Last",value:TO},
  timeBetweenEventsRelation:"GreaterThan",timeBetweenEventsSeconds:SECONDS,isInclusive:true}]
```

Time relation and finite nonnegative seconds must be paired. Secondary object-metric Duration
conditions instead use **ticks**; case duration filters use TimeSpan strings. Do not interchange them.

Report at most five headline rows with native units, leading type, filters and page coverage.
Object-type counts are not additive unique executions. Execution Duration is not automatically
the filtered path interval or invoice-to-order delay. A delay claim also needs a verified business
definition/threshold. Mark unsupported interpretations **inconclusive**, not inferred from cases.
Use the [investigation method](../../references/investigation-method.md) for evidence labels and
compact references, counts, units, coverage and alternatives. Freeze baseline object filters
separately from test filters; keep object context, leading type and propagation explicit.
Stop on missing interval evidence or capability, never substitute a case-based model.
