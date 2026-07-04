# Inner-Loop Flow — State Machine & Orchestration

The canonical state machine for Dataverse Git integration, used by `git-configure` and `git-sync` for state detection and routing.

> Built from the architecture doc §4.2 + Microsoft Learn [Source control repository operations](https://learn.microsoft.com/power-platform/alm/git-integration/source-control-operations).

---

## 1. The six states

Every Power Pages dev env that has touched Connect-to-Git is in **exactly one** of these states at any moment. Skills detect state in Phase 1 and route based on it.

| State | `detect-git-binding.js` returns | Pending counts (`list-pending-changes` / `list-incoming-updates` / `list-conflicts`) | Recommended action |
|---|---|---|---|
| **Disconnected** | `null` | n/a | `git-configure` |
| **Connected & Clean** | binding object | `0 / 0 / 0`. **NB:** A freshly-bound env enters this state automatically — Connect-to-Git creates the initial commit via `SourceControlInitialSyncPlugin`, so you do NOT see Dirty after a fresh bind. See `inner-loop-empirical-findings.md` §3. | Idle; user may edit |
| **Dirty** | binding object | `>0 / 0 / 0` | `git-sync --dry-run` (alt `git-sync --commit`) |
| **Stale** | binding object | `0 / >0 / 0` | `git-sync --pull` |
| **Mixed** | binding object | `>0 / >0 / 0` | `git-sync` (handles pull-then-commit ordering) |
| **Conflicted** | binding object | `* / * / >0` | `git-sync` (detects + gates conflicts, then continues) |

Plus one error state:

| State | Detection | Recommended action |
|---|---|---|
| **Broken** | Any API call fails consistently, or binding metadata is internally inconsistent | Surface the error verbatim; re-run `git-configure` (re-detects + reconciles the manifest on entry) or `git-sync` (re-detects state) once reviewed |

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
   │               │ git-sync conflict flow │
   │               ▼                        │
   │       (back to Dirty / Stale            │
   │        / Mixed, then git-sync continues)│
   │                                         │
   └─────────────────────────────────────────┘

   Any state ──→ Broken (on persistent API failure)
   Broken     ──→ re-run git-configure / git-sync (surface error verbatim) ──→ (back to detected state)
```

---

## 3. Detection signals (deterministic, no LLM guessing)

`git-configure` and `git-sync` call these helpers in their initial detect phase:

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

Each skill classifies state inline from the three counts above — there is no separate classification helper.

---

## 4. State → recommended flow

Both `git-configure` and `git-sync` detect state in their initial phase and route based on it:

| Detected state | Recommended flow | Alternative offered |
|---|---|---|
| Disconnected | `git-configure` (env binding setup) | `git-configure` (per-solution setup) |
| Connected & Clean | "You're idle. Make a change in the env to start a commit, or close." | n/a |
| Dirty | `git-sync --dry-run` then `git-sync --commit` | Skip pre-flight if user knows pending changes are safe |
| Stale | `git-sync --pull` | n/a |
| Mixed | **Gate the user**: "Commit local changes first" OR "Pull incoming first" | If conflicts surface mid-pull, `git-sync` runs the conflict flow anyway |
| Conflicted | `git-sync` (conflict flow) | n/a |
| Broken | Surface error verbatim; re-run `git-configure` / `git-sync` to re-detect | n/a |

`git-sync` surfaces this recommendation via an `intent`-category `AskUserQuestion` gate when the detected state contradicts the invoked flow.

---

## 5. Mixed-state gate semantics

The **Mixed** state (local Changes AND incoming Updates with NO conflicts yet) is the riskiest routing decision because:

- If the user commits first, their commit lands cleanly. Then a sync may or may not produce conflicts depending on what the incoming changes touched.
- If the user syncs first, the pull may auto-merge cleanly (different components touched), OR it may trigger Conflicts (same components touched), forcing a resolve before they can commit.

The orchestrator must **not** auto-pick. It must surface a `plan`-category gate with both options + a "Help me decide" expand:

> *"You have N local changes pending AND M incoming changes. Recommended: pull incoming first (smaller chance of conflict surprise) → resolve any conflicts → commit. Alternative: commit local first → then pull (any conflicts surface in the pull). Which?"*

---

## 6. Re-entry semantics

State classification is **idempotent** — running detection twice with no changes returns the same state.

But the mutating flows (commit, pull, conflict resolution in `git-sync`) move the state machine, so each skill should:

1. Detect state in its initial phase.
2. **If the state contradicts what the flow was invoked for** (e.g., user ran `git-sync --commit` but state is now `Conflicted` because a teammate just pushed), surface a `progress` gate before proceeding: *"State has changed since you invoked this flow. Now: Conflicted. Switch to the conflict flow, or continue (commit will fail)?"*
3. Re-detect after any mutating call so the summary reflects the settled state.

---

## 7. References

- [Source control repository operations](https://learn.microsoft.com/power-platform/alm/git-integration/source-control-operations)
- Architecture doc §4.2 (this project's spec source)
- This repo: `references/inner-loop-error-catalog.md` for the Broken-state pattern map
