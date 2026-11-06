# From evidence to a finding

Use hypothesis-first or observation-first investigation as the question warrants.
Control flow, business rules, temporal properties and data attributes are perspectives,
not mandatory query stages or promises of supported MCP capabilities.

## Definitions before conclusions

A Payment event may record only part of an obligation; an Appeal does not prove dismissal.
Confirm the outcome through its business definition and available attributes/measures.
An absent event or terminal-looking trace may reflect censoring, ongoing work, legitimate
termination or recording gaps. Do not select an explanation without closure, coverage and
recording evidence. Business-rule text alone does not prove a violation.

Confirm case/event entity, units, time and aggregation semantics. Cumulative snapshots are
not incremental transactions; nonmonotonic values can make sum, maximum and apparent last
value all inappropriate. Use an authoritative definition/order, not a familiar attribute name.

Freeze the agreed baseline. Clone labelled test/comparison filters from it; never leak a
prior exploratory or outcome-only restriction into a full-population comparison.
Existing view filters remain active. Check competing explanations with matched evidence
when it can discriminate. Do not silently assume cohort maturity, closure or comparability.

## Evidence status

| Status | Meaning |
|---|---|
| observation | Returned pattern; explanation not tested |
| supported-within-scope | Compatible evidence supports the stated test within its measured scope |
| contradicted | Compatible counterevidence refutes the stated claim |
| inconclusive | Definition, capability, comparability or discriminating evidence is missing |
| pending | Required query is still processing; retain its operation ID |

These are not quality scores or causal certificates. If a matched test contradicts an
influence signal, revise the hypothesis rather than choosing the favorable result.
Report the affected count and denominator only when compatible, complete counts establish
them. Overlapping groups cannot be summed as unique cases; partial pages and group counts
are not population denominators. State what is missing.

## Compact record and stopping

Retain question, definition/provenance, claim/status, selector/PV/PMV, frozen baseline and
test filters, reusable result references with relevant arguments, counts/denominator,
aggregation/units/coverage, alternatives/counterevidence and the next discriminating check.
Invalidate affected records when user scope, principal, metadata, dependencies or capability
changes. Recheck current metadata before reusing evidence after refresh.

Store this audit context conversationally, not hidden reasoning, automatic exports or raw
records. Continue necessary evidence gathering without numerical query quotas, with modest
pages and concise headlines. Stop at an answer, no new discriminating evidence, explicit
error/capability gap or missing user decision. Polling and failed formula repair remain bounded.
