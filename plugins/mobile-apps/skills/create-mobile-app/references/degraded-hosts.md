# Degraded Host Recovery

Load this file only after a real planner or screen-builder spawn fails because the host cannot route the requested agent or required gate tools are unavailable. Never use degraded mode for convenience, screen count, or timing.

#### 3.0a — Inline-gate fallback (planner unavailable OR returned `BLOCKED: tool surface missing`)

When the preflight fails OR the planner returns `BLOCKED: tool surface missing
<…>`, the orchestrator runs Gates 1-2 and the internal screen compilation
inline. Do NOT re-spawn the planner — it cannot succeed in this host. Print
**once**:

> "→ Planner agent unavailable in this host — running approval gates inline. (No action needed; this is automatic.)"

Then execute, in order, using your own `EnterPlanMode` + `AskUserQuestion`:

1. **If a draft `native-app-plan.md` exists:** read it as baseline. Surface each populated section (`## Data Model`, `## Native Capabilities`, `## Connectors`) one at a time via `EnterPlanMode`, take user feedback inline, edit the file in place. Skip generating sections that are already populated and approved.
2. **If no draft exists:** compile Product Experience and Product Scope,
   spawn `mobile-app:data-model-architect` directly via `Task`, build `##
   Native Capabilities` + `## Connectors` inline, then spawn
   `mobile-app:screen-planner` with `phase: graph` and `phase: specs`.

   **Before each `screen-planner` spawn, print a one-line ETA so the user knows the agent is live and roughly how long to wait** (the agent's own `Bash echo` progress markers — see `agents/screen-planner.md` "Progress streaming" — surface every milestone, but the orchestrator's pre-spawn line gives the wall-clock budget):
   - Before `phase: graph`: `> "→ Compiling journey graph (~2 min for ${N} screens)…"`
   - Before `phase: specs`: `> "→ Compiling experience specs and build packs (~1 min/screen, ~${N} min for ${N} screens). Progress markers will appear inline."`

  **MUST forward the Dataverse planning mode in the direct architect prompt.**
  In `required`, also forward `SNAPSHOT_PATH` and `ARCHITECT_EVIDENCE_PATH` verbatim and
  do not resolve the environment or run Dataverse discovery again. In
  `connector-only`, state that both paths are not supplied; never invent
  placeholder artifacts.

  **MUST forward `$DETECTED_PUBLISHER_PREFIX` from Step 1.7 in the architect prompt** — same line as the planner prompt at Step 3 line 1034: *"Publisher prefix (detected from env): `<DETECTED_PUBLISHER_PREFIX>` — use literally as `<prefix>_<entity>` in all logical names. If empty/NOT DETECTED, fall back to `cr` placeholder and surface a `DONE_WITH_CONCERNS` note that Dataverse will normalize at create time."* Without this, the architect defaults to `cr_` and the whole plan needs a post-hoc sweep when the real prefix is something else (e.g. `cr3e9`).

  In `required`, also require the direct architect to write and normalize
  `<working_dir>/.tmp/dataverse-schema-contract.json` per its agent contract.
  A draft Markdown section without that sidecar is not an executable Gate 1
  result.

  Wrap every direct architect dispatch with the same timing protocol using the
  `modelArchitect` stage. Wrap direct graph/spec screen-planner dispatches with
  `screenPlanner`; graph and specs are separate successful attempts, while only
  a corrective re-dispatch adds `--retry`.

   **Why this works even though the planner just returned BLOCKED for tool surface:** the orchestrator (this skill, running in the user's slash-command session) always has the full tool surface — Task, EnterPlanMode, ExitPlanMode, AskUserQuestion, Read, Write, Bash. What's missing is the surface inside *nested* agent contexts (the `native-app-planner` agent runs in a sandbox without EnterPlanMode/AskUserQuestion, which is why its Step 0 preflight returned BLOCKED). The leaf agents `data-model-architect` and `screen-planner` only need Read/Write/Bash to draft markdown — they don't need EnterPlanMode/AskUserQuestion themselves. Spawn them; the orchestrator owns the gates.

3. **Run Gates 1-2 yourself** — use `EnterPlanMode` for Product
   Experience/scope/data model, then native capabilities/connectors. Compile
   graph/specs after Gate 2 without another user gate.
4. **Write `native-app-plan.md`** with Gate 1-2 approval records and Gate 3-4
   pending. Step 6.75 owns the remaining approvals.

   **HARD RULES for the plan structure (mirror the planner agent's template at [`agents/native-app-planner.md`](${CLAUDE_SKILL_DIR}/../../agents/native-app-planner.md) Step 4):**
   - Top-level headings are EXACTLY: `## Overview`, `## App Requirements`,
     `## Product Experience`, `## Product Scope`, `## Data Model`, `## Native
     Capabilities`, `## Design`, `## Connectors`, `## Screens`, `## Approval
     Status`, `## Plan Provenance`. Do NOT invent a `## Brief` super-section.
   - `## App Requirements` is the user's confirmed brief verbatim (the `<requirements_brief>` from Step 2b), capped at ~80 lines. No expansion, no rewriting, no embedded preview of the data model.
   - Discovery failure notes (e.g. `az login` on the wrong tenant, 401 from `dataverse-request.js`, all entities classified Create) go to `<working_dir>/memory-bank.md` under `## Discovery Notes`, NOT into the plan. Keep at most a single one-line breadcrumb in `## Data Model` like `> Discovery skipped — see memory-bank.md.` if relevant.
   - Sample data notes, immutability plug-in notes, file-column setup notes, dispatch-block server rules go under a single `### Notes` subsection in `## Data Model`. Cap each at 2 sentences; link to `post-deployment-tasks.md` for longer write-ups instead of inlining.

5. **Record the same structured approval receipt as the planner path.** At
   Gate 1 acceptance, initialize
   `<working_dir>/.tmp/mobile-plan-status.json` with the exact normalized
   contract content/hash. After Gate 2, update only that gate's approval
   record. After the specs pass, record `screenPlan: compiled`, the build-pack
   hash, structured service dependencies, and integrity hash. Follow
   `agents/native-app-planner.md` Step 6 exactly. Never call the operation
   manifest builder to create or restamp this receipt. A changed approved
   section invalidates its record until the existing inline gate approves it
   again.

If the orchestrator's OWN `Task` tool is unavailable (rare — would mean even leaf agents can't be spawned), fall further to fully-inline mode. In `required`, draft the data model from `ARCHITECT_EVIDENCE_PATH` with no live OData probe and write/normalize the same structured schema contract required by `agents/data-model-architect.md`; use `SNAPSHOT_PATH` only through deterministic validation. In `connector-only`, write an explicit zero-table/no-Dataverse `## Data Model` section and no contract. Then draft native caps + connectors heuristically, compile the screen graph +
specs against the Product Experience and
`shared/references/screen-templates.md`, and run Gates 1-2 against the user.
This is the last-resort path.

**Hard rule:** never silently skip Gates 1-2 because the planner could not run.
Gate 3 and Gate 4 still run at Step 6.75 before any mutation step executes.


## Screen-builder fallback

Enter this path only after the first real screen-builder dispatch fails with an
agent-routing or tool-surface error.

- Print **once**:
  > "→ Parallel screen-builders unavailable in this host — building screens inline. (No action needed; this is automatic.)"
- Record `screen_builder: unavailable` under `## Host Capabilities` with the
  current host/runtime identifier, plugin version, and `checkedAt`; it expires
  after 30 minutes and must not permanently disable builders.
- Iterate the assigned files inline using the complete `screen-builder.md`
  workflow, compiled build-pack entry, screen spec, selected archetype shard,
  code idioms, and the same validators.
- Inline mode is not a reduced-quality or scale shortcut. Do not ask about
  build mode and do not skip the wave TypeScript/route/style gates.
- If the host changes mid-run, downgrade only after the real dispatch fails.
- Screen builders never spawn nested agents. Missing context returns through
  the standard status protocol and the top-level orchestrator resolves it.
