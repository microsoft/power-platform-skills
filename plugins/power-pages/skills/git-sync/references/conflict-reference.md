# Conflict Reference — Resolution Flow

Follow this FIRST when the `git-sync` dispatcher detects **Conflicted** state (`Conflicts > 0`); conflicts gate both commit and pull.

The dispatcher owns the top-level routing gate. This reference starts after the user chooses to resolve conflicts and defines only the two conflict-flow gates listed below.

## Operating rules

- A conflict is one Dataverse component edited in both the environment and the bound Azure DevOps branch since the last sync.
- Conflicted components are mutually exclusive with Changes and Updates while they remain conflicted. Do not add the three counts together.
- Resolution only chooses the winning side. It does **not** push to Git or pull into the environment by itself.
- Use the deterministic helpers under `${CLAUDE_PLUGIN_ROOT}/scripts/lib/`; do not inline Dataverse REST calls when a helper exists.
- Write artifacts through `${CLAUDE_PLUGIN_ROOT}/scripts/lib/inner-loop-paths.js` keys, not hardcoded paths.

## Step 1 — List conflicts

**Goal:** Get the authoritative conflict roster that this flow will resolve.

1. If the dispatcher did not just run a fresh Git refresh, refresh first so the Conflicts tab is not stale:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-changes-from-git.js" \
     --envUrl "<envUrl>" \
     --solutionUniqueName "<solutionUniqueName>"
   ```

2. List conflicts:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-conflicts.js" \
     --envUrl "<envUrl>" \
     --solutionUniqueName "<solutionUniqueName>"
   ```

   Expected shape:

   ```json
   {
     "count": 2,
     "items": [
       {
         "conflictId": "<guid>",
         "componentName": "<display name>",
         "componentType": "<component type>",
         "localChangeType": "Modify",
         "incomingChangeType": "Modify",
         "localCommitSha": "<sha-or-null>",
         "incomingCommitSha": "<sha-or-null>",
         "resolutionRequired": true
       }
     ]
   }
   ```

3. If `count === 0`, stop this reference and hand back to the dispatcher for re-detection. The state changed since routing.
4. If the helper fails with a transient 5xx, retry once. If it still fails, report the error and do not apply any resolution.

> **`action=3` is a broad bucket — only `useraction=0` are active conflicts (Bug 14).** `list-conflicts` queries `sourcecontrolcomponents` with the portal-faithful predicate **`action eq 3 AND useraction eq 0`** (Conflict, unresolved), partitioned by `solutionId`. On a real tenant `action eq 3` alone returns the **whole baseline** (e.g. ~90 rows); the ~87 `useraction=1` rows are the **already-synced baseline** and must be excluded — only `useraction=0` rows need resolution. Source-file conflicts (componentName `…​.sourcefile`, path under `/powerpagescodesites/<site>/src/…`) surface here as **`eligibleForSelectiveMerge: true`** with `ppcType: "sourcefile"`.

**Output:** `conflicts.items[]` with stable `conflictId` values.

## Step 2 — Render the conflict diff

**Goal:** Give the maker a readable browser page before collecting decisions.

Write the HTML report to `innerLoopPath(projectRoot, 'conflictsHtml')`, which resolves to `docs/inner-loop/conflicts.html`.

The report must be self-contained and must include a **semantic conflict explanation** for every component. The explanation should describe the user-meaningful overlap, not raw XML. Examples:

- `Account form — you changed the layout, they changed a field label; same component, both edited.`
- `Site setting "Authentication/OpenIdConnect/ClientId" — both sides changed the value; choose which source of truth wins.`
- `new_Task table — you edited the description locally, incoming Git also edited the table metadata.`

When rich field-level data is unavailable, derive a plain-language explanation from `componentName`, `componentType`, `localChangeType`, and `incomingChangeType`:

| Local change | Incoming change | Semantic explanation pattern |
|---|---|---|
| Modify | Modify | `<name> — both the environment and Git modified this <type>; same component, both edited.` |
| Modify | Delete | `<name> — you modified this <type>, while incoming Git removes it from the solution.` |
| Delete | Modify | `<name> — you removed this <type>, while incoming Git modifies it.` |
| Add | Add | `<name> — both sides added a component with the same identity or path.` |
| Any other pair | Any other pair | `<name> — environment action <localChangeType>, incoming action <incomingChangeType>; choose one winning side.` |

Use this HTML skeleton and escape all injected values:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Conflict resolution — __ENV_HOST__</title>
  <style>
    body { font-family: 'Segoe UI', sans-serif; padding: 24px; max-width: 1100px; margin: 0 auto; color: #1f1f1f; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; }
    .summary { color: #555; margin-bottom: 20px; }
    .card { border: 1px solid #ddd; border-radius: 6px; margin-bottom: 20px; overflow: hidden; }
    .card-header { background: #f3f3f3; padding: 10px 16px; font-weight: 600; }
    .explanation { padding: 10px 16px; margin: 0; background: #fff8e1; border-top: 1px solid #eee; }
    .sides { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
    .side { padding: 12px 16px; }
    .side-env { border-right: 1px solid #ddd; background: #fffde7; }
    .side-git { background: #e3f2fd; }
    .side-label { font-size: .75rem; font-weight: 700; text-transform: uppercase; color: #666; margin-bottom: 6px; }
    pre { margin: 0; font-size: .85rem; white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <h1>Conflict resolution</h1>
  <p class="summary">Environment: <strong>__ENV_HOST__</strong> &nbsp;|&nbsp; Branch: <strong>__BRANCH__</strong> &nbsp;|&nbsp; Conflicts: <strong>__COUNT__</strong></p>
  __CONFLICT_CARDS__
</body>
</html>
```

Each `__CONFLICT_CARDS__` entry must include:

- Header: component name and type.
- Explanation paragraph: the semantic explanation.
- Left side: **Current in environment** with available local fields or summary.
- Right side: **Incoming from Git** with available incoming fields or summary.

If only IDs/change types are available, render those fields and state that field-level payload was unavailable. Do not show raw XML as the primary explanation.

**Output:** `docs/inner-loop/conflicts.html` written and referenced in the chat summary.

## Step 3 — Collect the resolution strategy (one blanket choice, not per-component)

**Goal:** Capture the resolution strategy with a SINGLE question, then auto-assign it — never ask once per conflict (that does not scale to large conflict sets).

First, **partition the roster** by selective-merge eligibility:
- **Eligible (text-mergeable):** web template `source`, content snippet `value`, web page `copy`/`summary`, **site settings (type `9`)** as the whole flat `.sitesetting.yml` (metadata identical; only the `value:` line conflicts), and **web files type `3` whose annotation `documentbody` bytes are detected as text by the runtime content sniff**. Web-file eligibility is byte-based, not extension-based.
- **Not eligible (binary/scalar):** web files type `3` whose `documentbody` bytes are truly binary or ambiguous, components deleted in Git, and site settings whose `value` is **multi-line** (can't be safely substituted into a single yml line → keep/accept). The web-file sniff fails closed to binary on any ambiguity (NUL byte, invalid UTF-8, or high control-character ratio).

Show a compact Markdown roster in chat (number, component, type, eligibility, semantic explanation). Point the user to `docs/inner-loop/conflicts.html` for the side-by-side report.

<!-- gate: git-sync:2.conflict-decisions | category=progress | cancel-leaves=partial-decisions -->
> 🚦 **Gate (progress · git-sync:2.conflict-decisions):** Surface ONE `AskUserQuestion` for the whole batch — do **not** loop per component. Cancellation leaves the draft decisions only; nothing has been applied.
>
> | Question | Header | Options |
> |---|---|---|
> | `{eligibleCount}` of `{totalCount}` conflict(s) can be selectively merged. How should I resolve the batch? | Conflict resolution | Selectively merge all eligible (recommended), Keep all current changes, Accept all incoming changes |

**Apply the single answer to the whole batch — no per-component prompts:**

- **Selectively merge all eligible** → assign `strategy: "selective-merge"` to **every** eligible (text-mergeable) conflict automatically. **Binary/scalar conflicts are resolved per file**, not as a blanket subset: route them through the resolver's `binaryMatrix` exactly as documented in **`references/selective-merge-reference.md` → Phase 3a** (numbered roster → ask which serials to **Accept Incoming** → `parse-serial-selection.js` → echo-and-confirm → resume with `--binary-accept`). Do **not** define a competing `Keep all` / `Accept all` question for the binary subset here. Never ask per text component.
- **Keep all current changes** → assign `strategy: "keep-current"` to every conflict.
- **Accept all incoming changes** → assign `strategy: "accept-incoming"` to every conflict.

> Only drop to a per-component question if the user **explicitly** asks to decide individual components differently. The default is always the single blanket choice above.

> **Binary/scalar-only conflict sets.** When `eligibleCount` (text-mergeable) is `0` but binary/scalar conflicts exist, **"Selectively merge all eligible" still applies** — choosing it invokes `clone-merge-resolver.js`, which surfaces the `binaryMatrix` (with empty `textUnits`) and takes the user straight to the per-file Phase 3a matrix. The user keeps per-file control; never collapse to a blanket keep/accept just because there is no text to merge. When `eligibleCount` is `0`, phrase that first option as **"Decide binary/scalar per file"** so it reads clearly.

Normalize decisions as one entry per conflict. Text-mergeable conflicts take `strategy: "selective-merge"`; **binary/scalar conflicts derive their own `strategy` (`accept-incoming` | `keep-current`) per file from the Phase 3a matrix pick** — they are never forced to one shared value, so a single run can mix both:

```json
[
  { "conflictId": "<guid>", "componentName": "Search Results", "componentType": "8", "strategy": "selective-merge" },
  { "conflictId": "<guid>", "componentName": "Cat-PC.png", "componentType": "3", "strategy": "accept-incoming" },
  { "conflictId": "<guid>", "componentName": "HTTP/X-Frame-Options", "componentType": "9", "strategy": "keep-current" }
]
```

Decision meanings:

| Option | Strategy | Helper | After resolution |
|---|---|---|---|
| Selectively merge | `selective-merge` | `references/selective-merge-reference.md` | Clone-based native VS Code merge, safe push/PR, then accept + pull into the environment. |
| Keep current changes | `keep-current` | `resolve-conflict-keep.js` | Component moves to **Changes** and must later be committed. |
| Accept incoming changes | `accept-incoming` | `resolve-conflict-accept.js` | Component moves to **Updates** and must later be pulled. |

**Output:** `decisions[]` has exactly one entry for each `conflicts.items[]` entry — text-mergeable strategies from the blanket choice, binary/scalar strategies from the per-file Phase 3a matrix (which may mix `accept-incoming` and `keep-current` in the same run).

## Step 4 — Apply resolutions

**Goal:** Apply the recorded decisions sequentially and preserve a complete audit trail.

Process decisions one at a time. Do not run conflict helpers in parallel.

**Dispatch `selective-merge` first.** For every component whose strategy is `selective-merge`, **read and follow `references/selective-merge-reference.md`**. That flow runs `clone-merge-resolver.js`, reuses the flat clone recorded by `git-configure`, stages a real Git merge in `<cloneDir>/repo`, opens native VS Code Source Control / Merge Editor on the actual files, verifies the resolved merge, safely pushes or creates a PR, then accepts + pulls it into the environment. Do **not** call the keep/accept helpers for those components. The binary/scalar picks ride **into the same resolver run** (single reconcile/commit, A7/A8) — they are not applied separately.

> **Worked example — passing the per-file matrix answer through verbatim.** The Phase 3a matrix offered serials `2, 4, 6` and the user answered `2,6`. Carry that answer straight into the `--resume` call:
>
> ```bash
> node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/clone-merge-resolver.js" --input <inputs.json> --apply --resume --binary-accept "2,6"
> ```
>
> → serials **#2 and #6 become `accept-incoming` (Git wins)**; every other binary/scalar (here #4) defaults to **`keep-current` (env wins)**. Pass the serials **verbatim** — do not re-map or pre-expand ranges; the resolver validates them against `binaryMatrix` and re-asks on bad tokens. Map the shortcuts exactly: user answered `all` → `--binary-accept-all`; user answered `none` → `--binary-keep-mine` (or omit the flag).
>
> **Different branch — top-level blanket choices.** This matrix path exists **only** under "Selectively merge all eligible". When the **top-level** choice was "Keep all current" or "Accept all incoming", there is **no resolver and no matrix** — apply those blanket decisions with the standalone `resolve-git-conflict-useraction.js` keep/accept path below (one component at a time). Don't conflate the two branches.

### The primary (IL-015-proof) mechanism: `useraction` PATCH

`keep-current` and `accept-incoming` are both applied by PATCHing `useraction` on the component's `sourcecontrolcomponent` row (the Maker Portal's own mechanism). This is the **primary** path — it works even where the legacy `ResolveGitConflict` OData action is absent (IL-015, common). Use `resolve-git-conflict-useraction.js` directly:

```bash
# keep-current  → --decision keep-current   (useraction 1)
# accept-incoming → --decision accept-incoming (useraction 2)
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/resolve-git-conflict-useraction.js" \
  --envUrl "<envUrl>" \
  --solutionId "<solutionId>" \
  --componentId "<componentId>" \
  --decision "<accept-incoming|keep-current>" \
  --etag "*"
```

Map the args from the per-conflict roster + binding (note the names — they are NOT `--conflictId`/`--solutionUniqueName`/`--action`):

| Arg | Source | Notes |
|---|---|---|
| `--componentId` | `list-conflicts.js` → `items[].componentId` | the powerpagecomponent GUID, **not** `conflictId` |
| `--solutionId` | `detect-git-binding.js` → `boundSolutions[0].solutionId` | the solution GUID, **not** `--solutionUniqueName` |
| `--decision` | the recorded strategy | `accept-incoming` or `keep-current` (**not** `--action`) |
| `--etag` | pass `"*"` | blind concurrency — see note below |

> **`--etag "*"` note:** Without `--etag`, the helper tries to read the row's ETag first. If you pass `--sourceControlComponentId "<conflictId>"`, that read is a composite-key GET that is **restricted on some tenants** (`"Restricted API is not called by Microsoft publisher plugin"`). Passing `--etag "*"` skips the read and uses blind concurrency (`If-Match: *`), which always works. Omit `--etag` only if you want optimistic concurrency and the `--componentId` lookup path succeeds on your tenant.

A `notFound` result means there is no `action=3` row for that component (already resolved or not yet surfaced) — re-run `refresh-changes-from-git.js` and re-list. A `412` (`conflict: true`) means the row changed since read — re-read and retry (or use `--etag "*"`).

> **Convenience wrappers:** `resolve-conflict-accept.js` / `resolve-conflict-keep.js` take the **same** useraction path internally **when** given `--componentId` and `--solutionId` (plus `--envUrl`). If you call them with only `--conflictId`/`--solutionUniqueName`, they cannot take the useraction path and fall through to the often-absent `ResolveGitConflict` action — so always pass `--componentId` and `--solutionId` to them too.

Track each result as `applied` (`ok:true`), `failed`, or `applied-via-portal` with the helper output or error details.

### Last resort — Maker Portal walkthrough

Only if the `useraction` PATCH **and** the `ResolveGitConflict` fallback both fail on this tenant (neither programmatic path is available), fall back to the portal.

<!-- gate: git-sync:2.conflict-fallback | category=consent | cancel-leaves=no-changes -->
> 🚦 **Gate (consent · git-sync:2.conflict-fallback):** Fires only when **no** programmatic conflict-resolution path works (useraction PATCH failed AND `ResolveGitConflict` is absent). Surface `AskUserQuestion` before switching to the Maker Portal walkthrough.
>
> | Question | Header | Options |
> |---|---|---|
> | I couldn't resolve the conflict(s) programmatically on this tenant. I can walk you through applying the recorded decisions in the Maker Portal and then verify the result. Proceed? | Manual conflict fallback | Walk me through it, Cancel — no changes |

Fallback walkthrough:

1. Open the Maker Portal Conflicts tab:

   ```
   https://make.powerapps.com/environments/<environmentId>/solutions/<solutionId>/source-control?tab=Conflicts
   ```

2. For each decision, show the component name, type, semantic explanation, and selected action.
3. Instruct the user to select the conflicted row first; the **Keep current changes** and **Accept incoming changes** buttons remain disabled until a row is selected.
4. Apply the matching button in the portal, then continue to the next decision.
5. Mark portal-applied decisions as `applied-via-portal` and set `resolvedVia: "maker-portal"` in the marker.

**Output:** Every decision was attempted through the `useraction` PATCH (primary) or the Maker Portal fallback (last resort).

## Step 5 — Verify conflicts cleared and write marker

**Goal:** Confirm the Conflicts count is zero and persist the resolution record.

> **Do NOT run `RefreshChangesFromGit` between resolve and verify (Bug 14).** A refresh **resets `useraction` to 0** and re-surfaces the rows you just resolved (the "phantom conflict" loop). Verify by **re-listing conflicts** (and content-equality), not by re-refreshing and not by the pull's `updatesCount`.
>
> **When env == ADO, resolve with `keep-current` (Bug 4).** After a selective merge is pushed, the env and the bound branch are byte-identical. `accept-incoming` (`useraction=2`) then never clears `action=3` (pull returns `updatesCount: 0`, baseline never advances, a later refresh re-surfaces it). For such **converged** components — including **code-site source files** (env bytes from `powerpagessourcefile.filecontent` vs the branch source file) — resolve with **`keep-current` (`useraction=1`)**, which clears the conflict permanently. `reconcile-dataverse.js` detects convergence automatically (`decideConflictResolution`) and flips the decision.

1. Re-list conflicts:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-conflicts.js" \
     --envUrl "<envUrl>" \
     --solutionUniqueName "<solutionUniqueName>"
   ```

2. Expected result is `count === 0`.
   - If `count > 0`, list the remaining conflicts, write the marker with `status: "partial"`, and hand back to the dispatcher with the partial state.
   - If every attempted resolution failed, write `status: "failed"` and include the platform errors.

3. Write the marker to `innerLoopPath(projectRoot, 'lastConflictResolution')`, which resolves to `docs/inner-loop/last-conflict-resolution.json`:

   ```json
   {
     "skill": "git-sync",
     "flow": "conflict-resolution",
     "resolvedAt": "<ISO>",
     "envUrl": "<envUrl>",
     "branch": "<branch>",
     "organization": "<org>",
     "project": "<project>",
     "repository": "<repo>",
     "solutionUniqueName": "<solutionUniqueName>",
     "conflictsFound": 2,
     "conflictsResolved": 2,
     "remainingConflicts": 0,
     "pendingCommit": 1,
     "pendingPull": 1,
     "resolvedVia": "api",
     "tenantCapabilities": {
       "resolveGitConflictAvailable": true
     },
     "decisions": [
       {
         "conflictId": "<guid>",
         "componentName": "<display name>",
         "componentType": "<component type>",
         "strategy": "keep-current",
         "appliedVia": "api",
         "result": "applied"
       }
     ],
     "status": "succeeded"
   }
   ```

   Status values:

   | Status | Meaning |
   |---|---|
   | `succeeded` | All decisions applied and `remainingConflicts === 0`. |
   | `manual-resolution-required` | Fallback walkthrough was used and the user reported completion; dispatcher must still re-detect. |
   | `partial` | At least one conflict remains. |
   | `failed` | No resolution succeeded, or the platform rejected all decisions. |

4. State the post-resolution routing clearly:
   - **Keep current changes** does not push to Git. It moves each resolved item into **Changes**, so the dispatcher must route to the changes/commit flow.
   - **Accept incoming changes** does not pull into the environment. It moves each resolved item into **Updates**, so the dispatcher must route to the update/pull flow.
   - Resolution alone is not final success for the whole sync cycle.

**Output:** Conflicts are cleared or partially reported; `last-conflict-resolution.json` is written through the `lastConflictResolution` key.

## Step 6 — Hand back to the dispatcher

**Goal:** Let the dispatcher choose the next flow from the new state.

1. Re-detect state after the marker is written:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js" \
     --envUrl "<envUrl>" \
     --solutionUniqueName "<solutionUniqueName>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-incoming-updates.js" \
     --envUrl "<envUrl>" \
     --solutionUniqueName "<solutionUniqueName>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-conflicts.js" \
     --envUrl "<envUrl>" \
     --solutionUniqueName "<solutionUniqueName>"
   ```

2. Pass the counts back to `detectSyncDirection({ counts, args })` in the dispatcher.
3. If `Conflicts > 0`, loop back to this reference for the remaining components.
4. If `Changes > 0`, the dispatcher reads and follows `references/changes-reference.md`.
5. If `Updates > 0`, the dispatcher reads and follows `references/update-reference.md`.
6. If both exist, the dispatcher uses its mixed-order gate.

**Output:** The conflict flow has ended; next action is chosen by dispatcher state, not by this reference.

## Error handling

| Condition | Handling |
|---|---|
| `list-conflicts.js` fails twice | Stop before mutations and surface the error. |
| `list-conflicts.js` returns `count: 0` immediately after dispatcher routed here | Treat as stale state cleared elsewhere; hand back for re-detection. |
| Helper returns tenant-action 404 | Use the fallback-mode gate; do not retry absent action. |
| One helper call fails with a non-404 4xx/5xx | Record that component as `failed`, continue sequentially with remaining decisions, then verify. |
| Remaining conflicts after verify | Write `status: "partial"`, list unresolved components, and hand back to dispatcher. |
| User cancels decisions gate | No Dataverse mutation occurred; leave only partial draft decisions in memory. |
| User cancels fallback gate | No further changes; write no success marker unless earlier API decisions actually changed state, then verify and mark `partial`. |

## Artifacts written

| Artifact | Inner-loop key | Purpose |
|---|---|---|
| `docs/inner-loop/conflicts.html` | `conflictsHtml` | Human-readable side-by-side diff with semantic explanations. |
| `docs/inner-loop/last-conflict-resolution.json` | `lastConflictResolution` | Machine-readable resolution marker for dispatcher and validators. |

## Selective 3-way merge — IMPLEMENTED

When the user picks **"Selectively merge (recommended)"** for text-mergeable conflicts, follow **`references/selective-merge-reference.md`**. That reference is the canonical path for selective merge in `git-sync`.

- The entry point is `clone-merge-resolver.js` with the phased dry-run / apply / resume flow documented there.
- The resolver reuses the flat clone recorded by `git-configure` (`<cloneDir>/repo`, with `<cloneDir>/.pp-merge` for merge scratch), stages a real Git merge, and opens VS Code on the clone so native Source Control, the 3-way Merge Editor, and CodeLens work on the actual files. If the clone record is missing, `git-sync` prompts for a clone directory as a graceful fallback before continuing.
- The helper verifies there are no unmerged paths and no remaining `<<<<<<<` markers before any shared-state mutation.
- It then safely fast-forwards the bound branch when allowed, or creates a `pp-merge/<user>/<branch>-<timestamp>` branch and PR with auto-complete. It never force-pushes.
- After ADO is landed, it runs the existing Dataverse round-trip: refresh, accept incoming via `useraction=2`, pull, verify `Conflicts=0`, and content-verify with EOL-normalized byte comparison. For text-detected web files, content-verify re-reads annotation `documentbody` bytes and, if the pull did not update them, falls back to PATCHing `documentbody` with the resolved base64 before re-reading and verifying again.
- Web files type `3` are routed by content sniff: text-detected bytes go through the VS Code 3-way editor, while truly-binary or ambiguous bytes remain on the binary keep/accept path. Scalar site settings type `9`, credential/auth-classified settings, and deleted-in-Git components also remain on keep/accept.

This selective-merge step is dispatched from Step 4 while preserving dispatcher hand-back and marker semantics (`strategy: "selective-merge"`).
