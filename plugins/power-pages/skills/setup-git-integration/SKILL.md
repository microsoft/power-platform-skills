---
name: setup-git-integration
description: >-
  One-shot setup that binds an entire Dataverse environment to an Azure DevOps
  repository + branch + folder via the ConnectToGit OData action. Verifies
  prerequisites (Managed Env, sys-admin role, ADO permissions, repo
  initialized), gathers and validates binding fields, gets consent, performs
  the bind, verifies the binding round-trips, and writes
  .git-integration-manifest.json.
  Use when asked: "connect my env to git", "bind to ADO repo",
  "set up git integration", "enable git for this environment",
  "wire up the dev env to azure devops", "turn on connect to git".
user-invocable: true
argument-hint: "Optional: 'env' to force env-binding (skip the choice prompt)"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Setup Git Integration

Binds the **whole Dataverse environment** to an Azure DevOps repo + branch + folder via the `ConnectToGit` OData action (`ConnectionType=1`). After this skill completes, every solution-aware component in the env round-trips through that one Git location.

## Overview

This is the most common Inner Dev Loop entry skill — env-level binding is what Microsoft Learn documents as the default Connect-to-Git topology. If the user wants to bind only a specific solution (rather than the whole env), use `/power-pages:connect-solution-to-git` instead — that's the lower-fan-out path with more ergonomic foot-guns (notably the shared-object restriction).

The skill verifies prerequisites (Managed Env on, system-admin role, ADO PAT scopes, repo initialized), collects the binding fields, gets explicit consent, calls `ConnectToGit`, verifies the binding round-trips via `detect-git-binding`, and writes the load-bearing `.git-integration-manifest.json` that every other inner-loop skill reads in its Phase 1.

**References:**
- `${CLAUDE_PLUGIN_ROOT}/references/binding-strategy.md` (env vs solution binding tradeoffs)
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-prerequisites.md`
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-api-patterns.md` §1-§3 (`ConnectToGit` payload + `ConnectionType` values)

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and logged in
- **Recommended:** Managed Environment ON for the target env (HAR-confirmed 2026-06: solution-binding works on Basic envs in practice, but env-binding via `ConnectionType=1` has not been verified without Managed Env — treat as still required for env-binding until proven otherwise; see `references/inner-loop-empirical-findings.md` §1)
- The signed-in user holds the system-administrator role on the target env
- **Optional** ADO PAT with `Code (read & write)` scope on the target repo — only used by pre-check helpers (`verify-repo-initialized`, `verify-ado-permissions`); `ConnectToGit` itself uses your tenant Entra OAuth grant (set up out-of-band once per tenant via the maker portal "Authorize ADO" flow). See `references/inner-loop-empirical-findings.md` §5.
- The target ADO repo exists and is initialized (or the user accepts the Phase 2 init flow)

**Initial request:** $ARGUMENTS

---

## Phase 1 — Prereq Check

**Goal:** Hard-gate every Connect-to-Git prerequisite — auth, existing-binding state, Managed Env, and ADO permissions — before doing any work.

**Do NOT create tasks yet.** Use natural-language progress reporting only during this phase.

Steps:

1. Verify PAC CLI + Azure CLI are authenticated:

   ```bash
   pac env who --json
   az account get-access-token --resource <envUrl> --query expiresOn -o tsv
   ```

   Both must succeed. If either fails, surface the failure verbatim and stop.

2. Already-bound check — run `detect-git-binding.js`. If `bound === true`, this env is already wired to a repo. Surface the existing binding (org / project / repo / branch) and ask whether the user wants to:
   - Disconnect first and re-bind here (call `/power-pages:branch-switch` for an in-place change, or run `disconnect-from-git.js` for a full unbind), OR
   - Cancel this skill (current binding is fine).

