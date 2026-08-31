# Dataverse planning benchmark

Run the deterministic fixture evaluation with:

```bash
node plugins/mobile-apps/scripts/benchmark-dataverse-planning.js
```

It runs the real typed `createSnapshot` and compact
`buildArchitectEvidence` implementations against injected Dataverse responses
for wildlife rehabilitation, laboratory sample chain-of-custody, and an
adversarial warehouse-receiving brief. The receiving fixture mixes six
persistent entity concepts with role, attribute, and constraint phrases, an
ambiguous candidate, and a lower-ranked strong proposed-name collision.

The report includes:

- primary, ambiguity, strong-collision, and deferred candidate counts;
- core/full/failed detail counts;
- actual fixture requests grouped by metadata endpoint category;
- relationship and computed-column extraction;
- proposed-name checks and non-entity concept filtering;
- full snapshot versus compact architect-sidecar bytes;
- local fixture-processing time.

Fixture time is neither network time nor model time. The benchmark does not
score model decisions or claim agent timing improvements. Matched live and
agent A/B runs remain required for those claims.

## Matched live read benchmark

Use the same environment, tenant, typed concepts file, exact/proposed names,
machine, and time window. Disable inventory-cache reuse for first-run
comparisons. Run at least three repetitions each at read concurrency `1`, `2`,
`3`, and `4`, writing a separate snapshot and telemetry artifact per run:

```bash
node plugins/mobile-apps/scripts/create-dataverse-snapshot.js \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --concepts-file .tmp/dataverse-concepts.json \
  --tables "<same-exact-names>" \
  --proposed-tables "<same-proposed-names>" \
  --progressive-detail \
  --combined-base-read \
  --read-concurrency <1|2|3|4> \
  --output ".tmp/live-c<level>-r<repeat>.json" \
  --telemetry-output ".tmp/live-c<level>-r<repeat>-telemetry.json"
```

Compare normalized snapshots after removing generated timestamps, timings,
cache-source fields, and concurrency-observability fields. Record median and
p95 wall time, request count/category, response bytes, retries, 429s, token
refreshes, core/full counts, deferred candidates, and sidecar bytes. This path
uses metadata GETs only. Metadata writes remain sequential and are outside this
benchmark.

### Observed qualification run

A 12-run GET-only matrix (three repetitions per level) was recorded against one
496-table test environment with the typed receiving brief. Each run loaded the
same six full-detail tables through 82 requests and returned 1,293,652 response
bytes. All candidate rankings, selected evidence, normalized table facts,
exact-name results, and proposed-name checks were identical. Across all runs:

- retries: `0`;
- rate limits: `0`;
- token refreshes: `0`;
- failed detail loads: `0`.

| Read concurrency | Total ms (runs) | Median / p95 total | Detail ms (runs) | Median / p95 detail |
|---:|---|---:|---|---:|
| 1 | 9,743 / 4,023 / 4,520 | 4,520 / 9,743 | 3,210 / 2,883 / 3,491 | 3,210 / 3,491 |
| 2 | 3,160 / 3,491 / 2,607 | 3,160 / 3,491 | 1,986 / 1,712 / 2,028 | 1,986 / 2,028 |
| 3 | 2,260 / 2,326 / 1,892 | 2,260 / 2,326 | 1,294 / 1,608 / 1,259 | 1,294 / 1,608 |
| 4 | 2,427 / 1,717 / 1,934 | 1,934 / 2,427 | 1,303 / 1,093 / 1,370 | 1,303 / 1,370 |

With only three samples, p95 is the maximum observation. The slow first
sequential inventory read also includes cold-path variance. This qualifies
concurrency `2` through `4` for opt-in testing in that environment, not as a
global default. Production remains `1` until the same result holds across
larger candidate sets and multiple environments without tail-latency or
throttling regressions.

The same environment compared the five separate base metadata GETs per table
with `--combined-base-read` at concurrency `1`. The combined run reduced the
six-table snapshot from 82 to 58 requests and from 1,293,652 to 1,291,317
response bytes. Detail loading was 2,245 ms, versus a 3,210 ms sequential median
for separate base reads. Candidate rankings, selected evidence, table facts,
exact-name results, and proposed-name checks were byte-equivalent. This enables
combined reads for foreground planning; fresh execution reconciliation remains
full-detail and independently live.

A two-pass live cache check then wrote and reused exactly 496 customizable
inventory rows. The fresh hit reduced inventory time from 1,021 ms to 8 ms and
removed only the broad inventory GET (58 requests became 57). Inventory,
rankings, selected evidence, detailed tables, exact-name results, and collision
checks were identical. Total wall time was not treated as a cache speed claim
because unrelated detail-request latency varied between the two runs.

## Acceptance criteria

- Same or better required entity, column, and relationship decisions as the
  current sequential path.
- Roles, attributes, actions, statuses, and constraints trigger zero table
  detail selection unless explicitly reclassified as persistent entities.
- No weaker reuse, extend, or adapt decision; every such table has `full`
  target evidence before Gate 1.
- No missing cross-entity projection or risk notes.
- First factual progress milestone appears within 30 seconds.
- Gate 2/data-model readiness targets 10–15 minutes, quality first.
- Any inventory-only or core candidate needed for reuse/extend/adapt triggers
  one bounded full-detail snapshot expansion.
- Every typed entity concept keeps its primary candidate and at most one
  ambiguity candidate; non-entity concepts keep no candidates.
- Strong multiword proposed-name collisions are loaded immediately.
- Exact-covered concepts do not receive unnecessary advisory alternatives.
- Required exact-name tables are reported separately and never consume the
  advisory target.
- Compact sidecar hash/environment/table validation passes and excludes
  unselected inventory.
- Concurrency output order and normalized evidence match concurrency `1`.
- Keep the production default at `1` until repeated live runs show lower median
  and p95 wall time without more throttling, retries, failures, or decision
  drift. A faster single run is insufficient.
