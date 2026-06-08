---
name: resolve-conflicts
description: >-
  Walks the user through per-object conflict resolution for the bound Dataverse environment.
  Lists all conflicted components, renders an HTML diff page (docs/inner-loop/conflicts.html)
  showing both the environment version and the incoming Git version, collects Keep-Existing /
  Accept-Incoming decisions (bundled prompt when more than 3 conflicts), applies each decision,
  and verifies the Conflicts tab reaches zero.
  Writes docs/inner-loop/conflicts.html and docs/inner-loop/last-conflict-resolution.json.
  Use when asked: "resolve conflicts", "fix merge conflicts", "I have conflicts in my env",
  "help me resolve git conflicts", "conflicts in maker portal", "sync-from-git found conflicts",
  "run resolve-conflicts".
user-invocable: true
argument-hint: ""
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Resolve Conflicts

Resolves per-object conflicts between the Dataverse environment's version and the incoming Git version. Called by `sync-from-git` when `RefreshChangesFromGit` returns Conflicts > 0, or invoked standalone. After resolution, the environment's Conflicts count reaches zero and `sync-from-git` can proceed with `PullChangesFromGit`.

## Overview

A conflict in Power Platform Connect-to-Git terminology is a single component (web template, site setting, web page, etc.) that has been modified in **both** the environment and the bound branch since the last sync — the platform cannot decide automatically which version to keep. This skill walks the user through each conflict, presents both sides, collects a Keep-Existing / Accept-Incoming decision, and applies it via the appropriate OData action.

**Bundling rule:** when more than 3 conflicts exist, this skill collapses the per-conflict prompts into one bundled question with `Keep all` / `Accept all` / `Decide per-object` options. This caps approval-gate count and matches the convention in `${CLAUDE_PLUGIN_ROOT}/references/conflict-resolution-patterns.md` §5.

> 🛈 **Three tabs are mutually exclusive per component.** When a `sri_Task` (or any other component) is in Conflicts, it does NOT also appear in Changes or Updates — the platform suppresses the dual entry to force the user through resolution first. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §20. Don't sum the three counts when summarising "pending work".

> 🛈 **Resolution decides the winner; it does NOT push/pull.** After Keep-Existing → the item lands in pending Changes and STILL needs `commit-to-git` to reach `main`. After Accept-Incoming → the item lands in pending Updates and STILL needs `sync-from-git` to write to the env. The Phase 7 hand-back surface MUST state the remaining work, not declare overall success. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §21.