3. Verify Managed Environment + ADO permissions in parallel:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-managed-env.js" --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-ado-permissions.js" \
       --organization "<adoOrg>" --project "<adoProject>" --repository "<adoRepo>" --token "<adoToken>"
   ```

   Classification rules:
   - **Hard-block** on PAC CLI / Az CLI auth failure (no recovery within this skill).
   - **Hard-block** on a clearly malformed `verify-managed-env` response (HTTP/network error). A successful 200 returning `enabled:false` is NOT a hard-block (see warn-not-block below).
   - **Warn** on `verify-managed-env` returning `enabled:false`. Microsoft Learn lists Managed Env as required, but env-level binding behavior without Managed Env has not been fully characterized. Solution-level binding empirically works on Basic envs (see `references/inner-loop-empirical-findings.md` §1) — if the user knows that, they may want to switch to `/power-pages:connect-solution-to-git`.
   - **Warn (not block)** on ADO permissions failure when no PAT was supplied — the PAT is optional, and `ConnectToGit` itself uses tenant Entra OAuth, not the PAT.
   - **Hard-block** on ADO permissions failure when a PAT *was* supplied (real auth issue worth surfacing).

   <!-- gate: setup-git-integration:1.prereq-fail | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · setup-git-integration:1.prereq-fail):** When any **hard-block** above fires, surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | One or more prerequisites failed. How would you like to proceed? | Prerequisite failures | Open remediation URLs (I'll list them), Cancel and fix manually |

   <!-- gate: setup-git-integration:1.managed-env-warning | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · setup-git-integration:1.managed-env-warning):** When Managed Env is OFF but no hard-blocks fired, surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Managed Env is OFF on `{envHost}`. Microsoft docs list it as required for env-level binding, but solution-binding works without it on some tenants. How would you like to proceed? | Managed Env warning | Switch to /power-pages:connect-solution-to-git (Recommended), Continue with env-binding anyway, Cancel and enable Managed Env first |

**Output:** All prereqs green; no existing env binding blocking a fresh bind.

---

## Phase 2 — Gather Binding Fields

**Goal:** Collect the 5 free-text binding fields (org / project / repo / branch / folder), validate them, and confirm the target ADO repo is initialized.

Tasks to create (`TaskCreate`):

1. Gather ADO repo coordinates
2. Verify ADO repo is initialized
3. Render and review binding plan
4. Final consent before bind
5. Execute `ConnectToGit`
6. Verify binding round-trips
7. Write `.git-integration-manifest.json`

Steps:

1. <!-- not-a-gate: setup-git-integration:2.ado-fields — data-gathering for ADO org/project/repo/branch/folder -->
   Collect free-text fields via `AskUserQuestion` (data-gathering, NOT a gate):

   `setup-git-integration:2.ado-fields` (not-a-gate) — ADO organization name, project name, repository name, target branch (default `main`), folder-in-repo (default `<solutionName>` or `src`).

   Validate inputs:
   - Org / project / repo names: non-empty, no `/` or `\`.
   - Branch: non-empty.
   - Folder: non-empty; leading `/` stripped.

2. Repository init check:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-repo-initialized.js" \
       --organization "<org>" --project "<proj>" --repository "<repo>" --token "<adoToken>"
   ```

   - `initialized === true` → continue to Phase 3.
   - `initialized === false` → the repo is empty; `ConnectToGit` will fail with a cryptic error if we proceed.

     <!-- gate: setup-git-integration:2.repo-init | category=consent | cancel-leaves=nothing -->
     > 🚦 **Gate (consent · setup-git-integration:2.repo-init):** Surface `AskUserQuestion`:

     | Question | Header | Options |
     |---|---|---|
     | The ADO repo `{org}/{project}/{repo}` is empty. Initialize it now with a README commit? | Repo initialization | Initialize with README commit (Recommended), I'll initialize manually then re-run setup-git-integration, Cancel |

     - **Initialize now** → push a stub `README.md` on the chosen branch via ADO Git push REST. If that's not available in the current helper set, surface the manual command:

       ```bash
       git clone https://dev.azure.com/<org>/<proj>/_git/<repo>
       cd <repo>
       git switch -c <branch>
       echo "# <repo>" > README.md
       git add README.md && git commit -m "Initialize repo for Power Platform Git integration"
       git push -u origin <branch>
       ```

     - **Manual** → exit cleanly. The user re-runs this skill after initializing.
     - **Cancel** → exit cleanly.

**Output:** All 5 fields validated; target repo confirmed initialized.

---

## Phase 3 — Render the Binding Plan

