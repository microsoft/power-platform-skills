# Dataverse planning recovery

A step both build orders of `/create-mobile-app` run: [`make-it-real.md`](make-it-real.md) (screens first) and
[`data-model-first.md`](data-model-first.md) (data model first) each read it under their own numbered heading.
Fix it here and both orders get the fix.

Steps it names, by build order:

| Named here | Screens first | Data model first |
|---|---|---|
| this step | part of Step 10 | part of Step 3 |
| the inline-gate fallback | Step 10.0a | Step 3.0a |
| the style-picker handoff | none | Step 3a |
| the architecture gate | architecture gate | Gate 1 |
| the data model gate | data model gate | Gate 2 |

<!-- The step starts here; everything above is about the file. -->

The structured Dataverse signals below use monotonic name tracking or
deterministic revision instead of the generic retry cap. In `required` only,
initialize two in-memory sets from the current validated snapshot before
handling either metadata signal:

- `DETAIL_ATTEMPTED_NAMES` — every logical name already present in
  `selectedTables` with `detailLevel: full`,
  `exactNameResolution.unavailableTables`, or `detailLoadFailures`. A
  `selectedTables` entry with `detailLevel: core` is not fully attempted and
  remains eligible for one full-detail expansion.
- `PROPOSED_CHECKED_NAMES` — every logical name in
  `proposedNameChecks.checked`.

Expansion is monotonic: each network request contains only names not already in
the applicable set, and no expansion reruns broad inventory discovery. There
is no fixed expansion-round count. Continue automatically while the planner
identifies new exact names derived from the approved brief or current evidence.
Every re-dispatch preserves the approved architecture and `complete` phase;
metadata recovery does not reopen the architecture gate or change connector ownership.

**Data-model deterministic revision:** when the planner returns
`NEEDS_CONTEXT: dataverse-plan-revision:<short-safe-classification>`, do not
route it through the generic `NEEDS_CONTEXT` retry cap. Immediately run the
existing inline data-model revision path with the same snapshot, compact
evidence, and approved architecture. Perform no metadata read and ask no user
question. Reclassify known collisions or attempted unavailable detail as
`Reuse`, `Extend`, `Adapt`, or `Defer` as the verified evidence permits,
regenerate and validate the contract, and then present the data model gate. Ask the user
only if the remaining alternatives change business semantics.

**Data-model exact-name expansion:** when the planner or direct architect
returns exactly
`NEEDS_CONTEXT: detailed-dataverse-metadata:<logical names>`, sort and
de-duplicate those names. This signal is valid only in `required` mode with a
validated base snapshot, whether it came from the planner or the direct
architect fallback; receiving it in `connector-only` mode is `BLOCKED`.
Compute `NEW_DETAIL_NAMES = requested names - DETAIL_ATTEMPTED_NAMES`.

- If `NEW_DETAIL_NAMES` is non-empty, perform the exact foreground expansion
  below for only those names. Reuse the existing snapshot inventory and do not
  run another broad inventory query.
- If it is empty, do not issue another network request. Re-dispatch with the
  explicit fact that every requested name was already attempted. The architect
  must use the current full evidence, or classify an unavailable/incompatible
  dependency as `Defer`. It may ask the user only when a genuine business
  choice remains, such as choosing between a shared existing system of record
  and a new app-owned table.

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --base-snapshot "$SNAPSHOT_PATH" \
  --output "$SNAPSHOT_PATH" \
  --tables "<NEW_DETAIL_NAMES as exact comma-separated logical names>" \
  --combined-base-read \
  --read-concurrency 1

node "${PLUGIN_ROOT}/scripts/render-dataverse-architect-evidence.js" \
  --snapshot "$SNAPSHOT_PATH" \
  --output "$ARCHITECT_EVIDENCE_PATH"