> 🛈 **Always refresh from git before listing conflicts.** Phase 1 calls `list-conflicts.js`, but stale data is possible if no `RefreshChangesFromGit` has run since the user's last edit on either side. The maker portal's **Refresh** button does NOT re-check git; only **Check for updates** does — see `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §22. If invoked standalone, this skill should run a fresh refresh-from-git in Phase 1 before asserting `conflicts.count`.

**References:**
- `${CLAUDE_PLUGIN_ROOT}/references/conflict-resolution-patterns.md` §3 (Keep-env vs Accept-incoming strategies)
- `${CLAUDE_PLUGIN_ROOT}/references/conflict-resolution-patterns.md` §5 (bundle > 3 conflicts into one prompt)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-flow.md` §3 (Conflicted state classification)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md` Pattern IL-015 (`ResolveGitConflict` absent → Maker Portal fallback in Phase 5)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md` Pattern IL-016 (`gitconflictfiles` 404 → false negative; use `PreValidateGitComponents` to confirm)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §20 (Conflicts don't double-count in Changes/Updates)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §21 (Resolution decides winner; commit/pull still required to finalize)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §22 (`RefreshChangesFromGit` required before conflict diff is authoritative)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §23 (Maker-portal Keep/Accept buttons require row selection — fallback UX gotcha)

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and logged in
- A Git binding already established (run `/power-pages:setup-git-integration` first if needed)
- At least one conflict in the environment (otherwise the skill exits cleanly)

**Initial request:** $ARGUMENTS

---

## Phase 1 — Binding + Conflict Presence Check

**Goal:** Confirm tooling, binding, and presence of conflicts before doing any work.

**Do NOT create tasks yet.** Use natural-language progress reporting only during this phase.

Steps:

1. Verify PAC CLI auth and acquire an env-scoped token:

   ```bash
   pac env who --json
   az account get-access-token --resource <envUrl> --query expiresOn -o tsv
   ```

2. Check the Git binding state and current conflict count in parallel:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-git-binding.js" --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-conflicts.js"     --envUrl "<envUrl>"
   ```

3. Branch on result:

   - `bound === false` → no binding to resolve against.
   - `conflicts.count === 0` → nothing to resolve.

   <!-- gate: resolve-conflicts:1.binding-check | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · resolve-conflicts:1.binding-check):** When either check fails, surface `AskUserQuestion`:

   | Condition | Question | Options |
   |---|---|---|
   | No binding | No Git binding found. Set one up first? | Run /power-pages:setup-git-integration, Cancel |
   | No conflicts | No conflicts found (Conflicts count = 0). The env is clean. | Run /power-pages:sync-from-git (if stale), Exit — nothing to do |

**Output:** Confirmed binding + N > 0 conflicts to resolve.

---

## Phase 2 — List Conflicts

**Goal:** Create the task list now that scope is known, and pull the full conflict roster.

Tasks to create (`TaskCreate`):

1. List all conflicts
2. Render HTML conflict diff page
3. Collect resolution decisions
4. Apply decisions via OData
5. Verify conflicts cleared
6. Write `last-conflict-resolution.json` marker
7. Hand back / tracking

Steps:

1. Pull the full list:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-conflicts.js" --envUrl "<envUrl>"
   ```

   Expected: `{ conflicts: [{ objectId, name, objectType, envVersion, gitVersion }], count: N }`.

2. Display a one-line summary: `Found N conflict(s) in the bound environment`.

**Output:** `conflicts[]` array of length N.

---

## Phase 3 — Render HTML Conflict Diff Page

**Goal:** Give the user a side-by-side view they can study outside the chat before deciding.

Steps:

1. Write `docs/inner-loop/conflicts.html` — a table showing both sides of each conflict (self-contained, no external CDN):

   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head><meta charset="UTF-8"><title>Conflict resolution — {envHost}</title>
   <style>
     body  { font-family: 'Segoe UI', sans-serif; padding: 24px; max-width: 1100px; margin: 0 auto; }
     h1   { font-size: 1.4rem; }
     .card { border: 1px solid #ddd; border-radius: 6px; margin-bottom: 20px; overflow: hidden; }
     .card-header { background: #f3f3f3; padding: 10px 16px; font-weight: 600; }
     .sides { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
     .side { padding: 12px 16px; }
     .side-env { border-right: 1px solid #ddd; background: #fffde7; }
     .side-git { background: #e3f2fd; }
     .side-label { font-size: .75rem; font-weight: 700; text-transform: uppercase; color: #666; margin-bottom: 6px; }
     pre  { margin: 0; font-size: .85rem; white-space: pre-wrap; word-break: break-all; }
   </style></head>
   <body>
     <h1>Conflict resolution</h1>
     <p>Environment: <strong>__ENV_HOST__</strong> &nbsp;|&nbsp;
        Branch: <strong>__BRANCH__</strong> &nbsp;|&nbsp;
        Conflicts: <strong>__COUNT__</strong></p>
     __CONFLICT_CARDS__
   </body></html>
   ```

2. For each conflict, generate a `<div class="card">` with the object name + type in the header and two `<div class="side">` columns: left = environment version (`side-env`), right = Git/incoming version (`side-git`).

3. If `list-conflicts.js` did not return rich diff data, render the available fields (`objectId`, `objectType`, `name`) and label the sides "Current in env" / "Incoming from Git".

**Output:** `docs/inner-loop/conflicts.html` written; user can open it in a browser.

---

## Phase 4 — Collect Resolution Decisions

**Goal:** Get a Keep-Existing / Accept-Incoming decision for every conflict, while respecting the lint cap of ≤ 3 individual prompts.

<!-- gate: resolve-conflicts:4.decisions | category=progress | cancel-leaves=partial-decisions -->
> 🚦 **Gate (progress · resolve-conflicts:4.decisions):** Loop-style — one marker covers BOTH branches below. The per-conflict variant fires up to 3 times (one per conflict); the bundled variant fires once for the > 3 case.

Steps:

1. **Branch on conflict count:**

   - **≤ 3 conflicts — individual prompts:** for each conflict in sequence (max 3 iterations), surface `AskUserQuestion`:

     | Question | Header | Options |
     |---|---|---|
     | Conflict {i}/{N}: `{objectType}` "{name}". Which version to keep? | Conflict resolution | Keep my env version (Keep-Existing), Accept incoming from Git (Accept-Incoming) |

   - **> 3 conflicts — bundled prompt:** render a Markdown table listing each conflict by name + type for the chat, then surface one `AskUserQuestion`:

     | Question | Header | Options |
     |---|---|---|
     | You have N conflicts (see `docs/inner-loop/conflicts.html` for the diff view). Which global strategy should I apply? | Bulk conflict resolution | Keep ALL env versions (keep-existing), Accept ALL incoming versions from Git (accept-incoming), Let me decide per-object (open per-object prompts one at a time) |

2. Record each decision as `{ objectId, strategy: "keep-existing" | "accept-incoming" }`.

**Output:** A `decisions[]` array, one entry per conflict.

---

## Phase 5 — Apply Resolutions

**Goal:** Apply each decision via the appropriate OData action, processing sequentially to avoid platform contention. On tenants where the `ResolveGitConflict` action is not registered (pattern IL-015), fall back to a Maker Portal walkthrough instead of failing.

Steps:

1. **API availability probe** (one-time, before the loop). Detect whether the programmatic action exists on this tenant:

   ```bash
   curl -s -o /dev/null -w "%{http_code}" \
     -H "Authorization: Bearer <dvToken>" \
     "<envUrl>/api/data/v9.2/ResolveGitConflict"
   ```

   - HTTP `405` / `400` (method-not-allowed or bad-body, but the segment exists) → action is **available**. Proceed to step 2 (API path).
   - HTTP `404` with body containing `Resource not found for the segment 'ResolveGitConflict'` → action is **absent** (pattern IL-015). Skip step 2; jump to step 3 (Maker Portal fallback path).

   Cache the result in `.git-integration-manifest.json` under `tenantCapabilities.resolveGitConflictAvailable` so subsequent runs short-circuit immediately.

2. **API path** — when `resolveGitConflictAvailable === true`:

   For each conflict decision, call the matching helper:

   **Keep-Existing (environment wins):**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/resolve-conflict-keep.js" \
       --envUrl    "<envUrl>" \
       --objectId  "<objectId>"
   ```

   **Accept-Incoming (Git wins):**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/resolve-conflict-accept.js" \
       --envUrl    "<envUrl>" \
       --objectId  "<objectId>"
   ```

   Both return 204 No Content on success.

   Process **sequentially**, not in parallel — the platform may enforce one resolution at a time. Track results:
   - Success → mark decision `applied`.
   - Error → record failure; continue with remaining; surface all failures at the end.

3. **Maker Portal fallback path** — when `resolveGitConflictAvailable === false` (pattern IL-015 applies):

   <!-- gate: resolve-conflicts:5.fallback-mode | category=consent | cancel-leaves=no-changes -->
   > 🚦 **Gate (consent · resolve-conflicts:5.fallback-mode):** Surface `AskUserQuestion` once before walking through:

   | Question | Header | Options |
   |---|---|---|
   | The `ResolveGitConflict` OData action is not available on this tenant (pattern IL-015). I'll walk you through resolving each conflict in the Maker Portal one at a time and record the decisions. Proceed? | API absent — manual fallback | Walk me through it (Recommended), Cancel — I'll resolve them another way |

   On **Walk me through it**:

   1. Surface the Maker Portal deep-link once:
      `https://make.powerapps.com/environments/{envId}/solutions/{solutionId}/source-control?tab=Conflicts`
   2. For each conflict in `decisions[]`, post one chat message:
      > Conflict **{i}/{N}**: `{objectType}` — **"{name}"**
      > Decision recorded: **{Keep my env version | Accept incoming from Git}**
      > In the portal: select this row → click **{Keep | Accept}** → click **Save**. Reply `done` (or `skip` if you change your mind) when finished.
   3. After the user replies `done`, mark the decision `applied-via-portal`. Continue to next.
   4. After the loop, re-validate by calling `PreValidateGitComponents`:

      ```bash
      curl -X POST -H "Authorization: Bearer <dvToken>" \
        -H "Content-Type: application/json" \
        -d '{"SolutionUniqueName":"<solutionUniqueName>"}' \
        "<envUrl>/api/data/v9.2/PreValidateGitComponents"
      ```

      Inspect the response: if there is no `0x80098015` (conflicts-blocking) message, conflicts are cleared. If the message persists, list the still-conflicted components and offer to re-run the walkthrough.

   **Why the fallback is worth doing** (not just punting to the portal): the skill still owns
   - the per-conflict diff rendering (`conflicts.html` from Phase 3),
   - the bundled vs per-conflict decision UX (Phase 4 still runs),
   - sequencing and progress tracking,
   - the audit marker (`last-conflict-resolution.json` with `resolvedVia: "maker-portal"`),
   - and the post-resolution re-validation against `PreValidateGitComponents`.
   The user still benefits from the skill as an orchestration layer; only the final mutation moves to the portal.

**Output:** All decisions attempted (via API or portal); per-decision success / failure / `applied-via-portal` tracked.

---

## Phase 6 — Verify Conflicts Cleared

**Goal:** Confirm the Conflicts tab reaches zero, then persist the marker.

Steps:

1. Re-query:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-conflicts.js" --envUrl "<envUrl>"
   ```

   Expected: `count === 0`. If `count > 0`, some resolutions did not take effect:
   - List the remaining conflicts.
   - Offer to re-run Phase 4–5 for the remaining items.

2. Write `docs/inner-loop/last-conflict-resolution.json`:

   ```json
   {
     "skill":              "resolve-conflicts",
     "resolvedAt":         "<ISO>",
     "envUrl":             "<envUrl>",
     "branch":             "<branch>",
     "organization":       "<org>",
     "project":            "<proj>",
     "repository":         "<repo>",
     "conflictsFound":     N,
     "conflictsResolved":  M,
     "remainingConflicts": R,
     "resolvedVia":        "api" | "maker-portal",
     "tenantCapabilities": { "resolveGitConflictAvailable": true | false },
     "decisions": [
       { "objectId": "...", "name": "...", "objectType": "...", "strategy": "keep-existing", "appliedVia": "api" | "portal" }
     ],
     "status":             "succeeded" | "manual-resolution-required" | "partial" | "failed"
   }
   ```

   - `status: "succeeded"` when all decisions applied via the API and `remainingConflicts == 0`.
   - `status: "manual-resolution-required"` when the fallback path ran and the user reported completion for every conflict (pattern IL-015 was active).
   - `status: "partial"` when `remainingConflicts > 0`.
   - `status: "failed"` when all resolutions failed.

   The path is registered in `scripts/lib/inner-loop-paths.js` under the key `lastConflictResolution`.

**Output:** Conflicts cleared (or partial); `docs/inner-loop/last-conflict-resolution.json` written.

---

## Phase 7 — Hand Back / Tracking

**Goal:** Return control to the original caller (or summarise for standalone invocations) and record skill usage.

Steps:

1. Summarise the resolution:

   > ✅ Conflicts cleared: M of N resolved.
   > The environment is now ready for `PullChangesFromGit`.

2. If this skill was dispatched from `sync-from-git`, control returns automatically to Phase 4 of that skill. If invoked standalone, suggest `/power-pages:sync-from-git` to complete the pull.

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "ResolveConflicts"`.

**Output:** Control returned to caller (or user routed to `/power-pages:sync-from-git`).

---

## Artifacts Written

| File | Location | Purpose |
|---|---|---|
| `conflicts.html` | `docs/inner-loop/` | Human-readable diff view; open in a browser. |
| `last-conflict-resolution.json` | `docs/inner-loop/` | Skill-run marker; validated by `validate-resolve-conflicts.js`. |

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| List all conflicts | Listing conflicts | Query `list-conflicts.js` for the full conflict roster |
| Render HTML conflict diff page | Rendering conflict diff | Compose per-conflict side-by-side cards into `docs/inner-loop/conflicts.html` |
| Collect resolution decisions | Collecting decisions | Per-conflict prompts (≤ 3) or one bundled prompt (> 3) |
| Apply decisions via OData | Applying resolutions | Sequentially call `resolve-conflict-keep.js` / `resolve-conflict-accept.js`; track per-decision results |
| Verify conflicts cleared | Verifying conflicts cleared | Re-query `list-conflicts.js`; surface any remaining items |
| Write `last-conflict-resolution.json` marker | Writing resolution marker | Persist counts + decisions + status to the inner-loop marker file |
| Hand back / tracking | Finalising resolution | Summarise outcome; return to `sync-from-git` or suggest it for standalone runs |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: If no binding OR no conflicts → route accordingly (gate `resolve-conflicts:1.binding-check`).
2. **Phase 4**: Per-conflict (≤ 3) or bundled (> 3) Keep-Existing / Accept-Incoming decisions (gate `resolve-conflicts:4.decisions`).

---

## Error Handling

- **`list-conflicts.js` query fails** (transient 5xx): retry once; if it fails again, surface the error and stop.
- **`list-conflicts.js` returns `count: 0` but `CommitToGit` was just blocked by `0x80098015`** (false negative — pattern IL-016): treat as "conflicts present but enumeration entity unavailable on this tenant". Fall back to `PreValidateGitComponents` for the authoritative conflict list, or open the Maker Portal Conflicts tab.
- **`ResolveGitConflict` returns 404** (pattern IL-015): the action is not registered on this tenant. Drop into the Phase 5 Maker Portal fallback path described above. Do not retry the API — every call will 404.
- **`resolve-conflict-keep.js` / `resolve-conflict-accept.js` returns 4xx for one item** (not 404): record the per-decision failure, continue with remaining items, and surface the full failure list in Phase 6.
- **All resolutions fail**: write the marker with `status: "failed"` and surface the platform error verbatim — there may be a dependency that needs to be addressed manually. If every failure is HTTP 404, switch to the fallback path instead.
- **`remainingConflicts > 0` after Phase 6**: write `status: "partial"`. Offer to re-run; the hook validator will block downstream skills until the count reaches 0.

---

**Begin with Phase 1: Binding + Conflict Presence Check**