**Goal:** Compose the plan-data file and show the user a textual preview of what is about to be bound.

Steps:

1. Compose `planData` and write it to `docs/inner-loop/.setup-plan-data.json`:

   ```json
   {
     "skill":          "setup-git-integration",
     "generatedAt":    "<ISO>",
     "envUrl":         "<envUrl>",
     "envDisplay":     "<host>",
     "bindingType":    "environment",
     "organization":   "<org>",
     "project":        "<proj>",
     "repository":     "<repo>",
     "branch":         "<branch>",
     "gitFolder":      "<folder>",
     "prereqs":        { ... },
     "repoInitialized": true
   }
   ```

2. Present a textual plan to the user (HTML rendering for inner-loop is deferred to a future milestone; the `plan-inner-loop` status page already covers the visual layer):

   ```
   Binding plan
     Environment: <envUrl>
     Type:        environment-level
     Target:      <org>/<proj>/<repo>  branch <branch>  folder <folder>
     Reverses?    Yes — /power-pages:branch-switch can re-bind to a different branch later,
                  or disconnect-from-git unbinds entirely.
   ```

**Output:** `docs/inner-loop/.setup-plan-data.json` written; textual plan shown to user.

---

## Phase 4 — Approve the Plan

**Goal:** Get explicit plan-approval before any consent prompt; allow the user to revise a field without exiting.

Steps:

1. <!-- gate: setup-git-integration:4.plan | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · setup-git-integration:4.plan):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Bind env `{envHost}` to repo `{org}/{project}/{repo}`, branch `{branch}`, folder `{folder}`? | Binding plan | Yes — proceed to consent (Recommended), Change a field, Cancel |

   - **Change a field** → loop back to Phase 2 step 1 with the existing values pre-populated.
   - **Cancel** → exit; no Dataverse changes have been made yet.

**Output:** Plan approved (or user revising / cancelling).

---

## Phase 5 — Final Consent + Execute

**Goal:** Final consent before any Dataverse mutation, then call `ConnectToGit`.

Steps:

1. <!-- gate: setup-git-integration:5.consent | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · setup-git-integration:5.consent):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Final consent — call `ConnectToGit` on `{envHost}` now? Reversible via /power-pages:branch-switch or disconnect-from-git. | Final consent | Connect now, Cancel |

2. On **Connect now**:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/connect-to-git.js" \
       --envUrl       "<envUrl>" \
       --organization "<org>" \
       --project      "<proj>" \
       --repository   "<repo>" \
       --branch       "<branch>" \
       --gitFolder    "<folder>"
   ```

   - `error` present → surface the error; present recovery options (most common: 400 = repo not initialized despite Phase 2 check; 401/403 = ADO auth scope; 5xx = transient — retry once).
   - `bound: true` → proceed.
   - `bound: true, isAsyncStillSyncing: true` → the HTTP call timed out but the helper auto-verified that the bind committed server-side via `solutions.enabledforsourcecontrolintegration`. The initial-sync plugin is still running. **Tell the user this verbatim and do NOT treat it as a failure.** Proceed to Phase 6, and in Phase 8 poll `sourcecontrolsyncstatus` until it reaches `3` (Synced). See `references/inner-loop-empirical-findings.md` §4.

   > ⏱ **Expected duration.** The HTTP request often times out around 2 min, but `ConnectToGit` typically takes **5-15 min total** because Dataverse runs the `SourceControlInitialSyncPlugin` async op which **serializes every component in the solution and creates an initial commit** automatically (`references/inner-loop-empirical-findings.md` §3). This is normal — do not retry on timeout without first running the post-verify query above.

**Output:** `ConnectToGit` returned success; env is now bound.

---

## Phase 6 — Verify Binding Round-trips

**Goal:** Re-query Dataverse to confirm the bind landed and capture the canonical field values for the manifest.

Steps:

1. ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-git-binding.js" --envUrl "<envUrl>"
   ```

   Expected: `bound === true`, `bindingType === 'env'`, all fields match what we sent.

2. If any field differs (e.g. branch came back as `refs/heads/main` instead of `main`), record the canonical Dataverse-reported value — that's what the manifest must store, NOT what the user typed.

