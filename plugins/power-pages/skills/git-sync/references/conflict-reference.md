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

## Step 3 — Collect per-component resolution decisions

**Goal:** Capture one decision for every conflict before mutating anything.

Show a compact Markdown roster in chat with columns: number, component, type, semantic explanation, and decision. Point the user to `docs/inner-loop/conflicts.html` for the side-by-side report.

<!-- gate: git-sync:2.conflict-decisions | category=progress | cancel-leaves=partial-decisions -->
> 🚦 **Gate (progress · git-sync:2.conflict-decisions):** Surface `AskUserQuestion` and collect a per-component decision map. Cancellation leaves any already-collected decisions as draft only; no conflict resolution has been applied yet.
>
> | Question | Header | Options |
> |---|---|---|
> | For each conflicted component in the roster, which side should win? Choose one option per component. | Conflict resolution decisions | Keep current changes, Accept incoming changes |

Normalize decisions as:

```json
[
  {
    "conflictId": "<guid>",
    "componentName": "<display name>",
    "componentType": "<component type>",
    "strategy": "keep-current"
  },
  {
    "conflictId": "<guid>",
    "componentName": "<display name>",
    "componentType": "<component type>",
    "strategy": "accept-incoming"
  }
]
```

Decision meanings:

| Option | Strategy | Helper | After resolution |
|---|---|---|---|
| Keep current changes | `keep-current` | `resolve-conflict-keep.js` | Component moves to **Changes** and must later be committed. |
| Accept incoming changes | `accept-incoming` | `resolve-conflict-accept.js` | Component moves to **Updates** and must later be pulled. |

**Output:** `decisions[]` has exactly one entry for each `conflicts.items[]` entry.

## Step 4 — Apply resolutions

**Goal:** Apply the recorded decisions sequentially and preserve a complete audit trail.

Process decisions one at a time. Do not run conflict helpers in parallel.

For `keep-current`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/resolve-conflict-keep.js" \
  --envUrl "<envUrl>" \
  --conflictId "<conflictId>" \
  --solutionUniqueName "<solutionUniqueName>"
```

For `accept-incoming`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/resolve-conflict-accept.js" \
  --envUrl "<envUrl>" \
  --conflictId "<conflictId>" \
  --solutionUniqueName "<solutionUniqueName>"
```

Track each result as `applied`, `failed`, or `applied-via-portal` with the helper output or error details.

If a helper returns `statusCode: 404` or an error indicating the `ResolveGitConflict` action is unavailable, stop the API path and enter fallback mode before any retry loop. Do not keep retrying an absent tenant action.

<!-- gate: git-sync:2.conflict-fallback | category=consent | cancel-leaves=no-changes -->
> 🚦 **Gate (consent · git-sync:2.conflict-fallback):** Fires only when the programmatic conflict-resolution action is unavailable. Surface `AskUserQuestion` before switching to the Maker Portal walkthrough.
>
> | Question | Header | Options |
> |---|---|---|
> | The programmatic conflict-resolution action is not available on this tenant. I can walk you through applying the recorded decisions in the Maker Portal and then verify the result. Proceed? | Manual conflict fallback | Walk me through it, Cancel — no changes |

Fallback walkthrough:

1. Open the Maker Portal Conflicts tab:

   ```
   https://make.powerapps.com/environments/<environmentId>/solutions/<solutionId>/source-control?tab=Conflicts
   ```

2. For each decision, show the component name, type, semantic explanation, and selected action.
3. Instruct the user to select the conflicted row first; the **Keep current changes** and **Accept incoming changes** buttons remain disabled until a row is selected.
4. Apply the matching button in the portal, then continue to the next decision.
5. Mark portal-applied decisions as `applied-via-portal` and set `resolvedVia: "maker-portal"` in the marker.

**Output:** Every decision was attempted through the API or the Maker Portal fallback.

## Step 5 — Verify conflicts cleared and write marker

**Goal:** Confirm the Conflicts count is zero and persist the resolution record.

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

## Future — VS Code + LLM selective 3-way merge (planned, not yet built)

This is a design note only; do not execute it in the current flow.

- Later, this reference is where selective conflict merging will land.
- It replaces the binary **Keep current changes** / **Accept incoming changes** choice above.
- Merge inputs: **BASE** = `branchSyncedCommitId` common ancestor.
- **OURS** = the current environment component.
- **THEIRS** = the Azure DevOps file.
- The agent opens these in a VS Code merge editor when available.
- The LLM proposes resolutions only for overlapping hunks.
- A human confirms every proposed resolution; LLM output is never auto-applied.
- Security-sensitive component types get a harder gate or remain binary-only.
- Examples: auth-related site settings, secrets, plug-in code, and server-side code.
- Before apply, the flow runs validate-before-apply checks.
- It also captures an environment-side snapshot for reversibility.
- Non-VS-Code fallback: write BASE/OURS/THEIRS files plus a proposed patch for review.
- Once built, this selective merge step replaces Step 4 while preserving dispatcher hand-back and marker semantics.
