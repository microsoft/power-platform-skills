---
name: plan-inner-loop
description: >-
  Status page + dispatcher for the Power Pages Inner Dev Loop (Dataverse Git
  integration). Detects current binding state, pending changes, incoming
  updates, and conflicts; renders a visual status page; then recommends and
  optionally dispatches the next inner-loop skill. Read-only (15-30 sec).
  Use when asked: "where am I in the git loop", "what's pending", "show me my
  inner-loop state", "help me with git stuff", "check git integration",
  "what's the next git step", "review pending changes",
  "git status for my env", "have I committed everything".
user-invocable: true
argument-hint: "Optional: 'detect' to re-detect state, 'cached' to use cached state"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Plan Inner Loop

A **read-only** orchestrator that surveys Power Pages Inner Dev Loop state (Dataverse Git integration binding + pending changes + incoming updates + conflicts), renders a visual `docs/inner-loop/inner-loop-plan.html` status page, and recommends or dispatches the next skill in the loop.

## Overview

This is the **front door** to the 12-skill Inner Dev Loop family. When the user expresses any ambiguous git-integration intent ("help me with git stuff", "where am I", "what's next"), run this skill first instead of guessing which downstream skill to invoke. It detects current state, classifies it (Disconnected / Clean / Dirty / Stale / Mixed / Conflicted / Broken per `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-flow.md` §3), and either points the user at the right next skill or — with consent — dispatches it directly.

**When to invoke directly vs. this orchestrator:**

- **Run `plan-inner-loop` first when** intent is ambiguous, the user is mid-flow and asking "now what", or a long time has passed since the last skill ran.
- **Skip it when** the user explicitly named a downstream skill (e.g. *"run sync-from-git"*, *"just commit my changes"*) — those are direct invocations; honor them.

**References:**
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-flow.md` (state classification + skill dispatch table)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md`
- `${CLAUDE_PLUGIN_ROOT}/references/binding-strategy.md`

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and logged in
- A Power Pages project root (`powerpages.config.json` or `.powerpages-site/` present)

**Initial request:** $ARGUMENTS

---

## Phase 1 — Prereq + State Freshness

**Goal:** Verify tooling, optionally re-use a fresh cached plan, and confirm best-effort Managed Env / repo prerequisites.

**Do NOT create tasks yet.** Use natural-language progress reporting only during this phase.

Steps:

1. Check for cached, fresh inner-loop plan state:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/inner-loop-plan-state.js" --projectRoot "."
   ```

   The helper returns `{ exists, stale, heartbeat, generatedAt, planStatus, ... }`. If `exists === true && stale === false`, the prior status page is still warm — you MAY skip Phase 2 + Phase 3 re-detection and just re-render from the cached data. Otherwise proceed to fresh detection.

   <!-- gate: plan-inner-loop:0.stale-plan | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · plan-inner-loop:0.stale-plan):** When `stale === true` (older than the 60-min heartbeat window), present `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Cached inner-loop state is older than 60 min. How would you like to proceed? | Stale plan | Re-detect state (Recommended), Use cached state as-is, Cancel |

2. Verify PAC CLI and Azure CLI:

   ```bash
   pac env who --json
   az account get-access-token --resource <envUrl> --query expiresOn -o tsv
   ```

   If either fails, surface the failure verbatim and stop. Do NOT proceed to discovery — every downstream step needs both tools authenticated.

