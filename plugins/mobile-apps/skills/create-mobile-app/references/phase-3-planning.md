# Planning and Approval Contracts

### Step 3 — Plan (planner agent + 4 approval gates)

First, create the working and planning-artifact directories:

```bash
mkdir -p <working_dir> <working_dir>/.tmp
PLANNING_TIMINGS_PATH="<working_dir>/.tmp/mobile-planning-timings.json"
if [ -n "${PUBLISHER_PREFIX_DURATION_MS:-}" ]; then
  node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
    --project-root "<working_dir>" --stage publisherPrefixDetection \
    --action record --duration-ms "$PUBLISHER_PREFIX_DURATION_MS"
fi
```

For every timed command or agent dispatch below, call `planning-timings.js`
with `--action start` immediately before it and `--action finish` immediately
after success. On `BLOCKED` or command failure use `--action fail --reason
<short-safe-classification>`; on `NEEDS_CONTEXT` use `--action needs-context
--reason <short-safe-classification>`, then start the re-dispatch with
`--retry`. Never put prompts, requirements, credentials, URLs, or response
bodies in `reason`. Model token/cost fields are optional and must be omitted
when the host does not expose them.

### Step 3.0 — Foreground Dataverse planning snapshot and evidence

Planning stays read-only. Branch on `<dataverse_planning_mode>`:

- `connector-only` — skip every command in this section. Set `SNAPSHOT_PATH`
  and `ARCHITECT_EVIDENCE_PATH` to empty/not supplied, print
  `↷ Foreground planning snapshot skipped — the confirmed brief is connector-only.`, and
  continue to planner dispatch. Connector-only planning does not perform
  Dataverse metadata reads; the skill's existing global prerequisites remain
  unchanged.
- `required` — resolve the already selected environment again in the
  foreground and create one normalized foreground planning snapshot as below. Do not make the
  nested planner or architect rediscover the tenant.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --stage environmentResolution --action start