**Output:** Round-trip verified; canonical field values captured.

---

## Phase 7 — Write `.git-integration-manifest.json`

**Goal:** Persist the load-bearing manifest at the project root + the skill-run marker in `docs/inner-loop/`.

Steps:

1. Write to the **project root** (not `docs/inner-loop/`):

   ```json
   {
     "bindingType":      "environment",
     "envUrl":           "<envUrl>",
     "envBapId":         "<env GUID, when known>",
     "organization":     "<canonical>",
     "project":          "<canonical>",
     "repository":       "<canonical>",
     "branch":           "<canonical>",
     "gitFolder":        "<canonical>",
     "boundAt":          "<ISO>",
     "lastVerifiedAt":   "<ISO>",
     "lastCommitSha":    null,
     "manifestVersion":  "1"
   }
   ```

2. Also write `docs/inner-loop/last-setup.json` (skill-run marker):

   ```json
   {
     "skill":     "setup-git-integration",
     "boundAt":   "<ISO>",
     "envUrl":    "<envUrl>",
     "binding":   { ...same fields as manifest... },
     "status":    "succeeded"
   }
   ```

   The marker path is registered in `scripts/lib/inner-loop-paths.js` under the key `lastSetup`.

**Output:** `.git-integration-manifest.json` (project root) + `docs/inner-loop/last-setup.json` written.

---

## Phase 8 — Wait for Component Staging, Show Where Files Land, Final Gate

**Goal:** Wait for the post-bind component-staging plugin to finish, count the now-staged pending Changes, print the ADO browse URL so the user can SEE the folder (initially almost-empty), route the user to `commit-to-git` (which pushes the staged components as the real initial commit), and record skill usage.

> ⚠️ **Earlier docs incorrectly claimed Connect-to-Git auto-pushes all components.** It does not. `ConnectToGit` only writes a placeholder `Readme.md` commit at `<rootFolder>/<gitFolder>/` and stages every solution component into the `sourcecontrolcomponent` Dataverse entity with `iscommitted=false`. The user MUST then run `/power-pages:commit-to-git` to push them. See `references/inner-loop-empirical-findings.md` §3 + §10.

Steps:

1. **Poll for component-staging completion.** `ConnectToGit` fires the `SourceControlInitialSyncPlugin` async op, which enumerates every component into `sourcecontrolcomponent` (but does NOT push them). Poll the solutions endpoint every 15 s, up to 30 attempts (≈ 7.5 min — large solutions may need more):

   ```bash
   GET <envUrl>/api/data/v9.2/solutions
     ?$select=uniquename,enabledforsourcecontrolintegration,sourcecontrolsyncstatus,solutionid
     &$filter=enabledforsourcecontrolintegration eq true
   ```

   Wait until `sourcecontrolsyncstatus == 3` (Synced = staging finished) for every newly-bound solution. If the poll budget is exhausted, tell the user staging is still running in the background — re-checking via `/power-pages:plan-inner-loop` later will show the final pending-count.

2. **Capture the placeholder commit SHA and count staged components.** Re-query `sourcecontrolbranchconfigurations` and read `branchsyncedcommitid` for each `rootfolderpath` you bound — that's the placeholder Readme commit, not the components. Update the manifest's `lastCommitSha` to that value (it will be overwritten when the user runs `commit-to-git`). Then count staged components per solution:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js" \
       --envUrl "<envUrl>" --solutionUniqueName "<sol>"
   ```

3. **Print the full ADO browse URL** with the `&path=` parameter so the user lands on `<rootFolder>/<gitFolder>/` directly (initially almost-empty — just the placeholder Readme) — not the repo root, which often only shows the pre-existing README and confuses fresh-bind users (`references/inner-loop-empirical-findings.md` §7):

   ```
   https://dev.azure.com/<org>/<project>/_git/<repo>?path=/<rootFolder>/<gitFolder>&version=GB<branch>&_a=contents
   ```

4. <!-- gate: setup-git-integration:8.final | category=final | cancel-leaves=nothing -->
   > 🚦 **Gate (final · setup-git-integration:8.final):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Binding complete — folder `solutions/{gitFolder}/` was seeded with a placeholder Readme (commit `{shortSha}`). **{pendingCount}** components are now staged as pending Changes. Push them as the real initial commit? | Initial commit pending | Run /power-pages:commit-to-git now (Recommended), Run /power-pages:sync-from-git first (only if the branch had pre-existing content), Review staged Changes in the maker portal, Exit — I will commit later |

   > 💡 **Why is `commit-to-git` the default?** Connect-to-Git only seeds the folder; staged components stay pending until the user explicitly commits them. Skipping this step leaves the repo with only the placeholder Readme. See `references/inner-loop-empirical-findings.md` §3.

   > ℹ️ **About the placeholder commit you'll see in ADO:** the `Creating new project folder solutions/<gitFolder>` commit is a one-time bookkeeping commit created by ConnectToGit. It is permanent in the branch history. Your next `/power-pages:commit-to-git` will add **one additional commit** on top of it (CommitToGit is strictly 1-call → 1-commit; it does NOT split into batches). See `references/inner-loop-empirical-findings.md` §12.

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "SetupGitIntegration"`.

