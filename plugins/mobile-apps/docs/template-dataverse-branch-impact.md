# Mobile Template and Dataverse Branch Impact

## Purpose

This report summarizes the complete mobile-app quality work carried by
`feat/mobile-template-dataverse-only` as of 2026-08-29. It covers:

- product-specific experience compilation inherited by the branch;
- base mobile template quality and deterministic preparation;
- Dataverse planning and model-evidence optimization;
- Dataverse mutation safety, recovery, and verification;
- the deterministic planning, scaffold, and execution phase pipeline;
- measured timing, projected savings, and reliability impact.

The primary value is reliability and removal of model-orchestrated mechanical
work. Dataverse metadata writes remain server-side, lock-serialized operations,
so this branch does not claim to make the Dataverse service itself faster.

## Branch Scope

The branch diverges from `origin/main` at
`283f79ec9d5723d14fd3fb8e0cd1d90b077433a9` and contains these commits:

| Commit | Scope |
|---|---|
| `5270bd02` | Product-specific experience compiler and screen-build contracts |
| `7898ea24` | Base template and Dataverse planning quality gates |
| `dfcc1754` | Dataverse execution, recovery, media, evidence, and verification hardening |

Before the deterministic pipeline follow-up documented here, the three
foundation commits changed 103 unique files with 18,171 additions and 1,382
deletions relative to the merge base. The pipeline, live-matrix reliability
fixes, tests, and reports are included in the branch by the change containing
this report.

Generated packaging artifacts under the following paths are unrelated and are
excluded from this report:

```text
plugins/mobile-apps/.claude-plugin/plugin.json
plugins/mobile-apps/.plugin/plugin.json
plugins/mobile-apps/com.github.copilot/
```

## Terms and Evidence Classes

- **Pipeline invocation** means one top-level
  `run-mobile-app-pipeline.js <mode>` call with one control-flow owner. The
  pipeline still launches existing Node and Power Apps CLI child processes.
  Planning, scaffold, and execution are separate invocations because model
  planning and user approval occur between them.
- **Bounded** means a fixed, validated limit exists, such as a maximum candidate
  count, exact-name count, timeout, or recovery-attempt count. It does not mean
  "best effort until success."
- **Integrity-protected** means a SHA-256 binding detects accidental stale or
  mismatched artifacts. It is not a security boundary against a malicious
  process that can rewrite both content and hashes.
- **Connector-only** means the approved app uses connectors but has no Dataverse
  table model. Its planning invocation resolves environment context but sends
  no Dataverse metadata request.
- **Measured component comparison** is a matched comparison of one bounded
  substage. It must not be presented as total app-creation savings.
- **Measured absolute time** is how long the new path took in one recorded run.
  It is not a saving unless a matched old-path run exists.
- **Observed overhead opportunity** is time seen in one problematic historical
  run. It identifies what the fixes target, not what they guarantee to remove.
- **Projection** is an explicit formula or scenario based on assumptions, not a
  benchmark result.

## Executive Impact

### Defensible conclusion

The branch should save time, but there is not yet a matched end-to-end A/B
benchmark that supports one universal number.

The following are component comparisons or absolute new-path measurements:

- six-table combined metadata reads removed 24 of 82 requests, a 29.3% request
  reduction;
- the same combined-read comparison reduced median detail loading by 965 ms,
  or 30.1%;
- a warm inventory-cache hit reduced the inventory substage from 1,021 ms to
  8 ms, a 99.2% substage reduction;
- model-facing architect evidence fell from 3,308,041 bytes to 225,348 bytes,
  a 93.2% reduction and a 14.7x smaller payload;
- the new single-invocation planning pipeline completed a live read-only run in
  9.65 seconds;
- the new full zero-write execution pipeline completed fresh resolution,
  reconciliation, validation, execution, verification, and isolated
  materialization in about 3.46 seconds;
- a live Image configuration PUT took 1.326 seconds, proving the automatic
  replacement for a previously manual correction path; there is no matched
  measurement for the old manual repair duration;
- operation-class timeouts allowed a 72.099-second table create to complete
  under the 120-second table-write policy instead of becoming uncertain at the
  former 30-second threshold.