PLANNING_ENV_JSON=$(node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$ACTIVE_ENV_ID" --no-cache)
ACTIVE_ENV_URL=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.environmentUrl || '')" "$PLANNING_ENV_JSON")
ACTIVE_TENANT_ID=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.tenantId || '')" "$PLANNING_ENV_JSON")
test -n "$ACTIVE_ENV_URL" -a -n "$ACTIVE_TENANT_ID" || {
  echo "✗ Foreground planning snapshot requires a resolved Dataverse URL and tenant."; exit 2;
}
echo "✓ Planning environment resolved: $ACTIVE_ENV_URL (tenant $ACTIVE_TENANT_ID)"
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --stage environmentResolution --action finish
```

Build `<working_dir>/.tmp/dataverse-concepts.json` as a JSON array of typed
concepts from the approved brief. Each item has `phrase`, `kind`,
`discoverTable`, and a short `evidence` quote. Use `kind: entity` and
`discoverTable: true` only for a plausible persistent business record with an
independent lifecycle; classify people/actors as `role`, fields as `attribute`,
workflow verbs as `action`, enum values as `status`, and operating limits as
`constraint`, all with `discoverTable: false`. Preserve multiword/header-child
families such as `medical assessments`, `care activities`, `release events`,
`custody transfers`, `test results`, and `evidence attachments`. Do not turn
every noun into an entity merely to increase recall. Add known standard or
required-existing logical names to `<EXPLICIT_TABLES>`. Build
`<PROPOSED_TABLES>` from the detected publisher prefix for every clearly
proposed custom table so collisions and missing names are explicit; leave a
name out rather than inventing it when the concept is not yet stable.

If Step 2c produced a completed temporary prefetch, validate it against the
same environment URL, tenant, explicit/proposed names, and structured concept
set. When all inputs match, atomically copy it to `SNAPSHOT_PATH` and skip only
the duplicate network snapshot command; still render evidence, record timings,
and run every validator below. A missing, running, failed, or mismatched
prefetch is discarded and the normal foreground path runs unchanged.

Detailed advisory discovery is quality-bounded:

- Keep the complete customizable-table inventory and ranking.
- Required exact-name tables are always detailed and do not consume advisory
  capacity.
- A concept credibly covered by an exact table does not receive speculative
  advisory alternatives.
- Every typed entity concept receives its primary candidate and at most one
  ambiguity candidate. Roles, attributes, actions, statuses, and constraints
  never trigger table discovery.
- A lower-ranked proposed-name collision is promoted only when its display
  phrase strongly matches a multiword entity concept.
- Strong exact/suffix/contains matches and explicit/collision candidates load
  full details. Weak advisory candidates load `core` details and cannot
  authorize Reuse, Extend, or Adapt until bounded expansion upgrades them.
- Inventory-only alternatives remain available for the existing one-time
  bounded exact-name expansion.

```bash
SNAPSHOT_PATH="<working_dir>/.tmp/dataverse-foreground-planning-snapshot.json"
CONCEPTS_PATH="<working_dir>/.tmp/dataverse-concepts.json"
ARCHITECT_EVIDENCE_PATH="<working_dir>/.tmp/dataverse-architect-evidence.json"
PLANNING_TELEMETRY_PATH="<working_dir>/.tmp/dataverse-planning-telemetry.json"
INVENTORY_CACHE_PATH="<working_dir>/.tmp/dataverse-inventory-cache.json"
CACHE_TTL_MINUTES="<--dataverse-cache-ttl-minutes value, or 30>"
CACHE_TTL_MS=$(node -e '
  const minutes = Number(process.argv[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) process.exit(2);
  process.stdout.write(String(Math.round(minutes * 60 * 1000)));
' "$CACHE_TTL_MINUTES")
REFRESH_ARG=""
if printf '%s' "$ARGUMENTS" | grep -q -- '--refresh'; then
  REFRESH_ARG="--refresh"
fi

node "${CLAUDE_SKILL_DIR}/../../scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --output "$SNAPSHOT_PATH" \
  --concepts-file "$CONCEPTS_PATH" \
  --tables "<EXPLICIT_TABLES>" \
  --proposed-tables "<PROPOSED_TABLES>" \
  --progressive-detail \
  --combined-base-read \
  --read-concurrency 1 \
  --inventory-cache "$INVENTORY_CACHE_PATH" \
  --inventory-cache-ttl-ms "$CACHE_TTL_MS" \
  $REFRESH_ARG \
  --telemetry-output "$PLANNING_TELEMETRY_PATH" \
  --planning-timings-output "$PLANNING_TIMINGS_PATH"

node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --stage artifactValidation --action start
node "${CLAUDE_SKILL_DIR}/../../scripts/render-dataverse-architect-evidence.js" \
  --snapshot "$SNAPSHOT_PATH" \
  --output "$ARCHITECT_EVIDENCE_PATH"
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --stage artifactValidation --action finish

node -e '
  const s=require(process.argv[1]);
  const t=s.timings;
  const d=s.detailLoadSummary;
  console.log(`✓ Dataverse inventory: ${s.inventoryFacts.customizableTables} customizable + ${s.inventoryFacts.exactNameTables} bounded exact-name discoveries (${s.inventoryFacts.requiredExactNameTables} required, ${s.inventoryFacts.proposedCollisionTables} proposed collisions) (${t.inventoryRetrievalMs} ms)`);
  console.log(`✓ Candidate selection: ${s.candidateRanking.length} concepts → ${d.attemptedCandidates} detailed (${d.primaryCandidates || 0} primary, ${d.ambiguityCandidates || 0} ambiguity, ${d.strongCollisionCandidates || 0} strong collision, ${d.deferredCandidates || 0} deferred; ${t.candidateSelectionMs} ms)`);
  console.log(`✓ Detail loading: ${d.loadedCandidates} loaded (${d.coreCandidates || 0} core, ${d.fullCandidates || 0} full), ${d.failedCandidates} failed; ${s.tables.reduce((n,x)=>n+x.facts.columnCount,0)} columns, ${s.tables.reduce((n,x)=>n+x.facts.relationshipCount,0)} relationships, ${s.tables.reduce((n,x)=>n+x.facts.keyCount,0)} keys (${t.detailLoadingMs} ms)`);
  console.log(`✓ Exact names: requested [${s.exactNameResolution.requestedTables.join(", ")}], loaded [${s.exactNameResolution.loadedTables.join(", ")}], unavailable [${s.exactNameResolution.unavailableTables.join(", ")}]`);
  console.log(`✓ Proposed names: ${s.proposedNameChecks.collisions.length} collisions, ${s.proposedNameChecks.missing.length} missing; foreground planning snapshot total ${t.totalDurationMs} ms`);
' "$SNAPSHOT_PATH"
echo "✓ Compact architect evidence: $ARCHITECT_EVIDENCE_PATH"
echo "✓ Request telemetry: $PLANNING_TELEMETRY_PATH"
```

`--combined-base-read` loads attributes, three relationship collections, and
alternate keys through one entity-definition GET per selected table, following
any nested continuation links before normalization. Typed constraints, choices,
lookup targets, and computed metadata remain separate full-detail GETs.
`--read-concurrency 1` is the production default. Concurrency `2` through `8`
is an explicit benchmark/operator choice only; metadata writes are never sent
through this read worker pool. The inventory cache stores inventory-level facts
only, has a configurable 30-minute default TTL, fails open on corruption or
identity mismatch, and is never read by `--reconcile-exact`. `--refresh`
invalidates it before the planning read. After any metadata publish, invalidate it
with `dataverse-inventory-cache.js --file "$INVENTORY_CACHE_PATH" --invalidate`.

If environment resolution, token acquisition, inventory, required exact-name
metadata/detail loading, parsing, or evidence rendering fails, surface the
exact failure and **do not** treat an unreadable response as an empty inventory:

- For every `required` Dataverse plan, stop planning with a visible
  `BLOCKED: Dataverse planning metadata unavailable for exact target decisions`
  result. Do not dispatch a snapshot-only architect and do not proceed toward
  Dataverse mutation. The mutation workflow does not accept an unresolved
  `Unverified` plan as an executable contract.
- A concept-selected candidate is advisory unless it is also named by
  `--tables`. If advisory detail metadata is unsupported, abstract, or
  inaccessible, keep the snapshot, record it in `detailLoadFailures`, list it
  in the evidence appendix, and continue. Explicit `--tables` and bounded
  exact-name expansions remain required and fail closed.
- `--proposed-tables` performs collision checks only. Missing proposed names
  are not required-table failures and must never be selected for detail loading
  solely because they were proposed.

The snapshot script emits factual `DATAVERSE_SNAPSHOT_PROGRESS` lines after
inventory, candidate selection, and detail loading. Print them immediately;
never replace them with estimates or percentages. Once the architect starts,
watch `<working_dir>/.tmp/data-model-planning-status.json` and print each new
milestone ID once with its counts and elapsed time. The first environment or
snapshot milestone must be visible within 30 seconds. The foreground
orchestrator owns this rendering; the architect only owns the status artifact.

For `required`, pass `SNAPSHOT_PATH` and `ARCHITECT_EVIDENCE_PATH` verbatim to
the planner prompt and every direct `data-model-architect` fallback/revision.
The model reads the compact sidecar, not the full snapshot; deterministic tools
retain the full snapshot for hash binding and validation. A supplied matching
pair activates the architect's `snapshot-only` path: no Bash discovery and no
live Dataverse calls inside the agent. For `connector-only`, pass the mode
explicitly and state that both paths are not supplied; never provide placeholder
file paths.

Benchmark method and acceptance criteria:
[`references/dataverse-planning-benchmark.md`](dataverse-planning-benchmark.md).

**Hard rule — planner writes are restricted during Step 3.** The planner (and any sub-agents it spawns) is permitted to write to **only**:

- `<working_dir>/native-app-plan.md`
- `<working_dir>/_screens_section.md`
- `<working_dir>/.tmp/*`

All other paths in `<working_dir>/` (notably `app/`, `src/`, `package.json`, `power.config.json`, `tamagui.config.ts`, `tsconfig.json`, `node_modules/`, `memory-bank.md`) are owned by the foreground setup phases. Do not mutate them during planning.

If the planner needs to record a `DONE_WITH_CONCERNS` from a sub-agent (data-model architect, screen-planner), add it to an in-memory queue `DEFERRED_CONCERNS[]` during Step 3. Do not write `memory-bank.md` yet. Step 6.7 must always flush `DEFERRED_CONCERNS[]` into `memory-bank.md` `## Concerns` immediately after the file is created.

**Resume-from-draft check.** Before spawning, check if `<working_dir>/native-app-plan.md` already exists with content. If yes, a previous planner run (possibly in a degraded context with no `Task`/gate tools) already drafted sections. Read it. If it has populated `## Data Model` / `## Native Capabilities` / `## Connectors` but the gates were never run (no `## Approvals` block, or the file was authored by an agent that returned `BLOCKED: tool surface missing`), pass `resume_from_draft: true` and the existing path to the planner so it loads the draft as baseline instead of regenerating from scratch.

**Planner host capability cache.** Do not spawn a no-op probe. Read
`memory-bank.md` `## Host Capabilities` when it exists. A cached result is
usable only when its host/runtime identifier and plugin version match the
current invocation and `checkedAt` is no older than 30 minutes; unscoped,
expired, or host/plugin-mismatched entries are stale. A fresh matching
`native_app_planner: unavailable` entry loads `degraded-hosts.md`; otherwise
attempt the real planner dispatch. Record availability, host/runtime, plugin
version, and `checkedAt`. Application-level `BLOCKED:` results are not
capability failures and must not poison this cache.

**Announce the handoff before the Task call** (so the user isn't staring at a blank screen while the planner spins up):
- First run:

  ```bash
  node "${CLAUDE_SKILL_DIR}/../../scripts/planning-eta.js" \
    --project-root "<working_dir>" --estimate
  ```

- When `sampleCount > 0`, report the measured p50 and prior-run duration, for
  example `~3 min measured p50 (last run 2m40s)`. When no samples exist, say
  `ETA pending first measurement`; do not substitute a static promise.
- `required`: > "→ Spawning planner agent from the verified foreground planning snapshot. I will print each factual `data-model-planning-status.json` milestone and elapsed count as it lands. <measured ETA or first-measurement notice>"
- `connector-only`: > "→ Spawning planner agent in connector-only mode; a foreground planning snapshot and data-model mutation are not required."

Then spawn the `mobile-app:native-app-planner` agent via `Task` (the plugin name `mobile-app:` prefix is required — without it `Task` returns `Agent type not found`):

Immediately before dispatch, start `nativePlanner` timing. Close it with
`finish`, `needs-context`, or `fail` according to the literal first-line return.
Every re-dispatch after bounded expansion uses `start --retry`.

```
Spawn agent: mobile-app:native-app-planner

Prompt:
  Plan a Power Apps mobile app.

  Requirements brief (confirmed with user):
  <requirements_brief — bullet points from Step 2b>

  Design vibe opt-in: <design_vibe_opt_in — use "deferred" normally and
  "fast" when `--no-design` is in $ARGUMENTS. Never infer a direction from
  industry.>
  Visual companion: <visual_companion — "yes" or "no">

  Original prompt: <full $ARGUMENTS verbatim>
  Wizard answers: <Step 2 answers>
  Working directory: <absolute path of <working_dir>>
  Plugin root: ${CLAUDE_SKILL_DIR}/../../
  Dataverse planning mode: <required | connector-only>
  Dataverse planning failure reason: none
  Normalized Dataverse foreground planning snapshot: <absolute SNAPSHOT_PATH verbatim for required; otherwise NOT SUPPLIED>
  Compact Dataverse architect evidence: <absolute ARCHITECT_EVIDENCE_PATH verbatim for required; otherwise NOT SUPPLIED>
  Structured schema contract: <absolute
  `<working_dir>/.tmp/dataverse-schema-contract.json` for required; otherwise
  NOT SUPPLIED>
  Publisher prefix (detected from env): <DETECTED_PUBLISHER_PREFIX from Step 1.7, e.g. "cr8142a" — use literally as `<prefix>_<entity>` in all logical names. If empty/NOT DETECTED, fall back to `cr` placeholder and surface a `DONE_WITH_CONCERNS` note that Dataverse will normalize at create time.>

  Approval mode: <consolidated when --consolidated-review is present; gated otherwise>

  Follow native-app-planner.md. In gated mode, run approval Gates 1-2. In
  consolidated mode, compile those same review sections and receipts as
  pending without prompting; the orchestrator owns the single approval after
  the materialized experience preview. Then compile the
  Workflow Journey and screen build packs. The orchestrator owns Gate 3
  (experience preview) and Gate 4 (final implementation confirmation). On
  terminal return, emit one of `DONE` / `DONE_WITH_CONCERNS:` /
  `NEEDS_CONTEXT:` / `BLOCKED:` as the literal first line per AGENTS.md rule
  #10.
```

The planner runs Gates 1-2, compiles the screen contracts, and writes
`<working_dir>/native-app-plan.md`. Wait for it to return before continuing.
On a successful `required` return, require both
`.tmp/dataverse-schema-contract.json` and `.tmp/mobile-plan-status.json`
before continuing. If the receipt is missing, STOP as `BLOCKED`; this
orchestrator must not synthesize it after the planner has returned.

#### 3.0a — Degraded-host fallback

Only after the real planner spawn fails with an agent-routing/tool-surface error, read [`degraded-hosts.md`](${CLAUDE_SKILL_DIR}/references/degraded-hosts.md) and execute the inline-gate recovery. Do not load fallback instructions on the healthy path.

#### 3.0 — Sub-agent return-status switch (canonical)

Use the plugin-wide protocol in [`AGENTS.md`](${CLAUDE_SKILL_DIR}/../../AGENTS.md) rule #10 for every `Task` return in this skill: planner, parallel screen-builders, and future agent spawns. Parse the literal first line and branch: `DONE` continues; `DONE_WITH_CONCERNS:` surfaces + records in `memory-bank.md`; `NEEDS_CONTEXT:` re-dispatches with missing context, capped at 2 retries; `BLOCKED:` stops and records under `## Blocks`. Unknown first lines are malformed and must be treated as `BLOCKED`.

**Data-model exact-name expansion:** when the planner or direct architect
returns exactly
`NEEDS_CONTEXT: detailed-dataverse-metadata:<logical names>`, sort and
de-duplicate those names. This signal is valid only in `required` mode with a
validated base snapshot, whether it came from the planner or the direct
architect fallback; receiving it in `connector-only` mode is `BLOCKED`.
Perform one bounded foreground expansion. Reuse the existing snapshot
inventory, issue at most one exact-name metadata query for requested names
absent from it, and do not run another broad inventory query:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --base-snapshot "$SNAPSHOT_PATH" \
  --output "$SNAPSHOT_PATH" \
  --tables "<exact comma-separated logical names>" \
  --combined-base-read \
  --read-concurrency 1 \
  --telemetry-output "$PLANNING_TELEMETRY_PATH" \
  --planning-timings-output "$PLANNING_TIMINGS_PATH"

node "${CLAUDE_SKILL_DIR}/../../scripts/render-dataverse-architect-evidence.js" \
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
immediately, then re-dispatch the same planner or architect once with the same
snapshot/architect-evidence paths. A second detailed-metadata signal is `BLOCKED`; do not
loop, broaden concepts, or defer exact validation to mutation.

**Data-model proposed-name expansion:** when the planner or direct architect
returns exactly
`NEEDS_CONTEXT: proposed-dataverse-names:<logical names>`, sort and de-duplicate
those names. This signal is valid only in `required` mode with a validated
snapshot. Perform one collision-only foreground expansion:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/create-dataverse-snapshot.js" \
  --env-url "$ACTIVE_ENV_URL" \
  --tenant-id "$ACTIVE_TENANT_ID" \
  --base-snapshot "$SNAPSHOT_PATH" \
  --output "$SNAPSHOT_PATH" \
  --proposed-tables "<exact comma-separated logical names>" \
  --combined-base-read \
  --read-concurrency 1 \
  --telemetry-output "$PLANNING_TELEMETRY_PATH" \
  --planning-timings-output "$PLANNING_TIMINGS_PATH"

node "${CLAUDE_SKILL_DIR}/../../scripts/render-dataverse-architect-evidence.js" \
  --snapshot "$SNAPSHOT_PATH" \
  --output "$ARCHITECT_EVIDENCE_PATH"
```

This expansion checks collisions only; it does not treat absent proposed names
as required existing tables or load their details. Re-dispatch once. A second
proposed-name signal is `BLOCKED`. If a collision is found and the architect
needs compatibility facts, it may then use the separate one-time
`detailed-dataverse-metadata` expansion for that existing table.

Planner-only legacy `DESIGN_VIBE_REQUESTED:` returns are normalized to
`Design vibe opt-in: deferred`, then the planner is re-spawned once. Do not
handle or emit `INDUSTRY_CONFIRM_REQUESTED:`. Low-confidence product or visual
inference belongs in Gate 1 with its evidence and confidence.

The planner does not render or open HTML. The single interactive experience
preview is produced at Step 6.75 from the approved Product Experience,
Workflow Journey, design tokens, and screen build packs.

#### 3.9 — Post-plan publisher-prefix gate

Before continuing to Step 4, verify the written `native-app-plan.md` actually uses `$DETECTED_PUBLISHER_PREFIX` from Step 1.7. Catches both the inline-fallback path missing the prefix and an architect that ignored the instruction.

```bash
if [ -n "$DETECTED_PUBLISHER_PREFIX" ]; then
  WRONG=$(grep -oE 'cr[a-z0-9]*_[a-z][a-z0-9_]*' "$WORKING_DIR/native-app-plan.md" \
    | grep -vE "^${DETECTED_PUBLISHER_PREFIX}_" | sort -u || true)
  if [ -n "$WRONG" ]; then
    echo "PLAN PREFIX MISMATCH — expected ${DETECTED_PUBLISHER_PREFIX}_, found:"
    echo "$WRONG"
  fi
fi
```

If mismatches are reported, sweep `native-app-plan.md` (and any auxiliary files like `.datamodel-manifest.json` if already written) replacing the wrong prefix with `${DETECTED_PUBLISHER_PREFIX}_` before Step 4. Do NOT proceed to Step 5 with a wrong-prefix plan — the sweep cost grows ~500 occurrences once services are generated.

For `required`, apply the same prefix correction to
`.tmp/dataverse-schema-contract.json`, then normalize it. Before Step 4, require
both approved artifacts:

```bash
test -f "$WORKING_DIR/native-app-plan.md"
test -f "$WORKING_DIR/.tmp/dataverse-schema-contract.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/build-dataverse-operation-manifest.js" \
  --normalize-contract "$WORKING_DIR/.tmp/dataverse-schema-contract.json" \
  --output "$WORKING_DIR/.tmp/dataverse-schema-contract.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-dataverse-planning-decisions.js" \
  --contract "$WORKING_DIR/.tmp/dataverse-schema-contract.json" \
  --snapshot "$SNAPSHOT_PATH"
```

The same validation MUST run before Gate 1 is shown in the planner and inline
paths. Exit `3` is the canonical
`NEEDS_CONTEXT: detailed-dataverse-metadata:<sorted-names>` signal and consumes
the one bounded detail-expansion allowance before architect re-dispatch. Exit
`2` is `BLOCKED`. Do not approve Reuse, Extend, or Adapt from `core` or missing
detail, and do not fall back to parsing the Markdown ER diagram when a sidecar
is missing or malformed.

Record measured planning history now. Do not checkpoint the plan, approval
receipt, or build pack yet: Gate 3 may reopen Gates 1-2, and Gate 4 still
updates the approval-bound artifacts. Step 6.75 seals their first immutable
pipeline hashes after final approval.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-eta.js" \
  --project-root "<working_dir>" --record
```