node -e '
  const s=require(process.argv[1]);
  const x=s.expansion;
  const d=s.detailLoadSummary;
  console.log(`✓ Expansion requested: [${x.requestedTables.join(", ")}]`);
  console.log(`✓ Expansion loaded: [${x.loadedTables.join(", ")}]`);
  console.log(`✓ Expansion unavailable: [${x.unavailableTables.join(", ")}]`);
  console.log(`✓ Expansion details: ${d.attemptedCandidates} attempted, ${d.loadedCandidates} loaded, ${d.failedCandidates} failed`);
  console.log(`✓ Expansion timing: metadata ${s.timings.inventoryRetrievalMs} ms, selection ${s.timings.candidateSelectionMs} ms, details ${s.timings.detailLoadingMs} ms, total ${s.timings.totalDurationMs} ms`);
' "$SNAPSHOT_PATH"
```

Print the expansion's requested/loaded/unavailable names and timings
immediately, add every attempted name to `DETAIL_ATTEMPTED_NAMES`, then
re-dispatch the same planner or architect with the same
snapshot/architect-evidence paths. A later detail signal is handled by the same
set-difference rule. Never repeat a name, broaden concepts, or defer exact
validation to mutation.

**Data-model proposed-name expansion:** when the planner or direct architect
returns exactly
`NEEDS_CONTEXT: proposed-dataverse-names:<logical names>`, sort and de-duplicate
those names. This signal is valid only in `required` mode with a validated
snapshot. Compute
`NEW_PROPOSED_NAMES = requested names - PROPOSED_CHECKED_NAMES`.

- If `NEW_PROPOSED_NAMES` is non-empty, perform the collision-only foreground
  expansion below for only those names.
- If it is empty, do not issue another network request. Re-dispatch with the
  existing present/missing results. A checked-missing name can support
  `Create`; a collision must be reconciled as `Reuse`, `Extend`, or `Adapt`.
  If `Adapt` produces a new final logical name, that new name flows through
  this same set-difference rule automatically.

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --base-snapshot "$SNAPSHOT_PATH" \
  --output "$SNAPSHOT_PATH" \
  --proposed-tables "<NEW_PROPOSED_NAMES as exact comma-separated logical names>" \
  --combined-base-read \
  --read-concurrency 1

node "${PLUGIN_ROOT}/scripts/render-dataverse-architect-evidence.js" \
  --snapshot "$SNAPSHOT_PATH" \
  --output "$ARCHITECT_EVIDENCE_PATH"
```

This expansion checks collisions only; it does not treat absent proposed names
as required existing tables or load their details. Add every checked name to
`PROPOSED_CHECKED_NAMES` and re-dispatch. Later proposed-name signals use the
same set-difference rule. If a collision is found and the architect needs
compatibility facts, it may request incremental
`detailed-dataverse-metadata` for that existing table.

**No-progress fallback:** if an agent repeats a metadata signal containing only
already-attempted names after receiving the explicit no-new-names instruction,
do not block the create flow for another metadata retry. Run the existing
inline data-model revision path against the current compact evidence. Preserve
safe decisions, classify unresolved required-existing or incompatible targets
as `Defer`, regenerate and validate the contract, and present the result at
the data model gate. Ask the user only when the remaining choice changes business semantics;
do not ask merely because metadata is unavailable.

Planner-only early-return signals are handled before the status switch.

**Data model first.** `INDUSTRY_CONFIRM_REQUESTED:` routes to the inline-gate fallback and `DESIGN_VIBE_REQUESTED:` routes to the style-picker handoff; after the handoff, re-spawn the planner and process its new first line through this switch.

**Screens first.** This skill always passes `Design vibe opt-in: done` (or `skip`), so the planner never needs an industry or style question.
Treat a first line of `INDUSTRY_CONFIRM_REQUESTED:` or `DESIGN_VIBE_REQUESTED:` as malformed, and ignore any `PLAN_PREVIEW_PATH:` line: the live preview replaced plan-time HTML mockups.
