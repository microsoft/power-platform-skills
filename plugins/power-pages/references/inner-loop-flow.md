# Inner-Loop Flow — State Machine & Orchestration

The canonical state machine for Dataverse Git integration as understood by `plan-inner-loop` and used by every inner-loop skill for routing.

> Built from the architecture doc §4.2 + Microsoft Learn [Source control repository operations](https://learn.microsoft.com/power-platform/alm/git-integration/source-control-operations).

---

## 1. The six states

Every Power Pages dev env that has touched Connect-to-Git is in **exactly one** of these states at any moment. Skills detect state in Phase 1 and route based on it.

| State | `detect-git-binding.js` returns | Pending counts (`list-pending-changes` / `list-incoming-updates` / `list-conflicts`) | Recommended action |
|---|---|---|---|
| **Disconnected** | `null` | n/a | `git-configure` |
| **Connected & Clean** | binding object | `0 / 0 / 0`. **NB:** A freshly-bound env enters this state automatically — Connect-to-Git creates the initial commit via `SourceControlInitialSyncPlugin`, so you do NOT see Dirty after a fresh bind. See `inner-loop-empirical-findings.md` §3. | Idle; user may edit |
| **Dirty** | binding object | `>0 / 0 / 0` | `commit-to-git` (use `--dry-run` for a non-mutating pre-flight) |
| **Stale** | binding object | `0 / >0 / 0` | `sync-from-git` |
| **Mixed** | binding object | `>0 / >0 / 0` | `commit-to-git` first OR `sync-from-git` first — user's choice (gate) |
| **Conflicted** | binding object | `* / * / >0` | `resolve-conflicts` (then continue) |

Plus one error state:

| State | Detection | Recommended action |
|---|---|---|
| **Broken** | Any API call fails consistently, or binding metadata is internally inconsistent | `diagnose-git-integration` |

---

## 2. Transitions (the state diagram)

```
                ┌───────────────┐
                │  Disconnected │
                └──────┬────────┘
                       │ git-configure (env setup)
                       │ git-configure (per-solution setup)
                       ▼
   ┌────────────────────────────────────────┐
   │                                        │
   │   ┌──────────────────────────┐         │
   │   │  Connected & Clean       │         │
   │   └────┬────────┬────────┬───┘         │
   │        │        │        │             │
   │  user edit   teammate   teammate       │
   │   commits   pushes      pushes AND     │
   │   locally   to ADO      user edits     │
   │   (Dirty)   (Stale)     same component │
   │        │        │        │             │
   │        ▼        ▼        ▼             │
   │   ┌──────┐  ┌──────┐  ┌──────┐         │
   │   │Dirty │  │Stale │  │Mixed │         │
   │   └──┬───┘  └──┬───┘  └──┬───┘         │
   │      │         │         │             │
   │      │   commit-to-git OR              │
   │      │   sync-from-git (no conflicts)  │
   │      └─────────┼─────────┘             │
   │                ▼                       │
   │      ┌──────────────────┐              │
   │      │  Conflicted       │              │
   │      │  (if conflicts    │◄──── refresh detects conflicts
   │      │   detected)       │              │
   │      └────────┬─────────┘              │
   │               │ resolve-conflicts      │
   │               ▼                        │
   │       (back to Dirty / Stale            │
   │        / Mixed, then on to commit/pull) │
   │                                         │
   └─────────────────────────────────────────┘

   Any state ──→ Broken (on persistent API failure)
   Broken     ──→ diagnose-git-integration ──→ (back to detected state)
```

---

## 3. Detection signals (deterministic, no LLM guessing)

`plan-inner-loop` Phase 1 calls these helpers in order:

```
1. node scripts/lib/detect-git-binding.js --envUrl <url>
   → null  (Disconnected)
   → { bindingType, repo, branch, folder, solutionUniqueName? }

2. If not null:
   node scripts/lib/list-pending-changes.js   → { count, items[] }
   node scripts/lib/list-incoming-updates.js  → { count, items[] }
   node scripts/lib/list-conflicts.js         → { count, items[] }

3. Classify:
   - conflicts > 0                    → Conflicted
   - changes > 0 && updates > 0        → Mixed
   - changes > 0                       → Dirty
   - updates > 0                       → Stale
   - all 0                              → Connected & Clean

4. If any helper failed with persistent error → Broken
```

This classification is encoded in `inner-loop-plan-state.js` (mirrors `check-alm-plan.js`).

---

## 4. Orchestrator (`plan-inner-loop`) routing

Given a detected state, `plan-inner-loop` recommends:

| Detected state | Default recommendation | Alternative offered |
|---|---|---|
| Disconnected | `git-configure` (env binding setup) | `git-configure` (per-solution setup) |
| Connected & Clean | "You're idle. Make a change in the env to start a commit, or close." | n/a |
| Dirty | `commit-to-git --dry-run` then `commit-to-git` | Skip pre-flight if user knows pending changes are safe |
| Stale | `sync-from-git` | n/a |
| Mixed | **Gate the user**: "Commit local changes first" OR "Pull incoming first" | If conflicts surface mid-pull, `resolve-conflicts` runs anyway |
| Conflicted | `resolve-conflicts` | n/a |
| Broken | `diagnose-git-integration` | n/a |

The recommendation is rendered in the HTML status page (`docs/inner-loop/inner-loop-plan.html`) and surfaced via an `intent`-category `AskUserQuestion` gate: *"You're in `<state>`. I recommend `<skill>`. Run it now, run a different inner-loop skill, or exit?"*

---

## 5. Mixed-state gate semantics

The **Mixed** state (local Changes AND incoming Updates with NO conflicts yet) is the riskiest routing decision because:

- If the user commits first, their commit lands cleanly. Then a sync may or may not produce conflicts depending on what the incoming changes touched.
- If the user syncs first, the pull may auto-merge cleanly (different components touched), OR it may trigger Conflicts (same components touched), forcing a resolve before they can commit.

The orchestrator must **not** auto-pick. It must surface a `plan`-category gate with both options + a "Help me decide" expand:

> *"You have N local changes pending AND M incoming changes. Recommended: pull incoming first (smaller chance of conflict surprise) → resolve any conflicts → commit. Alternative: commit local first → then pull (any conflicts surface in the pull). Which?"*

---

## 6. Re-entry semantics

Every inner-loop skill is **idempotent for state classification** — running `plan-inner-loop` twice with no changes returns the same state.

But the **action** skills (commit, sync, resolve) move the state machine, so they should:

1. Detect state in Phase 1.
2. **If the state contradicts what the skill was invoked for** (e.g., user invoked `commit-to-git` but state is now `Conflicted` because a teammate just pushed), surface a `progress` gate before proceeding: *"State has changed since you invoked this skill. Now: Conflicted. Switch to `resolve-conflicts`, or continue (commit will fail)?"*
3. Re-classify after any mutating call and update the orchestrator's `docs/inner-loop/inner-loop-plan.json` via `refresh-inner-loop-plan-data.js`.

---

## 7. Heartbeat / freshness

Mirrors `check-alm-plan.js`'s heartbeat model.

- `docs/inner-loop/inner-loop-plan.json` stores `lastInvocationAt`.
- `inner-loop-plan-state.js` refreshes this on every call.
- If `lastInvocationAt` is **> 60 minutes ago**, classify the plan as `stale-heartbeat` and re-run detection rather than trusting the cached state.

---

## 8. References

- [Source control repository operations](https://learn.microsoft.com/power-platform/alm/git-integration/source-control-operations)
- Architecture doc §4.2 (this project's spec source)
- This repo: `scripts/lib/check-alm-plan.js` for the heartbeat pattern we're mirroring
- This repo: `references/inner-loop-error-catalog.md` for the Broken-state pattern map
