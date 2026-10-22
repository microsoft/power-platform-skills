# Filters, paging and units

Use exact metadata names, levels and types. Normal queries take `filterOptions`;
bottlenecks take `mcpFilterOptions`; object queries take a separate `filters` model.
View filters remain active: additional filters do not remove them.

Case recipes use these shapes; merge with baseline F, do not overwrite it:

```text
attributeValueFilters:[{attributeName:A,dataType:T,attributeValues:[X],isInclusive:true}]
caseMetricConditionFilters:[{metric:M,comparisonOperator:Q,values:[X],isInclusive:true}]
timeframeFilters:[{startDate:START,endDate:END,isInclusive:true}]
```

Bind A/T/X/M/Q from metadata, user scope and discovered enums. Attribute-value, event and
edge conditions **select whole cases**, not individual event/edge rows. Event/edge
`filterMatchScope:"Any"`/`"All"` expresses within-case matching. A subprocess filter changes
the analyzed process; it is not a harmless cohort filter.
Case timeframes are **Contained**, not Started/Completed/Intersecting. Send both explicit
timezone-qualified timestamps; do not assert unproven end-boundary semantics.

Case/Event/Edge duration filter values are invariant TimeSpan strings, e.g.
`"1.00:00:00"` for one day, not numeric seconds. OCPM units differ.
Keep returned native duration types; convert explicitly and label units, never assume milliseconds.
Native process `CaseDuration` and variant `CaseDuration` are means.
Bottleneck `Duration` is average activity duration. Edge `Duration` is an average;
`RepetitionCount` is a maximum, not a total.

Statistics `TotalDuration` sums grouped cases or matching events according to attribute level;
`AvgDuration` is the corresponding mean. Relative frequencies are ratios. Event-value groups
can share cases: do not add their case frequencies as unique cases.
Never average averages, use missing as zero, or infer population totals from top-N rows.

Before interpreting utilization, inspect imported start/end timestamps and active-time evidence.
With start-only data, reported active time may be zero while a zero-duration convention assigns
utilization 1 to zero-duration cases and 0 to positive-duration cases. A nonzero aggregate can
then reflect that cohort mix, not measured productive work or resource efficiency.
Keep the raw metric; do not silently replace it with zero. Verify the convention using available
same-scope cohort evidence rather than assuming it applies universally. Zero-duration cases can
contain multiple events at the same timestamp, not only single-event cases.

Page only when necessary: retain selector/filters/sort, advance `itemsToSkip` by returned
Offset plus item count (views: requested skip plus count). Continue for missing evidence;
stop on empty/reached total, answered question, explicit user limit or no new information.
There is no total-row or page quota. Do not fetch every page merely because a total is large.
TotalCount counts result entities, not necessarily cases. There is no edge sort parameter or
correlation paging; partial-page rankings are not global. Headline output stays at five rows.
