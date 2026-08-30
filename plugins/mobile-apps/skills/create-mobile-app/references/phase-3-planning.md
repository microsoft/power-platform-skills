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
<short-safe-classification>`; on an envelope `needs_context` use `--action needs-context
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
never replace them with estimates or percentages. The first environment or
snapshot milestone must be visible within 30 seconds. Children do not write or
own progress artifacts.

For `required`, the foreground reads the validated compact architect evidence
and only the relevant verified snapshot facts, then embeds that content in the
sealed `data-model-architect` work order. Do not give the child a path and ask it
to read. Deterministic foreground tools retain the full snapshot for hash
binding, bounded expansion, and decision validation. For `connector-only`, pass
the mode explicitly and omit Dataverse evidence rather than inventing
placeholder content.

Benchmark method and acceptance criteria:
[`references/dataverse-planning-benchmark.md`](dataverse-planning-benchmark.md).

**Hard rule — foreground-only persistence during Step 3.** Read
[`return-only-agents.md`](return-only-agents.md) now. Every child receives
complete inline context and returns content; only the foreground may write
`native-app-plan.md`, `_dm_section.md`, `_screens_section.md`, `.tmp/*`, or any
other project path. Children never mutate `app/`, `src/`, package/config files,
brand files, generated files, or `memory-bank.md`.

Collect `ready_with_concerns` strings in foreground-owned
`DEFERRED_CONCERNS[]`. Step 6.7 flushes them into `memory-bank.md` `## Concerns`
after that file exists.

**Resume-from-draft check.** Before dispatch, inspect the foreground-owned
interaction and pipeline state. If a sealed work order and validated response
already exist for the current input fingerprint, resume after that artifact.
If an older `native-app-plan.md` exists without matching return-only state, read
its content into the new work order as prior-draft context; do not tell a child
to read the path and do not restart already-approved interactions.

**Agent execution mode cache.** Do not spawn a no-op probe and do not use
`memory-bank.md` for host capability state. Resolve the cached
`parallel-return` or `foreground-return` mode with
`scripts/agent-return-runtime.js` exactly as documented in
[`return-only-agents.md`](return-only-agents.md). The binding includes host,
runtime/session, and plugin version and expires after 30 minutes. On a miss,
attempt the first real return-only dispatch. Only custom-agent routing failure
selects `foreground-return`; an application `blocked`, malformed envelope, or
validator finding does not change the mode.

**Announce the handoff before the planner work order** so the user is not
waiting without context:
- First run:

  ```bash
  node "${CLAUDE_SKILL_DIR}/../../scripts/planning-eta.js" \
    --project-root "<working_dir>" --estimate
  ```

- When `sampleCount > 0`, report the measured p50 and prior-run duration, for
  example `~3 min measured p50 (last run 2m40s)`. When no samples exist, say
  `ETA pending first measurement`; do not substitute a static promise.
- `required`: > "→ Dispatching the return-only planner from verified foreground context. <measured ETA or first-measurement notice>"
- `connector-only`: > "→ Dispatching the return-only planner in connector-only mode; no Dataverse evidence or mutation is required."

#### 3.1 — Native planner work order

The foreground writes and seals one `native-app-planner` work order. Its inline
context contains the confirmed requirements, original prompt, wizard answers,
platforms, approval mode, Dataverse planning mode, detected publisher prefix,
design mode, visual-companion choice, resolved native-capability decisions,
resolved connector/system-of-record decisions, the complete persistence
boundary, and native allowlist facts,
exact contents of `schema-product-experience-contract.json` and
`schema-product-scope-contract.json`, their applicable semantic-rule
requirements, and prior-draft content when resuming. Do not include a path in
place of any required content.

Request exactly these artifacts:

| Artifact ID | Allowlisted target |
|---|---|
| `plan:native-app-draft` | `<working_dir>/.tmp/native-app-plan.draft.md` |
| `contract:product-experience` | `<working_dir>/.tmp/product-experience-contract.json` |
| `contract:product-scope` | `<working_dir>/.tmp/product-scope-contract.json` |