### How to estimate end-to-end savings

No fixed clean-run range is claimed. The unmeasured orchestration component can
be estimated for a particular host as:

```text
projected orchestration saving
  = eliminated model scheduling turns
  x measured median latency per model scheduling turn
```

For illustration only, five eliminated turns at 3 seconds per turn would save
about 15 seconds; ten eliminated turns at 10 seconds per turn would save about
100 seconds. The actual number of eliminated turns depends on how aggressively
the host previously batched shell commands, so this document does not select one
of those examples as the expected result.

The defensible scenario summary is:

| Scenario | What is known |
|---|---|
| Clean first planning run | Matched component tests saved 965 ms in detail loading; the new complete planning invocation took 9.65 seconds in one live run |
| Warm planning rerun | Inventory alone saved 1,013 ms in the measured pair; total planning wall time was not comparable because detail latency varied |
| Clean approved execution | Dataverse write and service time remain; only model scheduling between deterministic commands is removed and has not been A/B measured |
| Fully applied rerun | The complete new zero-write execution invocation took about 3.46 seconds in one live run; there is no matched old-path total |
| Recoverable uncertain write | One fresh reconciliation, rebuild, validation, and resume now occurs without a model turn; time saved depends on host turn latency and Dataverse response time |
| Failure-heavy run | One historical run contained 748 seconds of non-final-write overhead; that is a one-run opportunity ceiling, not a typical saving |

Hidden collisions that change approved technical identity still stop at the
approval boundary, and Dataverse server latency remains.

## Measured Timing Detail

### Planning metadata benchmark

A 12-run GET-only qualification matrix used one 496-table environment and the
same typed receiving brief. Every run selected the same six full-detail tables,
returned the same normalized facts, and had zero retries, rate limits, token
refreshes, or failed detail loads.

| Read concurrency | Median total | p95 total | Median detail | p95 detail |
|---:|---:|---:|---:|---:|
| 1 | 4,520 ms | 9,743 ms | 3,210 ms | 3,491 ms |
| 2 | 3,160 ms | 3,491 ms | 1,986 ms | 2,028 ms |
| 3 | 2,260 ms | 2,326 ms | 1,294 ms | 1,608 ms |
| 4 | 1,934 ms | 2,427 ms | 1,303 ms | 1,370 ms |

Concurrency 2-4 remains opt-in. Production stays at concurrency 1 until the
same tail-latency and no-throttling result is reproduced across more
environments and larger candidate sets.

At concurrency 1, combined base reads changed:

| Measurement | Separate reads | Combined read | Difference |
|---|---:|---:|---:|
| Requests | 82 | 58 | 24 fewer, 29.3% |
| Response bytes | 1,293,652 | 1,291,317 | 2,335 fewer |
| Detail loading | 3,210 ms median | 2,245 ms | 965 ms faster, 30.1% |

The cache qualification definitely reduced the inventory substage by 1,013 ms,
from 1,021 ms to 8 ms, and removed the broad inventory GET. The comparison does
not establish total planning wall-time improvement because unrelated detail
request latency varied between the two runs. The inventory result and the
combined-read detail result are separate measurements and are not added together
as one end-to-end saving.

### Recorded recovery-heavy Dataverse run

| Measurement | Result |
|---|---:|
| Full application and recovery window | 13 minutes 19 seconds |
| Final five successful operations | About 51 seconds |
| Successful table creation | 25.93 seconds |
| Image-column creation | 3.28 seconds |
| Relationship creation | 9.93 seconds |
| Alternate-key creation | 1.18 seconds |
| Publish | 6.78 seconds |
| Non-final-write overhead | About 12 minutes 28 seconds |

This is one failure-heavy run, not a representative baseline. Its overhead
included manifest repair, a 30.22-second uncertain timeout, hidden
name collision `0x80044363`, contract/checkpoint propagation, and correction of
an incomplete full-image definition. This branch directly addresses each class,
except that semantic collision changes still require approval.

### Live execution qualification

The generic live test created two tables with String, File, Image, lookup, and
alternate-key metadata:

| Stage | Result |
|---|---:|
| Metadata writes | 142.490 seconds |
| Publish | 9.730 seconds |
| Post-publish verification | 2.141 seconds |
| Total measured path | 154.361 seconds |

This demonstrates why orchestration must not be confused with Dataverse server
time. The metadata writes dominate and remain sequential.

A second live test qualified the fixed Image path:

| Stage | Result |
|---|---:|
| Table create | 39.387 seconds |
| Full-image configuration PUT | 1.326 seconds |
| Publish | 10.034 seconds |
| Verification | 1.664 seconds |
| Total measured path | 52.411 seconds |

Its immediate rerun performed zero metadata writes and required no publish.
The 1.326-second Image value above refers to this same configuration PUT, not a
separate measurement.

## Reliability Impact

| Previous failure mode | Branch behavior now | Reliability effect |
|---|---|---|
| Model schedules every deterministic command | One local invocation per planning, scaffold, or execution phase | Fewer skipped, duplicated, or reordered steps |
| Planning snapshot can be paired with stale evidence | Immutable generation directory plus one atomic current pointer | Snapshot, sidecar, and shards move together or not at all |
| One high-fan-out table dominates model context | Decision-bearing projection plus hash-bound omitted-evidence shards | Bounded model payload without weakening local validation |
| Planner requests omitted metadata | Exact local evidence lookup from the current full snapshot | No broad rediscovery and no full-table model dump |
| Planning metadata timings have multiple owners | Snapshot owns metadata timings; pipeline owns surrounding stages | Prevents successful work being recorded as failed |
| Cached environment is trusted during execution | `--no-cache` now bypasses cache reads; ID, URL, tenant, and `power.config.json` are compared | Reduces wrong-environment mutation risk |
| Planning evidence is used as write authority | Execution always performs a fresh exact reconciliation | Planning staleness cannot directly authorize a write |
| Server-owned primary ID appears in a mutable contract | Contract validation rejects it before reconciliation | Prevents invalid or dangerous primary-ID operations |
| Image creation silently stores thumbnails only | Journaled full-definition Image PUT before publish, then two-view verification | Full-image capability is applied and proven |
| File/Image report `SourceType: null` | Compatibility uses media type-name and media constraints | Prevents false incompatibility on valid virtual columns |
| All metadata requests use one 30-second timeout | Read, table, column, relationship/key, and publish classes use bounded defaults | Fewer false uncertain outcomes while retaining timeout safety |
| Mutation transport loss is replayed or manually interpreted | Journal-before-write plus fresh reconciliation and one automatic bounded resume | Avoids blind duplicate mutation |
| Hidden name collision appears only after POST | Immutable collision evidence plus approval-bound deterministic suffix probing | Consistent adaptation without ad hoc search-and-replace |
| Collision revision loses prior publication state | Integrity-protected checkpoint roll-forward | Completed writes remain publish-pending and auditable |
| Publish succeeds but verification is broad or absent | Exact changed-scope verifier checks table, column, relationship, key, media, and table settings | Detects false success with an actionable fact |
| Alternate key is `Pending` after successful creation | `DONE_WITH_PENDING_ACTIVATIONS` is compatible but explicit | App does not assume uniqueness is active too early |
| Service generators run concurrently | Required services run sequentially after verification | Avoids generated schema and `power.config.json` races |
| Successful path omits `.datamodel-manifest.json` | Deterministic environment-bound materializer merges verified changed tables and preserves unrelated prior entries | Sample-data and offline workflows receive a complete model |
| Scaffold preparation partially mutates files | Preparation captures state and rolls back on failure | Fresh template is not left half-modified |
| Generated sources are hand-written or reset | Preparation never owns `src/generated/` | Power Apps CLI remains the sole generated-file owner |
| Root route and safe-area ownership is inconsistent | Root provides context; routes own visible insets | Avoids double insets and missing safe-area context |
| OAuth callback effect navigates twice in development | Replacement is idempotency-guarded | Prevents duplicate callback navigation |

### Reliability evidence map

The reliability table is supported by focused automated suites and live checks,
not elapsed-time claims:

| Evidence area | Focused tests | What it covers |
|---|---:|---|
| Parent phase pipeline | 18 | Phase ownership, connector-only behavior, scaffold binding, execution ordering, path containment, check disclosure, structured failure, and bounded uncertainty recovery |
| Materialized Dataverse manifest | 6 | Aliases, media, relationships, keys, server IDs, partial-contract preservation, and cross-environment rejection |
| Template preparation | 8 | Idempotency, generated-file preservation, approved-plan allowance, provider/safe-area states, and full rollback after failure |
| Environment resolution | 7 | True no-cache reads, cache persistence, safe response descriptions, and secret redaction |
| Dataverse operation manifest | 46 | Approval binding, operation coverage, media, primary-ID rejection, idempotency, checkpoints, collisions, relationships, and keys |
| Deterministic Dataverse executor | 5 | Sequential phases, uncertainty, collision evidence, publish failure, and cache invalidation |
| Post-publish verifier | 12 | Inline columns, table settings, relationship semantics, key members/state, File/Image behavior, and zero-write completion |

These seven focused suites contain 102 tests. The full plugin suite contains 412
tests. Template route and OAuth callback rules are additionally checked by the
template quality-contract suites. Live qualification covered environment
binding, planning evidence, zero-write execution, full-image mutation, publish,
verification, and cleanup.

## Complete Change Inventory

### 1. Product Experience compiler

Commit `5270bd02` adds deterministic product and screen planning contracts:

- JSON schemas for Product Experience, Product Scope, Workflow Journey, and
  compiled screen build packs.
- Lightweight schema validation and deterministic product-composition rules.
- Product scope, workflow journey, and experience validators.
- Deterministic screen-build-pack compilation.
- A product-specific interactive preview renderer.
- Screen-planner and screen-builder contracts that consume compiled build packs.
- Domain composition rules intended to discourage generic card-heavy output,
  with unfamiliar-domain and composition fixtures.
- A curated sample-image CDN catalog and media planning rules.
- Updated design-system guidance, navigation rules, camera/sample-data handoff,
  and planner approval flow.
- Test fixtures for unfamiliar domains, commerce, healthcare, inspection,
  navigation, rendering, scope, composition, and CLI behavior.

This layer primarily improves output consistency and reduces design rework. No
matched end-to-end time saving is claimed for model design work.

### 2. Base template quality

Commit `7898ea24` establishes a production-ready template baseline:

- Complete semantic Tamagui tokens for light and dark themes, including surface,
  media, accent, text hierarchy, status pairs, and monospace roles.
- Starter home, login, and OAuth callback routes using semantic tokens,
  accessible icons, and route-owned safe-area edges.
- Root `SafeAreaProvider`, host theme selection, project Tamagui configuration,
  schema wiring, and optional offline-profile wiring.
- Idempotent OAuth callback navigation.
- Deterministic `prepare-mobile-template.js` ownership for identity, aliases,
  shared helpers, root layout, and legacy cleanup.
- Exact rollback after failed preparation.
- Strict generated-file ownership for `src/generated/`.
- Environment persistence only after user approval.
- No-cache resolution mode and redacted HTTP diagnostics.
- Correct Dataverse -> materialization -> sample data -> offline setup order.
- Expanded source validation and mobile script CI.
- Portable leaf-agent model selection.

### 3. Dataverse planning and discovery

Commits `7898ea24` and `dfcc1754` add:

- Snapshot-first planning with typed concepts.
- Entity versus role/attribute/action/status/constraint classification.
- Bounded candidate selection with primary and ambiguity candidates.
- Progressive `inventory`, `core`, and `full` metadata detail.
- Exact required-name discovery and separate proposed-name collision checks.
- Combined base metadata reads with continuation handling.
- Production read concurrency 1 with opt-in measured concurrency 2-4.
- Five-minute inventory cache with environment, tenant, solution, API, and
  schema identity binding.
- Telemetry for request category, bytes, duration, retries, rate limits, token
  acquisition, and timeout class.