3. Verify Managed Environment + repo prereqs (best-effort, non-blocking):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-managed-env.js" --envUrl "<envUrl>"
   ```

   Record the result under `planData.prereqs.managedEnv`. If `managedEnv === false`, do NOT block — surface a yellow warning card on the rendered plan instead.

   > ⚠️ **Empirical caveat (HAR-confirmed 2026-06).** Microsoft Learn lists Managed Env as a hard prereq for Connect-to-Git, but **solution-level binding (`ConnectionType=0`) works on Basic envs** on multiple tenants in practice. Setup-skills should warn-not-block on this. See [`references/inner-loop-empirical-findings.md`](../../references/inner-loop-empirical-findings.md) §1.

**Output:** Tooling green; either cached plan re-used or fresh detection authorized.

---

## Phase 2 — Detect Binding State

**Goal:** Determine whether the env is bound to a Git repo and, if so, on what coordinates. Flag drift between Dataverse and the local manifest.

Tasks to create (`TaskCreate`):

1. Detect Git binding state
2. Detect pending changes
3. Render status page
4. Recommend next skill
5. Dispatch (consent)

Steps:

1. Detect binding:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-git-binding.js" --envUrl "<envUrl>"
   ```

   Output: `{ bound: bool, bindingType: 'env'|'solution'|null, organization, project, repository, branch, folder, solutionUniqueName?, branchSyncedCommitId?, upstreamBranchSyncedCommitId?, sourceControlSyncStatus?, pendingChangesCount?, cleanState?, boundSolutions?, multipleSolutionsBound?, detectedVia?, ... }`.

   - `bound === false` → state is **Disconnected**. Skip to Phase 3 with empty Changes / Updates / Conflicts arrays.
   - `bound === true` → record the binding fields into `planData.binding` and continue.

   > 🛈 **Helper fallback (HAR-confirmed 2026-06).** Many tenants do NOT expose the `gitintegrations` entity (`detect-git-binding.js` now auto-falls-back to `sourcecontrolconfigurations` + `sourcecontrolbranchconfigurations` + the `solutions.enabledforsourcecontrolintegration` / `sourcecontrolsyncstatus` columns when it gets a 404). When `detectedVia === 'sourcecontrol-entities'`, the response also includes `pendingChangesCount` and `cleanState` ('Clean' | 'Dirty' | 'Unknown') derived from `sourcecontrolcomponent` (`partitionid` + `iscommitted eq false`). **Use `cleanState` — do NOT compare `branchSyncedCommitId` to `upstreamBranchSyncedCommitId` as a Clean/Dirty signal.** Those two columns track INBOUND sync only and are equal even when hundreds of outbound pending pushes are staged (e.g., immediately after a fresh `ConnectToGit`). See [`references/inner-loop-empirical-findings.md`](../../references/inner-loop-empirical-findings.md) §3, §8, §10.

   > 🛈 **Multi-solution-bound envs (HAR-confirmed 2026-06).** When an env has 2+ Git-bound solutions (each `solutions` row with `enabledforsourcecontrolintegration eq true`), the helper now enumerates them all in `boundSolutions: [{ uniqueName, solutionId, pendingChangesCount, sourceControlSyncStatus }]` and sets `multipleSolutionsBound: true`. When called **without** `--solutionUniqueName` on such an env, the top-level `pendingChangesCount` is the **SUM across all bound solutions** (so `cleanState` is meaningful at env scope) and the top-level `gitFolder` / `branchSyncedCommitId` etc. reflect whichever solution Dataverse returned first (arbitrary — use `boundSolutions[]` for per-solution detail). When `multipleSolutionsBound === true`, surface per-solution state to the user in the Phase 5 plan render (one row per `boundSolutions[i]`), and when the user picks one to act on in Phase 6, re-invoke the helper with `--solutionUniqueName <name>` so the top-level fields reflect that solution. See [`references/inner-loop-empirical-findings.md`](../../references/inner-loop-empirical-findings.md) §13.

2. Cross-check `.git-integration-manifest.json`:

   If a manifest exists at the project root, compare its `bindingType` / `organization` / `project` / `repository` / `branch` against the Dataverse-reported binding. Drift between the two is a **Broken** state and should be flagged as a finding.

   <!-- gate: plan-inner-loop:1.broken | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · plan-inner-loop:1.broken):** When state is classified `Broken` (drift OR repeated 5xx from `detect-git-binding`), surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Inner-loop state appears Broken. How would you like to proceed? | Broken state | Run /power-pages:diagnose-git-integration (Recommended), Continue with partial data anyway, Cancel |

   - `diagnose-git-integration` → exit and recommend the user invoke that skill (do NOT auto-dispatch — Phase 6 is the dispatch gate, not Phase 2).
   - Continue → set `planData.flags.partialData = true` and proceed.
   - Cancel → exit cleanly.

**Output:** `planData.binding` populated (or `null` for Disconnected); drift/broken flags raised when applicable.

---

## Phase 3 — Detect Pending Changes, Updates, Conflicts

**Goal:** Populate the Changes / Updates / Conflicts arrays and classify the inner-loop state.

Skip this phase entirely if state is **Disconnected** (no binding to query).

Steps:

1. Refresh Updates + Conflicts from Git (eventual-consistency populator):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-changes-from-git.js" \
       --envUrl "<envUrl>" \
       --solutionUniqueName "<sol>" \
       --waitForPopulation 5
   ```

   Read-side preparation only — no commit/pull side effects. If it returns `error`, record under `planData.flags.refreshError` and CONTINUE (we still want a best-effort status page).

2. Enumerate the three lists in parallel (each is a read-only Dataverse query):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js"   --envUrl "<envUrl>" --solutionUniqueName "<sol>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-incoming-updates.js"  --envUrl "<envUrl>" --solutionUniqueName "<sol>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-conflicts.js"         --envUrl "<envUrl>" --solutionUniqueName "<sol>"
   ```

   Record each result under `planData.changes`, `planData.updates`, `planData.conflicts` (full `items[]` plus the `count`).

3. Classify the inner-loop state (per `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-flow.md`):

   - `Disconnected` → not bound to any repo
   - `Clean`        → bound, 0 Changes, 0 Updates, 0 Conflicts
   - `Dirty`        → bound, Changes > 0, 0 Updates, 0 Conflicts → next skill = `commit-to-git`
   - `Stale`        → bound, 0 Changes, Updates > 0, 0 Conflicts → next skill = `sync-from-git`
   - `Mixed`        → bound, Changes > 0 AND Updates > 0, 0 Conflicts → ambiguous; ask user (Phase 5 gate)
   - `Conflicted`   → Conflicts > 0 → next skill = `resolve-conflicts`
   - `Broken`       → drift or persistent API failures (already handled in Phase 2)

   Save the classification to `planData.state`.

**Output:** `planData` fully populated; state classified.

---

## Phase 4 — Render the Status Page

**Goal:** Persist the visual status page + the marker file that downstream skills read, then route the user.

Steps:

1. Write `planData` to `docs/inner-loop/.inner-loop-plan-data.json` (the data file the renderer consumes).

2. Render the HTML:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/plan-inner-loop/scripts/render-inner-loop-plan.js" \
       --output "docs/inner-loop/inner-loop-plan.html" \
       --data   "docs/inner-loop/.inner-loop-plan-data.json"
   ```

3. Write the marker file `docs/inner-loop/inner-loop-plan.json`. This is the artifact other inner-loop skills' Phase-0 gates query via `inner-loop-plan-state.js`. Minimum schema:

   ```json
   {
     "generatedAt": "<ISO>",
     "planStatus":  "draft|in-execution|completed",
     "state":       "<state name>",
     "siteName":    "<from powerpages.config.json>",
     "envUrl":      "<env URL>"
   }
   ```

4. Present the rendered HTML to the user — give them the absolute path so they can open it.

5. <!-- gate: plan-inner-loop:4.review | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · plan-inner-loop:4.review):** Status page rendered. Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Status page is ready. What would you like to do? | Plan review | Run the recommended skill (`{nextSkill}`) — Recommended, Pick a different inner-loop skill, Open the HTML and exit |

**Output:** `docs/inner-loop/inner-loop-plan.html` + `inner-loop-plan.json` + `.inner-loop-plan-data.json` written; user routed.

---

## Phase 5 — Recommend Next Skill

**Goal:** Map detected state → recommended next skill, with explicit branching for the ambiguous Mixed state.

Steps:

1. Map state → recommended skill (single source of truth — keep this table in sync with `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-flow.md` §3):

   | State | Recommended next skill | Alternative skills |
   |---|---|---|
   | `Disconnected` | `/power-pages:setup-git-integration` | `/power-pages:connect-solution-to-git` |
   | `Clean`        | (no action — env is in sync)         | `/power-pages:branch-switch`, `/power-pages:open-pr` |
   | `Dirty`        | `/power-pages:validate-pending-changes` then `/power-pages:commit-to-git` | `/power-pages:revert-workspace` |
   | `Stale`        | `/power-pages:sync-from-git`         | — |
   | `Mixed`        | depends on user choice (gate below)  | — |
   | `Conflicted`   | `/power-pages:resolve-conflicts`     | `/power-pages:revert-workspace`, `/power-pages:sync-from-git` (with conflict handling) |
   | `Broken`       | `/power-pages:diagnose-git-integration` | — |

2. Mixed-state branching. When `planData.state === 'Mixed'`, the maker has both local changes AND incoming updates with no conflicts. Either order works but produces different end states (pulling first means committing a merged tree; committing first means a separate ADO commit followed by a sync). Surface this explicitly:

   <!-- gate: plan-inner-loop:5.mixed-state | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · plan-inner-loop:5.mixed-state):** When `state === 'Mixed'`, surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | You have both pending Changes AND incoming Updates. What order? | Mixed state | Pull updates first then commit (Recommended — produces a single merged commit), Commit changes first then pull, Cancel — let me decide manually |

   Record the user's choice in `planData.mixedStrategy` so the rendered plan can reflect it on re-renders.

**Output:** A single recommended `{nextSkill}` (plus `mixedStrategy` when applicable).

---

## Phase 6 — Dispatch (Optional, with Consent)

**Goal:** Either invoke the recommended downstream skill directly, or exit with guidance.

Steps:

1. <!-- gate: plan-inner-loop:6.dispatch | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · plan-inner-loop:6.dispatch):** Before invoking any downstream skill, surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Ready to dispatch `{recommendedSkill}` now? | Dispatch consent | Dispatch now, Let me run it manually later, Cancel |

2. Branch on the answer:

   - **Dispatch now** → invoke the recommended skill via its `/power-pages:<name>` slash command. The downstream skill's own Phase 0 / Phase 1 will re-validate prereqs, so you can pass the discovered context (envUrl, solutionUniqueName, bindingType) via natural-language preamble.
   - **Let me run it manually** → exit with the rendered plan open; surface the recommended command in the final message.
   - **Cancel** → exit cleanly. Plan remains on disk for re-runs.

**Output:** Downstream skill dispatched (or user routed to manual run / exit).

---

## Phase 7 — Skill Usage Tracking

**Goal:** Record this skill's usage.

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "PlanInnerLoop"`.