The draft contains `<!-- RETURN_ONLY_DATA_MODEL_SECTION -->` and
`<!-- RETURN_ONLY_SCREENS_SECTION -->` exactly once. It contains every other
existing plan section and Gate 1–2 review content, but no approved claim.

Seal the complete work order with `agent-return-envelope.js`, start the
`nativePlanner` timing stage, record `planning:native` with dispatch reason
`initial` through `agent-return-runtime.js`, and dispatch the complete sealed
JSON inline. In
`parallel-return`, invoke `mobile-app:native-app-planner`; in
`foreground-return`, perform that same role from the same work order and emit
the same envelope. Capture the exact response text. The healthy path dispatches
this role once. Only one genuine clarification or targeted validator repair may
cause a bounded follow-up; ordinary approvals never redispatch the planner.

The dispatch ledger rejects a second `initial` call and has no `approval`
reason. Gate feedback routes to the owning Product Experience, Product Scope,
Data Model, or foreground approval-persistence step. A genuine child
clarification uses `needs_clarification`; malformed transport uses the same
fingerprint with `transport_retry`; exact validator findings use
`targeted_repair`. Do not redispatch the planner merely to reword gate text or
write approval-receipt content.

Validate the envelope and run the Product Experience and Product Scope
validators through a foreground validation plan before materialization. The
plan first runs `bind-return-only-contracts.js` against the staged Experience
and Scope files, replacing only Scope's 64-zero `experienceRevision`, then runs
both semantic validators. On
`ready_with_concerns`, queue concerns. On `needs_clarification`, persist
`waiting_for_user`, ask through `askUser`, attach the answer, reseal, and resume.
Malformed or truncated transport retries the byte-identical work order once.
Substantive `blocked` stops. Tool-surface absence is a dispatch-mode concern,
never a product block.

Before Data Model architecture, require the validated planner draft to contain
complete `## Native Capabilities` and `## Connectors` sections consistent with
the work order's resolved architecture facts. Read those exact heading-bounded
sections into the architect work order; do not summarize them from memory. The
foreground also passes the original structured native-capability decisions,
connector/system-of-record decisions, and persistence boundary so the architect
can validate cross-section consistency. This changes reasoning and handoff
order only: final plan heading order and existing Gate 1–2/consolidated approval
content remain unchanged, and no additional user prompt is introduced.

#### 3.2 — Data Model work order

After Product Experience and Product Scope validate, build one
`data-model-architect` work order. Its inline context contains the confirmed
brief, complete approved/pending Product Scope content, planning mode, detected
publisher prefix, exact resolved `## Native Capabilities` and `## Connectors`
draft sections, structured native-capability decisions, structured
connector/system-of-record decisions, the complete persistence boundary,
compact architect evidence content, relevant verified snapshot facts,
screen-operation facts when this is a targeted cross-entity audit, exact
normalized Dataverse contract shape and semantic validation requirements, prior
section content for incremental repair, and output descriptors.

Request `_dm_section.md` as `section:data-model`. In `required`, also request
`.tmp/dataverse-schema-contract.json` as `contract:dataverse-schema`. In
`connector-only`, request no schema contract.

Dispatch `mobile-app:data-model-architect` in return mode, or perform the same
work order in `foreground-return`. For `needs_context`, accept only the existing
bounded signals in `concerns`:

- `detailed-dataverse-metadata:<sorted logical names>`;
- `proposed-dataverse-names:<sorted logical names>`;
- `matching-dataverse-snapshot-and-evidence`;
- `product-scope-approval-required:<N>-new-tables`.
- `resolved-architecture-inputs:<comma-separated native-capabilities,connectors,persistence-boundary>`.

The foreground performs exact-name expansion below, refreshes inline evidence,
or supplies only a missing validated architecture input, reseals only this work
order, and redispatches once. Before materialization in
`required`, the validation plan normalizes the staged schema contract and runs
`validate-dataverse-planning-decisions.js` against the full foreground snapshot.
Exit `3` becomes the existing exact detail request; exit `2` is substantive
`blocked`. Never approve Reuse, Extend, or Adapt from core/missing detail.