**Output:** User routed to next action; skill counter incremented.

---

## Artifacts Written

| File | Location | Purpose |
|---|---|---|
| `.git-integration-manifest.json` | project root | Source of truth for binding type / repo / branch / folder; read by every other inner-loop skill's Phase 1. |
| `last-setup.json` | `docs/inner-loop/` | Skill-run marker validated by `validate-setup-git-integration.js`. |

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Gather ADO repo coordinates | Gathering binding fields | Collect org / project / repo / branch / folder via `AskUserQuestion`; validate non-empty, no slashes |
| Verify ADO repo is initialized | Verifying repo init | Call `verify-repo-initialized.js`; offer README-commit flow when empty |
| Render and review binding plan | Rendering binding plan | Compose `.setup-plan-data.json`; show textual preview |
| Final consent before bind | Awaiting bind consent | Surface explicit consent gate before any Dataverse mutation |
| Execute `ConnectToGit` | Executing ConnectToGit | Call `connect-to-git.js` helper; surface platform errors |
| Verify binding round-trips | Verifying binding | Re-query `detect-git-binding.js`; capture canonical Dataverse-reported field values |
| Write `.git-integration-manifest.json` | Writing manifest | Persist manifest at project root + skill-run marker at `docs/inner-loop/last-setup.json` |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: Prereq failure (Managed Env / sys-admin / ADO PAT scope) → open remediation URLs or cancel (gate `setup-git-integration:1.prereq-fail`).
2. **Phase 1**: Already-bound check → disconnect-and-rebind or cancel (no marker — conversational).
3. **Phase 2**: ADO repo coordinates (data-gathering, not a gate).
4. **Phase 2**: Empty repo detected → initialize with README commit, do it manually, or cancel (gate `setup-git-integration:2.repo-init`).
5. **Phase 4**: Approve the binding plan (gate `setup-git-integration:4.plan`).
6. **Phase 5**: Final consent before `ConnectToGit` (gate `setup-git-integration:5.consent`).
7. **Phase 8**: Choose next action — `sync-from-git`, `commit-to-git`, or exit (gate `setup-git-integration:8.final`).

---

## Error Handling

- **`ConnectToGit` returns 400 with "repo not initialized"**: Phase 2's verify-repo-initialized check passed but the platform rejected the bind. The repo may have been re-emptied between Phase 2 and Phase 5. Surface the error and offer to re-run Phase 2.
- **`ConnectToGit` returns 401 / 403**: ADO PAT lacks `Code (read & write)` scope on the target repo. Surface the remediation from `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md`.
- **`ConnectToGit` returns 5xx**: transient — retry once. If second attempt fails, surface verbatim and stop; no manifest is written.
- **Phase 6 reports drift between sent values and Dataverse-reported values**: write the canonical values into the manifest. This is normal for branch (`main` vs `refs/heads/main`) and is not an error.
- **Manifest write fails** (permission / full disk): hard stop after `ConnectToGit` already succeeded — surface the error AND the canonical binding fields so the user can write the manifest manually.

---

**Begin with Phase 1: Prereq Check**
