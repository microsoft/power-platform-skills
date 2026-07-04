---
name: git-sync
description: >-
  The per-cycle Power Pages inner-loop skill. Detects Dataverse Git state
  (Changes / Updates / Conflicts), renders one readable summary that splits real
  config from compiled-bundle churn, previews incoming updates, and explains
  conflicts semantically; then dispatches by state to the matching flow —
  commit (CommitToGit), pull (PullChangesFromGit), or resolve-conflicts — with a
  human confirm. Replaces commit-to-git, sync-from-git, and resolve-conflicts.
  Use when asked: "commit", "push to ADO", "pull from git", "sync", "get latest",
  "resolve conflicts", "save my changes", "what changed", "am I behind".
user-invocable: true
argument-hint: "Optional: --commit | --pull to force direction; --dry-run / --dry-run --json / --background (commit); --hard-delete (pull)"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Git Sync

`git-sync` is the unified per-cycle inner-loop skill. It merges the three legacy flows — without dropping any protection:

- `commit-to-git` → **commit** flow (Changes → `CommitToGit`). Full detail: `references/changes-reference.md`.
- `sync-from-git` → **pull** flow (Updates → `RefreshChangesFromGit` + `PullChangesFromGit`). Full detail: `references/update-reference.md`.
- `resolve-conflicts` → **conflict** flow (Conflicts → resolve). Full detail: `references/conflict-reference.md` (incl. native VS Code clone-based **selective merge**: `references/selective-merge-reference.md`).

**Initial request:** $ARGUMENTS