#### 3.3 — Canonical response handling

Use `scripts/agent-return-envelope.js` for every converted-child response. Do
not parse first lines or extract JSON from prose. `ready` continues after staged
validation and atomic materialization. `ready_with_concerns` does the same and
queues its actionable concerns. `needs_context` updates only the owning work
order and is capped as documented below. `needs_clarification` persists the
foreground interaction, asks once, and resumes the same phase. Substantive
`blocked` stops. Invalid/truncated transport retries the byte-identical work
order once; role-validator repair includes exact findings and never regenerates
unaffected artifacts.

If custom-agent routing fails, select `foreground-return` through the cached
mode contract and process the same work order sequentially. Do not first attempt
write-capable children and do not load a second inline planning workflow.

**Data-model exact-name expansion:** when a validated `data-model-architect`
envelope has status `needs_context` and one concern is exactly
`detailed-dataverse-metadata:<logical names>`, sort and de-duplicate those
names. This signal is valid only in `required` mode with a validated base
snapshot; receiving it in `connector-only` mode is substantive `blocked`.
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
immediately. Read the refreshed compact evidence and relevant facts into the
same architect work order, increment its attempt, reseal it, and redispatch once.
A second detailed-metadata signal is substantive `blocked`; do not loop,
broaden concepts, or defer exact validation to mutation.

**Data-model proposed-name expansion:** when a validated architect envelope has
status `needs_context` and one concern is exactly
`proposed-dataverse-names:<logical names>`, sort and de-duplicate those names.
This signal is valid only in `required` mode with a validated snapshot. Perform
one collision-only foreground expansion:

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
as required existing tables or load their details. Refresh inline evidence,
reseal the same architect work order, and redispatch once. A second
proposed-name signal is substantive `blocked`. If a collision is found and the
architect needs compatibility facts, it may then use the separate one-time
`detailed-dataverse-metadata` expansion for that existing table.

#### 3.4 — Foreground Gates 1–2

After the Data Model is validated and materialized, the foreground renders
Gate 1 from Product Experience, Product Scope, and Data Model content. It
renders Gate 2 from the planner's architecture, native-capability, connector,
and dependency content. Use `approveSection` from the shared interaction
adapter. Structured Plan Mode/question tools are used when available; Copilot
CLI and VS Code use normal foreground conversation. Before yielding, persist
`waiting_for_user`, then resume the same phase and revision with the answer.

Gated mode preserves both prompts and records their approval revisions.
Consolidated mode records both as `pending-consolidated-review`; Step 6.75 still
presents the existing consolidated review. The foreground, never a child,
creates and updates `.tmp/mobile-plan-status.json` from exact validated content.

#### 3.5 — Screen graph and specs work orders

After Gate 2 approval or consolidated pending compilation, create the existing
two separate `screen-planner` work orders.

The `graph` work order includes inline validated Product Experience, Product
Scope, Data Model summary, capabilities, connectors, workflow constraints,
navigation rules, platforms, exact Workflow Journey JSON schema and semantic
requirements, and output descriptors. Request complete
`_screens_section.md` graph content as `section:screens` and
`.tmp/workflow-journey-contract.json` as `contract:workflow-journey`. Validate
the staged journey by first binding its zero revision placeholders with
`bind-return-only-contracts.js --scope-input <approved-scope> --journey
<staged-journey>`, then checking it against the exact Product Scope and Product
Experience contracts before materialization. The binder must not rewrite either
approved upstream contract.

The `specs` work order includes inline validated graph content, design and
foundation contracts available at this phase, exact data/service signatures,
fixtures, states, selected archetype shards, code idioms, and output
descriptors, plus the exact screen build-pack JSON schema and semantic
requirements. Request complete `_screens_section.md` as `section:screens` and
`.tmp/screen-build-pack.json` as `contract:screen-build-pack`. Validate the
staged build pack by first binding its zero revision placeholders with
`--scope-input <approved-scope> --journey-input <approved-journey> --build-pack
<staged-pack>`, then running the existing compiler against the exact journey,
scope, and experience contracts. The binder must not rewrite approved upstream
contracts. Materialize only after that check, then run
`compile-screen-build-pack.js` normally to produce and check
`.tmp/compiled-screen-build-pack.json`.

