# Dataverse Live Matrix: 6, 12, and 24 Tables

## Result

The deterministic Dataverse execution pipeline was qualified live on
2026-08-29 against the `NativeAppTesting` environment with cumulative contracts
of 6, 12, and 24 base tables. The final contract also included three Dataverse
M:N intersect resources, so its exact reconciliation and service-generation
scope contained 27 logical resources.

All three cumulative contracts completed with:

- zero unresolved or conflicting decisions;
- exact post-publish verification with zero mismatches;
- sequential service generation for every required base and intersect table;
- generated connector schema and TypeScript validation;
- a subsequent zero-operation, zero-write, zero-publish rerun;
- complete app-owned model materialization;
- successful removal of all disposable live schema.

The final cleanup reconciliation requested all 27 names and returned 0 loaded,
27 unavailable, 0 collisions, and 0 detail failures in 2,446 ms.

## Test Context

| Item | Value |
|---|---|
| Environment | `NativeAppTesting` |
| Environment ID | `3ecebcfc-2e80-e9ad-8a07-ad2001b0b5d9` |
| Environment URL | `https://org64d57fbd.crm8.dynamics.com` |
| Tenant ID | `499ece4c-9b2a-4b89-81ed-578e64f3230c` |
| Solution | `Default` |
| Publisher prefix | `new` |
| Disposable schema stem | `new_mx142305` |
| Read concurrency | 1 |
| Metadata write concurrency | 1 |
| Node | 22.23.2 |

The test used three isolated app copies. Each copy reused the reference app's
installed dependencies but had independent Power Apps configuration, generated
services, schemas, pipeline artifacts, and materialized model. The reference
app was not modified.

## Coverage

The cumulative contract exercised the following supported behavior:

- table creation in dependency tiers;
- extension of existing custom tables;
- user-owned and organization-owned tables;
- activities, notes, offline availability, and change tracking flags;
- String, Memo, Integer, BigInt, Decimal, Double, Money, DateTime, Date,
  Boolean, Choice, MultiSelectChoice, Image, File, and Lookup columns;
- text, URL, email, and phone string formats;
- user-local, time-zone-independent, and date-only temporal behavior;
- full-image configuration and thumbnail metadata reconciliation;
- file size metadata;
- required and optional lookups;
- multiple lookups on one child table;
- self-referencing 1:N relationships;
- M:N relationships and generated intersect services;
- single-column and composite alternate keys;
- alternate-key activation from `Pending` to `Active`;
- explicit deferral of unsupported calculated/formula creation;
- exact post-publish verification;
- automatic uncertain-mutation reconciliation;
- journal-aware resume without blind replay;
- zero-write recovery and model materialization;
- sequential Power Apps service generation and full TypeScript validation.

Computed/formula creation was not sent to Dataverse. The one computed contract
column was deliberately `defer`, matching the supported API boundary. Primary
ID creation remained a local validation rejection and was never attempted live.

## Measured Matrix

Times below are observed values from this environment and network window. They
are not universal service-level targets. Metadata writes are server-serialized.

| Cumulative scale | New manifest operations | New tables | Extensions | Relationships | Keys | Publish | Metadata write time | Publish time | Exact verification | Services generated | Service generation | Typecheck |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 | 12 | 6 | 1 | 2 | 2 | 1 | 254,880 ms | 20,217 ms | 4,693 ms | 7 | 6,357 ms | 1,989 ms |
| 12 | 15 | 6 | 3 | 4 | 1 | 1 | 255,677 ms | 10,694 ms | 15,493 ms | 14 | 13,009 ms | 1,903 ms |
| 24 | 24 approved; 23 after recovery | 12 | 2 | 7 | 2 | 1 | 120,104 ms uncertain attempt plus 335,258 ms recovered execution | 14,820 ms | 13,580 ms | 27 | 23,888 ms | 1,825 ms |