**User-facing voice:** speak plainly. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-user-language.md` for the authoring rules — no raw API names, raw JSON, or GUIDs in user chat (except on failure); show progress as sequential `Phase {N} — {plainTitle}` (internal phase numbers stay internal).

This SKILL.md is a **state dispatcher**: it detects the current state once, renders one readable summary, and then **reads and follows the matching reference doc** for the active flow. The deep, deterministic step lists live in the three `references/*.md` files (the same pattern `add-sample-data` uses with `references/odata-record-patterns.md`).

**Shared references, do not duplicate:** `${CLAUDE_PLUGIN_ROOT}/references/git-integration-api-patterns.md`, `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md`, `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-flow.md`, `${CLAUDE_PLUGIN_ROOT}/references/conflict-resolution-patterns.md`, `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`.

## Global invariants

1. **No hidden Dataverse mutations.** Every flow gates plan + consent before `CommitToGit` / `PullChangesFromGit` / conflict apply.
2. **Conflicts gate everything.** When Conflicts > 0, the conflict flow runs FIRST; commit/pull cannot proceed until conflicts clear.
3. **Use deterministic helpers.** Never inline Dataverse/ADO REST calls when a helper exists.
4. **Reuse markers, don't migrate.** `last-commit.json` (commit), `last-sync.json` (pull), `last-conflict-resolution.json` (conflict), `last-validation.json` (`--dry-run`).
5. **Modes are preserved exactly:** `--dry-run`, `--dry-run --json`, `--background` (commit side); `--hard-delete` (pull side).

## Modes / flags

| Flag | Effect |
|---|---|
| (none) | Auto-detect direction from state. |
| `--commit` | Force the commit flow (when Changes exist). |
| `--pull` | Force the pull flow (when Updates exist). |
| `--dry-run` | Commit pre-flight only (14 validators); writes `last-validation.json`; no mutation. |
| `--dry-run --json` | Same, machine-readable to stdout (CI). |
| `--background` | Commit fire-and-forget poller (writes `pending-commit-ticket.json`). |
| `--hard-delete` | Pull with `DeleteDeletedComponents` (destructive; gated). |

Conflicts always gate first regardless of `--commit` / `--pull`.

---

## Phase 0 — Detect Direction

**Goal:** Determine the flow before any prompts.

Steps:

1. Report progress: "Detecting Git sync state."
2. **Resolve `envUrl` once and reuse it.** Run `pac env who` and read the `Environment URL:` line — that value is `<envUrl>`. Pass it explicitly as `--envUrl "<envUrl>"` to **every** helper below. (Helpers can self-derive it by re-running `pac env who`, but that is slower and can fail to parse — always pass it.)
3. Run `detect-git-binding.js --envUrl "<envUrl>"`. The bound solution's unique name is `boundSolutions[0].uniqueName` — that value is `<solutionUniqueName>`. You need it for the count helpers below.
4. List the three counts. **All three require BOTH `--envUrl` AND `--solutionUniqueName`** — without `--solutionUniqueName` the conflict/update helpers fall back to a 404'd entity and silently return `count: 0`, which would wrongly route the flow to `clean`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js"   --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-incoming-updates.js"  --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-conflicts.js"         --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>"
   ```

   Read each helper's `count` field for Changes, Updates, and Conflicts respectively.
5. Compute the direction. `detect-sync-direction.js` is callable as a function (`detectSyncDirection({ counts, args })`) **or** via its CLI with the three counts:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-sync-direction.js" --changes <N> --updates <N> --conflicts <N>
   ```

   Trust its shape: `{ mode, ordering, requiresConflictFirst, state, reason, explicitOverride }` where `mode ∈ {commit, pull, both, conflicts-first, clean}`. (Add `--commit` / `--pull` to force an explicit direction.)
6. Announce the state and mode. If `mode = clean`, report "You're up to date" (offer to open a PR inline) and exit.

**Output:** `envUrl`, `solutionUniqueName`, `mode`, `ordering`, and `requiresConflictFirst` are known.

---

## Phase 1 — Prereq + Binding + Manifest Reconcile

**Goal:** Verify auth, the binding, and that the local manifest matches server truth.

Steps:

1. Verify PAC, Git, and Azure CLI authentication (plain `az login` guidance if missing). Git must be installed for the clone-based selective-merge resolver.
2. Confirm the active environment with `pac env who`; if the friendly environment name is needed for selective merge cache paths, use `pac env list` to match it. Run `detect-git-binding.js`; if unbound, route to `git-configure`.

<!-- gate: git-sync:1.no-binding | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-sync:1.no-binding):** Fires when the env is not bound to Git. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | This environment is not bound to Git, so there is nothing to sync. Set up a binding first? | No binding | Run /power-pages:git-configure, Cancel |
>
> Cancellation leaves nothing.

3. Reconcile the local `.git-integration-manifest.json` against server truth with `reconcile-manifest.js` (see `${CLAUDE_PLUGIN_ROOT}/references/manifest-contract.md`).

<!-- gate: git-sync:1.manifest-stale | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-sync:1.manifest-stale):** Fires when `reconcileManifest` returns `aligned:false`. Surface `AskUserQuestion` using the helper's `options` as choices:
>
> | Question | Header | Options |
> |---|---|---|
> | Local manifest and server binding disagree: `{summary}` (`{divergedFields}`). How should I reconcile? | Stale manifest | Overwrite manifest from server truth, Re-bind using the manifest's old coordinates, Clear local manifest and start fresh, Cancel |
>
> Only offer the options the helper returned. Cancellation leaves the manifest untouched.

**Output:** Auth, binding, and manifest are confirmed.

---

## Phase 2 — Ground Truth + Readable Summary

**Goal:** Show ONE readable picture of all three buckets before any action.

Steps:

1. Run `refresh-changes-from-git.js` (RefreshChangesFromGit — read-only; populates Updates + Conflicts without mutating). This is also the lightweight "status" answer. **Both `--envUrl` and `--solutionUniqueName` are required** — the action errors without the solution unique name in its body:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-changes-from-git.js" --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>"
   ```
2. Re-list the three counts (again with `--envUrl` AND `--solutionUniqueName`, as in Phase 0). For **Changes**, run `classify-change-set.js` to split real config from compiled-bundle churn.
3. Render the unified summary (≤ ~12 lines):
   - **Changes:** `{configCount}` config changes (list config items by name) **+ `{churnCount}` build-output files** (bundle churn — collapsed; expand on request). Never hide config.
   - **Updates:** preview incoming (e.g. "teammate added a Contact form, modified the nav web template").
   - **Conflicts:** semantic explanation per component (handled in the conflict flow).

**Output:** The user has seen the complete, de-noised picture.

---

## Phase 3 — Dispatch by State

**Goal:** Run the right flow(s) by reading and following the matching reference doc.

**Conflicts gate first.** When `requiresConflictFirst` is true:

<!-- gate: git-sync:2.conflicts | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-sync:2.conflicts):** Fires when Conflicts > 0. Conflicts block both commit and pull. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | `{count}` component(s) conflict (edited on both sides). They must be resolved before commit/pull. Resolve now? | Conflicts detected | Resolve conflicts now, Cancel |
>
> On "Resolve conflicts now", **read and follow `references/conflict-reference.md`** to completion. After resolution, re-run Phase 0 detection — resolved items re-route into Changes/Updates. Cancellation leaves nothing.

Then dispatch on `mode`:

- **`commit`** → read and follow `references/changes-reference.md`.
- **`pull`** → read and follow `references/update-reference.md`.
- **`both`** (Mixed) → fire the ordering gate, then run both flows in the chosen order.

<!-- gate: git-sync:3.mixed-order | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-sync:3.mixed-order):** Fires for Mixed state (Changes AND Updates). Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | You have `{changes}` local change(s) AND `{updates}` incoming update(s). Recommended: pull incoming first (surfaces any conflict before you push), then commit. | Sync order | Pull then commit (recommended), Commit then pull, Cancel |
>
> Default is pull-then-commit (`detectSyncDirection.ordering`). For pull-then-commit: follow `references/update-reference.md`, re-detect (a pull can surface new conflicts → loop to the conflicts gate), then follow `references/changes-reference.md`. For commit-then-pull: the reverse. Cancellation leaves nothing.

**Output:** The requested flow(s) executed, or partial failure clearly reported by the flow doc.

---

## Phase 4 — Final Gate + Follow-Ups

**Goal:** Offer the natural next step and record usage.

Steps:

1. After a successful commit, offer to open a PR — and open it **inline** (this skill owns the PR step; it does not dispatch a separate skill).

<!-- gate: git-sync:final.open-pr | category=final | cancel-leaves=nothing -->
> 🚦 **Gate (final · git-sync:final.open-pr):** Commit path only. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Commit `{shortSha}` landed on `{branch}`. Open a pull request now? | Open PR | Open PR (inline), Not now |

   On **Open PR (inline)**, create the PR without leaving this skill, reusing the shared ADO helpers:

   1. Resolve the target branch (default `main`; confirm with the user if they want a different target). Fetch the repo GUID + default branch:

      ```bash
      node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-get-default-branch.js" --organization "<organization>" --project "<project>" --repository "<repository>"
      ```

   2. Render a maker-friendly PR description from the commits ahead of the target:

      ```bash
      node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-list-commits.js" --organization "<organization>" --project "<project>" --repository "<repository>" --branch "<branch>" --top 20 --token "<adoToken>"
      node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-render-pr-description.js" --stdin
      ```

   3. Create the PR from the bound `<branch>` to the target:

      ```bash
      node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-create-pr.js" --organization "<organization>" --project "<project>" --repository "<repository>" --source "<branch>" --target "<target>" --title "<title>" --description-file "<renderedDescriptionPath>"
      ```

   Error handling: `ado-create-pr.js` 400 "active pull request already exists" → surface the existing PR URL as success (idempotent); 403 → ADO PAT lacks `Pull request contributor` / `Code (write)` scope, surface the remediation from `${CLAUDE_PLUGIN_ROOT}/references/git-integration-prerequisites.md`; 5xx → retry once, then surface verbatim. ADO tokens are minted in-process and never written to disk or the command line.

2. Optionally offer a tag.

<!-- gate: git-sync:final.tag-offer | category=final | cancel-leaves=nothing -->
> 🚦 **Gate (final · git-sync:final.tag-offer):** Commit path only. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Tag commit `{shortSha}`? | Tag commit | Create tag, Skip |

3. Final routing.

<!-- gate: git-sync:final | category=final | cancel-leaves=nothing -->
> 🚦 **Gate (final · git-sync:final):** Surface next-action options based on what ran:
>
> | Question | Header | Options |
> |---|---|---|
> | Sync complete (`{summary}`). What next? | Next step | Open PR (inline), Run /power-pages:git-sync again, Done |

4. Record skill usage via `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md` with skill name `GitSync`.

**Output:** Cycle complete; manifests + markers + trace written by the flow docs.

---

## Artifacts Written

| Artifact | Key | Written by | Purpose |
|---|---|---|---|
| `last-commit.json` | `lastCommit` | commit flow | Commit marker (validator + routing). |
| `last-sync.json` | `lastSync` | pull flow | Pull marker. |
| `last-conflict-resolution.json` | `lastConflictResolution` | conflict flow | Resolution marker. |
| `last-validation.json` | `lastValidation` | `--dry-run` | Read-only pre-flight report (CI / plan-alm). |
| `pending-commit-ticket.json` | `pendingCommitTicket` | `--background` | Background poller ticket. |

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Detect direction | Detecting direction | `detectSyncDirection` from counts + args. |
| Check binding | Checking binding | Auth, binding, manifest reconcile. |
| Summarise state | Summarising state | Refresh + config-vs-churn split + incoming preview + conflict explanation. |
| Dispatch flow | Dispatching flow | Follow changes/update/conflict reference doc per state. |
| Finalise | Finalising | Final gate, inline PR offer, skill tracking. |

## Key Decision Points (Wait for User)

1. Phase 1: no binding (`git-sync:1.no-binding`); stale manifest (`git-sync:1.manifest-stale`).
2. Phase 3: conflicts gate (`git-sync:2.conflicts`); Mixed ordering (`git-sync:3.mixed-order`).
3. Per-flow gates live in the reference docs: `changes.*` (`references/changes-reference.md`), `update.*` (`references/update-reference.md`), `2.conflict-*` (`references/conflict-reference.md`), and `clone-merge.*` (`references/selective-merge-reference.md`).
4. Phase 4: inline PR offer (`git-sync:final.open-pr`), tag (`git-sync:final.tag-offer`), final routing (`git-sync:final`).

**Begin with Phase 0: Detect Direction.**