**Output:** Skill counters incremented.

---

## Artifacts Written

| File | Location | Purpose |
|---|---|---|
| `inner-loop-plan.html` | `docs/inner-loop/` | Human-readable status page (the visual plan). |
| `inner-loop-plan.json` | `docs/inner-loop/` | Marker file consumed by validators / `check-inner-loop-plan` helpers in downstream skills. |
| `.inner-loop-plan-data.json` | `docs/inner-loop/` | Dot-prefixed data file consumed by the renderer; re-read by other inner-loop skills' `refresh-inner-loop-plan-data.js` calls. **Do not delete between phases** — Phase 0 gates of downstream skills depend on it. |

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Detect Git binding state | Detecting binding state | Resolve env/solution binding via `detect-git-binding.js`; cross-check `.git-integration-manifest.json` for drift |
| Detect pending changes | Detecting pending changes | Enumerate Changes / Updates / Conflicts via the three `list-*` helpers; classify state |
| Render status page | Rendering status page | Write `planData` + invoke `render-inner-loop-plan.js`; write the marker file |
| Recommend next skill | Recommending next skill | Map state → recommended skill; branch on Mixed-state choice |
| Dispatch (consent) | Dispatching downstream skill | Optionally invoke the recommended skill after explicit consent |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: Cached plan stale (> 60 min) → re-detect, use as-is, or cancel (gate `plan-inner-loop:0.stale-plan`).
2. **Phase 2**: Broken state (manifest drift or repeated API failures) → diagnose, continue with partial data, or cancel (gate `plan-inner-loop:1.broken`).
3. **Phase 4**: Plan review — run recommended skill, pick a different one, or exit (gate `plan-inner-loop:4.review`).
4. **Phase 5** (conditional): Mixed-state ordering — pull-then-commit, commit-then-pull, or manual (gate `plan-inner-loop:5.mixed-state`).
5. **Phase 6**: Final dispatch consent before invoking the downstream skill (gate `plan-inner-loop:6.dispatch`).

---

## Error Handling

- **`pac env who` or `az account get-access-token` fails**: hard stop; this skill has no fallback.
- **`detect-git-binding.js` returns 5xx persistently** (retried once, both fail): classify state as `Broken`; surface the Phase 2 gate so the user can route to `diagnose-git-integration`.
- **`refresh-changes-from-git.js` returns `error`**: NON-fatal. Record under `planData.flags.refreshError` and continue with Updates / Conflicts arrays possibly stale.
- **`list-*` helpers return errors**: record per-list under `planData.flags.partialData = true`; render what was gathered. The next-skill recommendation may degrade to "run `diagnose-git-integration`".
- **`render-inner-loop-plan.js` fails (non-zero exit)**: surface the renderer's stderr; offer to show the raw `planData` JSON as a fallback and continue Phase 5.

---

**Begin with Phase 1: Prereq + State Freshness**