In `parallel-return`, invoke `mobile-app:screen-planner` once for `graph` and
once for `specs`; these phases remain ordered, not concurrent. In
`foreground-return`, process those same sealed work orders sequentially. Missing
hierarchy, focal point, signature interaction, media prominence, states, or
`forbiddenDefaults` triggers targeted repair; the foreground never fills those
semantic decisions with generic defaults.

#### 3.6 — Final plan and approval receipt

Compose the existing final plan shape deterministically:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/compose-return-only-plan.js" \
  --project-root "<working_dir>" \
  --draft ".tmp/native-app-plan.draft.md" \
  --data-model "_dm_section.md" \
  --screens "_screens_section.md" \
  --output "native-app-plan.md"
```

The foreground writes `.tmp/mobile-plan-status.json` only after the relevant
approval state exists. Preserve its current shape and bind the final plan hash,
Product Experience and Product Scope revisions, exact normalized Data Model
contract/hash when required, Gate 1 and Gate 2 records, screen-plan status,
compiled build-pack hash, structured service dependencies, and integrity hash.
A changed approved semantic section invalidates only its approval record and
downstream hashes until the owning review approves it again.

Record `executionMode`, dispatch/retry counts, zero child tool calls,
foreground validation time, and foreground materialization time through
`planning-timings.js --record-agent-execution`.

The planner does not render or open HTML. The single interactive experience
preview is produced at Step 6.75 from the approved Product Experience,
Workflow Journey, design tokens, and screen build packs.

#### 3.9 — Post-plan publisher-prefix gate

Before continuing to Step 4, verify the foreground-composed
`native-app-plan.md` actually uses `$DETECTED_PUBLISHER_PREFIX` from Step 1.7.
This catches an owning role that ignored the supplied identity.

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

If mismatches are reported, do not search-and-replace approved semantics in the
foreground. Send one targeted repair to the owning Data Model work order with
the exact mismatch findings, reseal it, validate the returned section/contract,
and recompose the plan. Repair the planner draft only if a non-Data-Model
section independently contains the wrong prefix. Do not regenerate unrelated
sections or screens, and do not continue while identities disagree.

For `required`, normalize and validate the repaired staged schema contract
before materialization. Before Step 4, require all approval-bound artifacts:

```bash
test -f "$WORKING_DIR/native-app-plan.md"
test -f "$WORKING_DIR/.tmp/dataverse-schema-contract.json"
test -f "$WORKING_DIR/.tmp/mobile-plan-status.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/build-dataverse-operation-manifest.js" \
  --normalize-contract "$WORKING_DIR/.tmp/dataverse-schema-contract.json" \
  --output "$WORKING_DIR/.tmp/dataverse-schema-contract.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-dataverse-planning-decisions.js" \
  --contract "$WORKING_DIR/.tmp/dataverse-schema-contract.json" \
  --snapshot "$SNAPSHOT_PATH"
```

The same validation MUST run in the foreground before Gate 1. Exit `3` becomes
the validated architect-envelope concern
`detailed-dataverse-metadata:<sorted-names>` and consumes the one bounded
detail-expansion allowance before architect redispatch. Exit `2` is substantive
`blocked`. Do not approve Reuse, Extend, or Adapt from `core` or missing detail,
and do not fall back to parsing the Markdown ER diagram when a sidecar is
missing or malformed.

Record measured planning history now. Do not checkpoint the plan, approval
receipt, or build pack yet: Gate 3 may reopen Gates 1-2, and Gate 4 still
updates the approval-bound artifacts. Step 6.75 seals their first immutable
pipeline hashes after final approval.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-eta.js" \
  --project-root "<working_dir>" --record
```