- Single timing ownership for inventory, candidate selection, detail loading,
  expansion, evidence, model work, approval, execution, and recovery.
- Architect evidence schema v2 with deterministic projection and shards.
- Immutable planning generations and atomic current pointer.
- Snapshot-hash validation for sidecar and every shard.
- Bounded targeted evidence extraction from the local full snapshot.
- Full-evidence requirement before Reuse, Extend, or Adapt.

### 4. Dataverse contract and mutation safety

Commit `dfcc1754` adds:

- Strict schema-contract and approval-receipt binding.
- Rejection of mutable server-owned primary-ID declarations.
- Exact Image/File writable capability validation.
- Correct Image `MaxSizeInKB` and `CanStoreFullImage` semantics.
- Rejection of writable `MaxHeight` and `MaxWidth` thumbnail claims.
- A live-qualified `configure-image` PUT before publish.
- Operation-class timeout defaults and bounded CLI overrides.
- Sequential metadata execution through one process and token.
- Atomic mutation journal with stable operation fingerprints.
- No mutation `$batch` and no concurrent metadata writes.
- No uncertain mutation retry without fresh exact reconciliation.
- Structured execution outcomes and separated timings.
- Hidden-collision detection from real Dataverse HTTP response bodies.
- Journal-persisted bounded collision codes.
- Approval-bound deterministic alternative-name selection.
- Checkpoint roll-forward that preserves completed tables, columns,
  relationships, Image configuration, and keys.
- Targeted post-publish verification, including relationship semantics, exact
  key members, File/Image limits, full-image configuration, offline flags, and
  change tracking.
- Explicit compatible handling for asynchronous alternate-key `Pending` state.
- Cache invalidation only after confirmed publish.
- Zero-write idempotent reruns.

### 5. Deterministic phase pipeline

The deterministic pipeline follow-up adds
`scripts/run-mobile-app-pipeline.js` with three invocation modes:

#### Planning mode

- Fresh environment resolution.
- Publisher-prefix detection.
- Foreground planning snapshot or bounded expansion.
- Snapshot-owned metadata timings and telemetry.
- Evidence render, validation, immutable generation promotion, and pointer
  update.
- Connector-only context path with zero Dataverse metadata reads.
- Integrity-protected structured output passed to the semantic planner.

#### Scaffold mode

- Integrity-bound planning environment handoff.
- Optional deterministic template preparation.
- Existing `power.config.json` validation or one `power-apps init`.
- Dependency postcondition check.
- One scaffold TypeScript gate.
- Support for the approved `native-app-plan.md` at the post-planning boundary
  while keeping all other created-app markers blocking.

#### Execution mode

- Fresh no-cache environment resolution and comparison with planning output and
  `power.config.json`.
- Contract binding and exact reconciliation-scope derivation.
- Fresh exact execution reconciliation.
- Deterministic manifest build and `--require-executable` validation.
- Check mode that reports whether execution would mutate and lists operation and
  service counts.
- Journaled metadata execution and publish.
- One bounded automatic uncertain-result reconciliation, rebuild, validation,
  and resume by default.
- Collision return at the semantic/approval boundary.
- Exact post-publish verification before service generation.
- Strictly sequential `power-apps add-data-source` calls.
- One connector-schema generation and one generated-service typecheck.
- Environment-bound `.datamodel-manifest.json` materialization that preserves
  unrelated previous entries and aliases.
- Atomic integrity-protected phase output with bounded redacted diagnostics.

The pipeline still uses child processes for existing Node scripts and the Power
Apps CLI. "One process" therefore means one local pipeline invocation and one
owner for control flow, not literally one operating-system process.

### 6. Skill routing

`create-mobile-app` now uses separate deterministic invocations at the correct
semantic times:

```text
planning pipeline
  -> model architecture and user approval
  -> scaffold pipeline
  -> product experience approval
  -> approved execution pipeline
```

`add-dataverse` delegates approved-contract calls to the execution pipeline and
has an explicit hard gate that skips the legacy fallback after pipeline success.
Manual or legacy planning remains available when no approved contract exists.

## Validation Evidence

### Automated

