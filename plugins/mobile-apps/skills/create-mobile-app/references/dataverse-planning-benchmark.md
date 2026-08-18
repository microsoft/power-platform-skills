# Dataverse planning benchmark

Run the deterministic fixture evaluation with:

```bash
node plugins/mobile-apps/scripts/benchmark-dataverse-planning.js
```

It runs the real `createSnapshot` and `renderPlanningEvidence` implementations
against injected Dataverse responses for wildlife rehabilitation and laboratory
sample chain-of-custody. It reports selected candidates, actual fixture request
counts, relationship/computed extraction, proposed-name checks, evidence
output, and local processing time. It does not score model decisions or claim
agent timing improvements. Matched agent A/B runs are still required for model
decision and timing claims.

## Acceptance criteria

- Same required entity, column, and relationship decisions as the legacy path.
- No weaker reuse or extend decision; every selected existing table has detailed target evidence.
- No missing cross-entity projection or risk notes.
- First factual progress milestone appears within 30 seconds.
- Gate 2/data-model readiness targets 10–15 minutes, quality first.
- Any inventory-only required candidate triggers one bounded exact-name snapshot expansion.
- Every unresolved concept keeps at least its best detailed advisory candidate.
- Exact-covered concepts do not receive unnecessary advisory alternatives.
- Advisory detail loading uses at most 3 candidates per concept and targets 40
  unique advisory tables globally; it may exceed 40 only to preserve one
  candidate for each unresolved concept.
- Required exact-name tables are reported separately and never consume the
  advisory target.