The 24-table phase encountered a 120-second timeout while creating the first
new table. The runner classified the POST as uncertain and did not replay it.
Fresh exact reconciliation proved that Dataverse had committed the table. The
rebuilt manifest omitted that create, retained the remaining work, validated
with new hashes, and completed automatically. The successful recovered
execution recorded the uncertain create as
`fresh-reconciliation-confirmed-already-applied-or-superseded`.

The immediate successful write runs observed alternate keys as `Pending`:

- two keys at scale 6;
- one key at scale 12;
- two keys at scale 24.

Each following exact rerun observed zero pending activations and required no
metadata write or publish.

## Zero-Write Reruns

| Scale | Metadata operations | Metadata writes | Publish | Reconciliation | Verification | Mismatches | Pending keys | Materialized base tables |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 6 | 0 | 0 | 0 | 3,720 ms | 4,034 ms | 0 | 0 | 6 |
| 12 | 0 | 0 | 0 | 10,080 ms | 7,889 ms | 0 | 0 | 12 |
| 24 | 0 | 0 | 0 | 13,474 ms | 13,022 ms | 0 | 0 | 24 |

The service-generation pass completed separately at each scale in a clean app
copy. The phase-6 copy initially lacked the reference app's pre-existing
generated services while retaining screens that imported them. That fixture
mistake caused the first full-app typecheck to fail after successful Dataverse
verification and matrix service generation. Restoring the baseline generated
resources made all three app copies typecheck cleanly. This was not a template
or Dataverse production defect.

## Generic Defects Found and Fixed

### Nullable BigInt `SourceType`

Live Dataverse metadata returned an ordinary BigInt column with
`sourceType: null`. The compatibility classifier treated null as missing
evidence for BigInt, so the first six-table rerun became non-executable despite
the column being compatible.

The ordinary-null allowlist now includes BigInt. A regression test uses the
live-observed metadata shape and proves a zero-write compatible result.

### Zero-Write Materialization Recovery

When a prior invocation completed metadata and service work but failed before
materialization, the next zero-write run skipped app-owned tables because it
required either a previous materialized row or a current write operation.

Materialization now recovers approved `create`, `adapt`, and `extend` ownership
from exact verified live metadata. Pure `reuse` tables remain excluded unless
previously owned. The live six-table recovery materialized all six base tables
with real MetadataIds and no write.

### Multi-Select Semantic Type

Dataverse reports multi-select choices with the broad live metadata type
`Virtual` and type name `MultiSelectPicklistType`. Materialization previously
preferred the broad live type and emitted `Virtual`, losing the approved
semantic type.

Materialization now prefers the already verified contract type and emits
`MultiSelectChoice`. Live phase-24 model checks confirmed this for both tested
multi-select columns.

### Concurrent Execution Ownership

During the stress run, an external terminal timeout made one pipeline appear
finished while its process remained active. Starting a second invocation in the
same app directory allowed both processes to share manifest, journal, outcome,
verification, and timing paths. Dataverse's metadata lock prevented duplicate
writes, but shared artifact ownership was not safe.

The execution pipeline now acquires one app-local exclusive lock before any
execution-stage artifact work. It rejects a second live process with its PID,
reclaims a lock only when the recorded process no longer exists, and releases
only its own token. Focused tests cover active-lock rejection and stale-lock
recovery.

## Reliability Evidence

- Every successful metadata mutation returned HTTP 204.
- All relationships ran only after endpoint tables existed.
- All keys ran only after their target columns existed.
- Every publish ran after the preceding metadata phases.
- All three post-publish checks returned zero mismatches.
- All three final reruns returned `NO_PUBLISH_REQUIRED` with zero writes.
- All 27 final services generated sequentially.
- Full generated-app typecheck passed at 6, 12, and 24 tables.
- The final materialized model contained 24 base tables with valid MetadataIds.
- The full mobile-app JavaScript suite passed after the live-derived fixes.

## Business Impact

These changes primarily reduce delivery risk, engineering effort, and support
cost. They do not add an end-user feature or make Dataverse's server-side,
lock-serialized metadata writes faster.

