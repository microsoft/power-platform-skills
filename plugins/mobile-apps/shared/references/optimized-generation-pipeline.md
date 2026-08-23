# Optimized Mobile Generation Pipeline

This pipeline is shared by real app creation, mock-backed prototype creation,
prototype graduation, and later `/sync-from-plan` runs. Optimization may reduce
repeated model/file/process work; it never removes an approval or hard gate.

## Optimization Plan

| Priority | Change | Expected saving | Implementation |
|---:|---|---:|---|
| 1 | Deterministic template preparation | 30–90 sec | `prepare-mobile-template.js` |
| 2 | Structured screen contract; deterministic navigation, service inventory, skeletons | 60–150 sec | `screen-contract.json`, `build-screen-artifacts.js` |
| 3 | Hash-bound builder context packets | 60–180 sec | `build-builder-context.js` |
| 4 | Reuse planner design recommendation and persist one canonical receipt | 20–60 sec | `design-recommendation.json`, `brand/design-decision.json` |
| 5 | Batch independent native wrappers and join once | 30–120 sec | `plan-native-batches.js`, `native-batch-builder` |
| 6 | Preserve every TypeScript gate with compatible incremental state | 30–90 sec | `run-tsc-gate.js` |
| 7 | Batch changed-file validators and reuse hash-identical PASS receipts | 30–90 sec | `run-validation-batch.js` |
| 8 | Run final read-only checks concurrently; retain repair order | 10–30 sec | `run-final-checks.js` |
| 9 | Hash-lock preview beside final validation and delete on drift | 20–60 sec | `preview-lock.js` |
| 10 | Complexity-pack waves and remove the no-op builder probe | 15–60 sec | `pack-screen-waves.js` |

Savings overlap and must not be added arithmetically. The expected end-to-end
target remains a 25–35% reduction on representative full-scope apps. Script
integration tests measure deterministic local overhead (normally milliseconds
to low seconds), not model, user-approval, Dataverse-network, or full-project
compiler time. Keep collecting matched full-run timings before tightening the
estimate.

## Artifacts

| Artifact | Owner | Purpose |
|---|---|---|
| `.tmp/template-prep-receipt.json` | `prepare-mobile-template.js` | Hash-bound deterministic template surgery |
| `.tmp/design-recommendation.json` | `native-app-planner` | Recommendation-only design handoff |
| `brand/design-decision.json` | `/design-system` | Confirmed/draft final design and artifact hashes |
| `.tmp/screen-contract.json` | `screen-planner` | Approved routes, services, native dependencies, and typed scaffolds |
| `.tmp/navigation-contract.json` | `build-screen-artifacts.js` | Normalized route/layout contract |
| `.tmp/service-inventory.json` | `build-screen-artifacts.js` | Exact generated service signatures |
| `.tmp/screen-artifacts-receipt.json` | `build-screen-artifacts.js` | Hashes of layouts and skeletons |
| `.tmp/builder-context/*.json` | `build-builder-context.js` | Immutable per-screen builder packets |
| `.tmp/native-batches.json` | `plan-native-batches.js` | Disjoint, deduplicated native work groups |
| `.tmp/native-bundle-validation.json` | `plan-native-batches.js` | Joined native wrapper verification |
| `.tmp/screen-waves.json` | `pack-screen-waves.js` | Complexity-balanced waves capped at five |
| `.tmp/tsc-cache-manifest.json` | `run-tsc-gate.js` | Compatible TypeScript incremental state metadata |
| `.tmp/validation-receipt.json` | `run-validation-batch.js` | Per-file/validator hashes and results |
| `.tmp/final-checks-receipt.json` | `run-final-checks.js` | Concurrent final hard-gate results in repair order |
| `.tmp/preview-lock.json` | `preview-lock.js` | Preview/source hash binding and invalidation |

## Quality Invariants

1. Every TypeScript gate executes. Earlier gates may reuse TypeScript's own
   incremental graph; the final gate always deletes build info and runs clean.
2. Cached validator results are reused only when the file bytes, validator
   bytes, and approved dependency inputs have identical hashes.
3. Screen builders verify their packet before writing. A stale plan, design,
   service, route, reference, or target skeleton hash blocks the builder.
4. Dataverse and connector mutations stay sequential because they share
   `src/generated/` and `power.config.json`. Only disjoint native wrappers and
   screen files are parallelized.
5. Native capability groups own disjoint wrapper files. One join gate verifies
   every expected wrapper and one TypeScript gate validates the combined result.
6. Final route, screen-contract, quality, contrast, and clean TypeScript checks
   run concurrently only after source files are frozen. Failures are repaired
   in route → contract → quality → contrast → TypeScript → changed-file order.
7. A preview may run beside final read-only checks. `preview-lock.js` deletes it
   if any source hash changes before finalization.
8. Atomic writes are required for every receipt. Missing, malformed, or stale
   artifacts fail closed; downstream steps never reconstruct contracts from
   free-form Markdown.

## Resume And Cleanup

- Input receipts (plan/design/screen/native contracts) survive failures.
- Partial validation, final-check, preview-lock, and wave outputs may be removed
  and regenerated after repair.
- `.mobile-app/state.json` records hashes of successful optimization receipts;
  a missing optional receipt maps to `null`, never to an empty-file hash.
- Legacy projects must regenerate structured contracts through their owning
  planner/design workflow. Sync does not synthesize prior approval.