- Full mobile-app plugin suite: 414 tests passed, 0 failed.
- The seven directly relevant reliability suites contain 104 focused tests: 19
  pipeline, 7 materialization, 8 template preparation, 7 environment, 46
  operation-manifest, 5 execution, and 12 post-publish verification tests.
- New pipeline tests cover planning, connector-only planning, bounded expansion,
  scaffold, environment mismatch, execution check, real execution ordering,
  sequential service generation, isolated materialization, schema-version and
  integrity rejection, redacted malformed-output diagnostics, structured
  verification failure, persistent uncertainty, and automatically recovered
  uncertainty.
- Materialization tests cover aliases, media, relationships, keys, server IDs,
  changed existing tables, zero-write ownership preservation, partial-contract
  merging, and cross-environment rejection.
- Production JavaScript syntax checks pass.
- Editor diagnostics are clean for the changed production scripts.
- `git diff --check` passes.

### Generated-app and live Dataverse checks

- Planning pipeline completed against the existing generated app and
  NativeAppTesting in 9.65 seconds.
- The existing app's old approval-bound contract correctly failed closed because
  it still contained pre-fix Image fields.
- A fresh, approval-bound reuse contract completed `execute --check` with a
  fresh environment source, 1.094-second exact reconciliation, and zero
  operations.
- A full zero-write execution pipeline completed with `DONE`,
  `NO_PUBLISH_REQUIRED`, zero mismatches, and isolated materialization in about
  3.46 seconds.
- Live mutation qualification proved the full-image PUT, operation timeout
  classes, relationship/key verification, and zero-write rerun behavior.
- A cumulative 6/12/24-table live matrix validated all supported ordinary
  column families, table extensions, 1:N/self/M:N relationships, alternate
  keys, Image/File metadata, 27 sequential generated services, exact
  verification, uncertain-mutation recovery, and zero-write reruns. Full
  measurements and cleanup evidence are in
  `docs/dataverse-live-matrix-6-12-24.md`.
- The matrix found and fixed nullable BigInt `SourceType` reconciliation,
  restart-safe zero-write materialization, MultiSelectChoice semantic
  materialization, and concurrent execution ownership.
- Disposable live tables were deleted; exact-name verification returned no
  remaining definitions.
- Generated-app smoke artifacts were removed after validation.

## What Does Not Become Faster

- Dataverse metadata writes remain sequential because Dataverse holds an
  exclusive metadata lock.
- `power-apps add-data-source` remains sequential because it writes shared
  generated files and `power.config.json`.
- Model architecture, product design, and user approval remain semantic steps
  between deterministic phase invocations.
- A hidden collision that changes an approved contract still requires the
  approval workflow.
- Screen-builder quality work is not replaced by the deterministic pipeline.

## Remaining Measurement Work

Before publishing a universal end-to-end speed claim, run at least three matched
old-versus-new app creations with the same:

- environment and tenant;
- approved brief and table contract;
- cache state;
- machine and network window;
- model and host;
- service-required table set.

Record separately:

- local pipeline wall time;
- Dataverse metadata network time;
- metadata write and publish time;
- service-generation time;
- model turns, tokens, and model duration;
- user approval waiting;
- recovery and collision duration;
- post-publish verification;
- total end-to-end wall time.

Until that matched benchmark exists, use the measured component reductions,
absolute new-path times, and the scheduling-latency formula in this document,
not a single guaranteed percentage.

## Bottom Line

Measured component savings are 965 ms for combined-read detail loading and
1,013 ms for the warm inventory substage in the qualified environment. The new
complete paths took 9.65 seconds for planning and about 3.46 seconds for a
zero-write execution run. Additional savings from removed model scheduling must
be calculated from the host's eliminated turn count and measured turn latency.
The 12-minute-28-second figure is only the non-final-write overhead observed in
one failure-heavy historical run; it is not a measured branch saving.

The larger benefit is reliability: every deterministic phase now has one owner,
fresh environment and metadata bindings, atomic artifacts, journaled writes,
bounded recovery, exact verification, and downstream materialization. That
reduces the probability that a fast run produces a stale, partially generated,
or falsely successful application.