| Business outcome | Expected value | Evidence from this work |
|---|---|---|
| Fewer failed app deliveries | Less rework and fewer partially generated apps reach testers | Fresh environment/schema binding, exact verification, and zero mismatches at all three scales |
| Lower recovery cost | Less manual investigation and no blind replay after ambiguous writes | The 24-table run recovered from a real 120-second uncertain POST through fresh reconciliation |
| Higher engineering throughput | More app work can be completed by the same team | Mechanical planning, execution, service generation, verification, and materialization have deterministic owners |
| Safer concurrent operation | Lower risk from two agents or CI jobs targeting one app | The app-local execution lock rejects active concurrent runs and reclaims stale locks |
| Better governance | Approval boundaries and audit evidence are preserved | Plan, contract, receipt, tenant, environment, reconciliation, journal, and verification artifacts are hash-bound |
| Greater scale confidence | Larger data models require less manual coordination | The same workflow completed at 6, 12, and 24 base tables with up to 27 generated resources |

### Measured Efficiency Indicators

The broader branch qualification measured the following planning improvements:

- 29.3% fewer metadata-read requests in the six-table combined-read test;
- 30.1% lower median detail-loading time in that matched test;
- 99.2% lower inventory-substage time on a qualified warm-cache hit;
- 93.2% smaller model-facing architecture evidence.

These measurements indicate less network, model-context, and orchestration
overhead. They are component results, not a guaranteed end-to-end percentage
for every app. Full definitions and qualifications are in
`docs/template-dataverse-branch-impact.md`.

### Operational Risk Reduction

The largest business benefit is avoiding expensive bad states:

- metadata applied in the wrong environment;
- duplicate writes after a timeout;
- relationships created before their endpoint tables are ready;
- an app reported complete while schema facts are missing;
- generated services that do not typecheck;
- lost app-owned model state after a restart;
- concurrent executions corrupting shared artifacts;
- an agent silently changing approved product semantics.

Known mechanical failures recover within validated bounds. Incompatible schema,
hidden-name adaptation, unsupported formula creation, permission failures, and
semantic changes fail closed or return to approval rather than being guessed.

### Financial Model

No direct currency saving can be claimed without the team's current failure and
recovery baseline. A defensible estimate is:

```text
annual avoided cost =
    runs per year
    x reduction in failed/manual-recovery runs
    x average recovery hours per affected run
    x loaded engineering cost per hour
```

Model/API savings can be estimated separately from eliminated model turns and
the measured reduction in evidence size. Dataverse metadata-write duration
should not be counted as saved time because those writes remain sequential and
server-controlled.

### Recommended Business KPIs

Track these before and after adoption to establish realized value:

- successful app-generation rate on the first approved run;
- median approval-to-working-app lead time;
- manual interventions per app creation;
- recovery hours after metadata timeouts or partial failures;
- wrong-environment, duplicate-schema, and incomplete-generation incidents;
- generated-service/typecheck failure rate;
- model turns, tokens, and model duration per app;
- support tickets caused by schema or generated-client drift.

## Cleanup

Cleanup deleted base tables in reverse dependency order. M:N intersect tables
were removed with their owning relationships. The first delete timed out after
120 seconds, so it was treated as uncertain; fresh exact reconciliation proved
the table absent before cleanup resumed. No uncertain delete was blindly
replayed.

Final authoritative read-only reconciliation:

| Fact | Result |
|---|---:|
| Requested logical names | 27 |
| Loaded logical names | 0 |
| Unavailable logical names | 27 |
| Proposed-name collisions | 0 |
| Proposed names missing | 27 |
| Detail-load failures | 0 |
| Duration | 2,446 ms |

No `new_mx142305*` table or intersect resource remains in the live environment.

## Conclusion

The matrix validated cumulative create, extension, relationship, key, media,
service-generation, verification, recovery, and cleanup behavior at all three
requested scales. It also produced four generic fixes that apply beyond the
test schema: BigInt idempotency, restart-safe materialization, semantic
multi-select materialization, and app-local single-writer execution ownership.