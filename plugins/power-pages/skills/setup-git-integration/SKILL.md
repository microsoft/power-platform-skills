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

The skill verifies prerequisites (Managed Env on, system-admin role, ADO Contributor on the repo, repo initialized — auto-init if empty), collects the binding fields, gets explicit consent, calls `ConnectToGit`, verifies the binding round-trips via `detect-git-binding`, and writes the load-bearing `.git-integration-manifest.json` that every other inner-loop skill reads in its Phase 1.

**References:**
- `${CLAUDE_PLUGIN_ROOT}/references/binding-strategy.md` (env vs solution binding tradeoffs)
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-prerequisites.md`
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-api-patterns.md` §1-§3 (`ConnectToGit` payload + `ConnectionType` values)

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and `az login` is current
- **`az` must be signed in to the same Microsoft Entra tenant that backs the target ADO organization.** This skill auto-acquires an ADO-scoped bearer token from `az` for the well-known ADO Entra app (`499b84ac-1321-427f-aa17-267ca6975798`) and uses it for the read-only pre-checks; **no PAT is needed**. Cross-tenant scenarios are not supported by this skill — use `/power-pages:connect-solution-to-git` (which still accepts `--token <PAT>`) for those.
- **Recommended:** Managed Environment ON for the target env (HAR-confirmed 2026-06: solution-binding works on Basic envs in practice, but env-binding via `ConnectionType=1` has not been verified without Managed Env — treat as still required for env-binding until proven otherwise; see `references/inner-loop-empirical-findings.md` §1)
- The signed-in user holds the system-administrator role on the target env
- The signed-in user has **Contribute** on the target ADO repo (needed for both the auto-init pre-check and the eventual `ConnectToGit` initial-sync commit).
- The target ADO repo exists. If it is empty (no default branch / no commits), this skill will offer to create the first README commit for you in Phase 2 step 2 — no need to bootstrap it manually.

**Initial request:** $ARGUMENTS

---

## Phase 1 — Prereq Check

**Goal:** Hard-gate every Connect-to-Git prerequisite — auth, existing-binding state, Managed Env, and ADO permissions — before doing any work.

**Do NOT create tasks yet.** Use natural-language progress reporting only during this phase.

Steps:

0. **Acquire an ADO Entra bearer token (`adoToken`).** Mint a tenant-scoped OAuth token for the ADO Entra app and cache it as `adoToken` for downstream pre-checks. This is the silent replacement for the old PAT prompt — the user is **never** asked for a PAT.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/get-ado-token.js"
   ```

   Capture `.token` as `adoToken`. **Never echo it to the user, never write it to disk, never include it in any prompt.** On `ok:false`:
   - The most common cause is `az login` is missing or stale. Surface the error verbatim (it already contains the actionable hint) and stop. No further steps run.

   > 🔒 Tenant verification against the target ADO org happens in **Phase 2 step 1** (once we know the org name) — not here.

1. Verify PAC CLI + Azure CLI are authenticated:

   ```bash
   pac env who --json
   az account get-access-token --resource <envUrl> --query expiresOn -o tsv
   ```

   Both must succeed. If either fails, surface the failure verbatim and stop.

2. Already-bound check — run `detect-git-binding.js`. If `bound === true`, this env is already wired to a repo. Surface the existing binding (org / project / repo / branch) and ask whether the user wants to:
   - Disconnect first and re-bind here (call `/power-pages:branch-switch` for an in-place change, or run `disconnect-from-git.js` for a full unbind), OR
   - Cancel this skill (current binding is fine).

3. Verify Managed Environment + ADO permissions in parallel. ADO permissions now always run with `--token "<adoToken>"` (acquired in step 0) — there is no "no PAT supplied" branch.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-managed-env.js" --envUrl "<envUrl>"
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-ado-permissions.js" \
       --organization "<adoOrg>" --project "<adoProject>" --repository "<adoRepo>" --token "<adoToken>"
   ```

   Classification rules:
   - **Hard-block** on PAC CLI / Az CLI auth failure (no recovery within this skill).
   - **Hard-block** on a clearly malformed `verify-managed-env` response (HTTP/network error). A successful 200 returning `enabled:false` is NOT a hard-block (see warn-not-block below).
   - **Warn** on `verify-managed-env` returning `enabled:false`. Microsoft Learn lists Managed Env as required, but env-level binding behavior without Managed Env has not been fully characterized. Solution-level binding empirically works on Basic envs (see `references/inner-loop-empirical-findings.md` §1) — if the user knows that, they may want to switch to `/power-pages:connect-solution-to-git`.
   - **Hard-block** on any ADO permissions failure. `adoToken` is always present, so a failure means a real Contribute / repo / project issue worth surfacing.

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

1. Select ADO org (enumerated)
2. Select ADO project (enumerated, create if needed)
3. Select ADO repo (enumerated, create if needed)
4. Pick branch + select / name folder (with folder-format warning)
5. Verify ADO repo is initialized
6. Render and review binding plan
7. Final consent before bind
8. Execute `ConnectToGit`
9. Verify binding round-trips
10. Write `.git-integration-manifest.json`

Steps:

1. **Cascading selection of ADO coordinates (org → project → repo → folder).** Each level lists what already exists in ADO and offers a "Create new" option; the user picks (or creates) one before the next prompt fires. Branch is collected as free text between repo and folder (a typed default of `main` is universally fine and listing branches before the bind is rarely useful).

   This replaces the older free-text gather. Rationale: every typo in this phase costs the user a `ConnectToGit` 400 at Phase 5, which is the most-irreversible point. Enumerating the real ADO objects eliminates the typo surface entirely. Free-text fallback is still available via the "Create new" option at each level.

   > 💡 The four list/create helpers below all consume the same `<adoToken>` minted by Phase 1 step 0 (and re-verified for tenant alignment in sub-step 1a). No additional auth prompts.

   **Sub-step 1a — Select organization.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-ado-orgs.js" --token "<adoToken>"
   ```

   - `ok:true, orgs:[…]` (one or more) → render the orgs as a table (columns: `#`, `accountName`, `accountUri`) and surface:

     <!-- not-a-gate: setup-git-integration:2.select-org — data-gathering for ADO organization -->
     `setup-git-integration:2.select-org` (not-a-gate) — select an organization. Options: each org by `accountName`, plus `Create new (opens browser — orgs cannot be created via API)`.

     - If user picks an org → set `<org>` to its `accountName`.
     - If user picks **Create new** → surface the hint *"Azure DevOps orgs can only be created via the web. Visit https://aex.dev.azure.com/go/signup, sign in with the same identity `az login` is using, finish the wizard, then re-run `/power-pages:setup-git-integration`."* and exit cleanly. (No Dataverse mutation has happened yet.)

   - `ok:true, orgs:[]` (the user is signed in but has no orgs) → surface the "Create new" hint above and exit cleanly.
   - `ok:false` → surface the helper's `error` + `hint` verbatim and stop.

   **Tenant cross-check.** Now that `<org>` is known, re-mint the bearer token with tenant verification turned on:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/get-ado-token.js" --verifyTenant --organization "<org>"
   ```

   - `ok:true, tenantMismatch:false` (the common case, including the soft-skip path where the org tenant could not be extracted from `connectionData`) → refresh `adoToken` with the newly returned `.token` and continue to sub-step 1b.
   - `ok:true, tenantMismatch:true` → **hard-block** with the helper's `hint` (it contains the exact `az login --tenant <guid>` command). Do not proceed; cross-tenant binding is not supported by this skill.
   - `ok:false` → surface the error verbatim and stop.

   **Sub-step 1b — Select project.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-ado-projects.js" --organization "<org>" --token "<adoToken>"
   ```

   - `ok:true, projects:[…]` → render the projects as a table (columns: `#`, `name`, `state`, `visibility`) and surface:

     <!-- not-a-gate: setup-git-integration:2.select-project — data-gathering for ADO project -->
     `setup-git-integration:2.select-project` (not-a-gate) — select a project. Options: each project by `name`, plus `Create new`.

     - If user picks an existing project → set `<proj>` and `<projectId>` (capture the GUID from the helper output; needed by `create-ado-repo.js` later if a new repo is created).
     - If user picks **Create new** → prompt for the new project name (data-gathering AskUserQuestion, validate non-empty + no `/`/`\`), then surface a consent gate before the destructive create:

       <!-- gate: setup-git-integration:2.create-project | category=consent | cancel-leaves=nothing -->
       > 🚦 **Gate (consent · setup-git-integration:2.create-project):** Surface `AskUserQuestion`:

       | Question | Header | Options |
       |---|---|---|
       | Create new ADO project `{newProjectName}` in org `{org}`? This is provisioned via `POST /_apis/projects` and takes ~30-60 s. | Create project | Create now (Recommended), Cancel — go back to project selection |

       On **Create now**:
       ```bash
       node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/create-ado-project.js" \
           --organization "<org>" --name "<newProjectName>" --token "<adoToken>"
       ```
       On `ok:true, projectId` → set `<proj>` = `<newProjectName>`, capture `<projectId>`, continue. On `ok:false` → surface `error` + `hint` and re-prompt at sub-step 1b (don't fail the whole skill).

   - `ok:true, projects:[]` → no projects in the org. Skip directly to the **Create new** branch above.
   - `ok:false` → surface the helper's `error` + `hint` verbatim and stop.

   **Sub-step 1c — Select repository.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-ado-repos.js" --organization "<org>" --project "<proj>" --token "<adoToken>"
   ```

   - `ok:true, repos:[…]` → render the repos as a table (columns: `#`, `name`, `defaultBranch`, `size`). Annotate each row: rows with `defaultBranch === null` are empty (this skill's Phase 2 step 2 will offer to auto-init them; this is friendly, NOT a blocker). Then surface:

     <!-- not-a-gate: setup-git-integration:2.select-repo — data-gathering for ADO repository -->
     `setup-git-integration:2.select-repo` (not-a-gate) — select a repository. Options: each repo by `name` (annotated `(empty)` where `defaultBranch === null`), plus `Create new`.

     - If user picks an existing repo → set `<repo>` and capture its `defaultBranch` for use as the branch default in sub-step 1d.
     - If user picks **Create new** → prompt for the new repo name (data-gathering AskUserQuestion, validate non-empty + no `/`/`\`), then surface a consent gate:

       <!-- gate: setup-git-integration:2.create-repo | category=consent | cancel-leaves=nothing -->
       > 🚦 **Gate (consent · setup-git-integration:2.create-repo):** Surface `AskUserQuestion`:

       | Question | Header | Options |
       |---|---|---|
       | Create new git repo `{newRepoName}` in project `{org}/{proj}`? This is synchronous (~1 s) and the new repo starts empty (no default branch). Phase 2 step 2 will then auto-init it with a README commit. | Create repo | Create now (Recommended), Cancel — go back to repo selection |

       On **Create now**:
       ```bash
       node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/create-ado-repo.js" \
           --organization "<org>" --project "<proj>" --projectId "<projectId>" \
           --name "<newRepoName>" --token "<adoToken>"
       ```
       On `ok:true, repoId` → set `<repo>` = `<newRepoName>`. The new repo is empty, so Phase 2 step 2 will auto-init it with a README commit (no user action needed beyond accepting the init consent gate). On `ok:false, statusCode:409` → name conflict; surface hint and re-prompt at sub-step 1c. On other `ok:false` → surface `error` + `hint` and stop.

   - `ok:true, repos:[]` → no repos in the project. Skip directly to the **Create new** branch above.
   - `ok:false` → surface the helper's `error` + `hint` verbatim and stop.

   **Sub-step 1d — Collect branch (free-text).**

   <!-- not-a-gate: setup-git-integration:2.branch — data-gathering for branch name -->
   `setup-git-integration:2.branch` (not-a-gate) — branch name. Default: the existing repo's `defaultBranch` (stripped of any `refs/heads/` prefix) if non-null, else `main`. Validate non-empty.

   **Sub-step 1e — Select folder-in-repo (the `gitFolder`).**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-ado-folders.js" \
       --organization "<org>" --project "<proj>" --repository "<repo>" --token "<adoToken>"
   ```

   The helper enumerates top-level folders in the repo so the user can SEE what's already there and avoid colliding with unrelated content. On `ok:true, emptyRepo:true` the folder list is empty (the repo has no commits yet — Phase 2 step 2 will init it). On `ok:true, folders:[…]` non-empty, render the folders as a table (columns: `#`, `path`, `gitObjectType`).

   > ⚠️ **CRITICAL — folder name format (read this BEFORE prompting for the folder value).** The Dataverse `ConnectToGit` action validates the folder name **strictly** and rejects anything that looks path-like with HTTP 400, error code `0x80040265` *("The folder name 'solutions/' is invalid.")*. The validation failure fires at Phase 5 (the most expensive step, after every prior consent gate), so we MUST prevent the mistake at the prompt itself.
   >
   > When presenting the `folder-in-repo` field, the prompt's helper-text / placeholder MUST explicitly say:
   >
   > - **Accepted:** a plain folder name like `solutions`, `Power Pages`, `src`, `my-bound-folder`.
   > - **Rejected:** anything containing `/`, `\`, leading or trailing slashes (e.g. `solutions/`, `/solutions`, `solutions/sub`), or whitespace-only.
   > - **Default to suggest:** `solutions` (NOT `solutions/` — the trailing slash is the common typo this warning exists to prevent).
   > - **One-line summary in the prompt:** *"Folder name only — no slashes, no path separators. Type `solutions`, NOT `solutions/`."*

   <!-- not-a-gate: setup-git-integration:2.select-folder — data-gathering for ADO folder-in-repo -->
   `setup-git-integration:2.select-folder` (not-a-gate) — select or name the folder. Options:
   - Each existing folder by `path` (strip the leading `/` from the helper output before displaying so the value matches what `ConnectToGit` expects).
   - `Type a new folder name (Recommended — default: solutions)`.

   - If user picks an existing folder → confirm with a one-question gate (since picking an existing non-empty folder co-locates Dataverse-managed files with whatever's already there — likely fine, occasionally not):

     <!-- gate: setup-git-integration:2.folder-coexists | category=consent | cancel-leaves=nothing -->
     > 🚦 **Gate (consent · setup-git-integration:2.folder-coexists):** Surface `AskUserQuestion`:

     | Question | Header | Options |
     |---|---|---|
     | Folder `/{folder}/` already exists in `{repo}` and contains content. Dataverse will write its solution files into the same folder. Continue with this folder, or pick a different one? | Existing folder | Use this folder (Recommended if it's a previous solutions folder), Go back and pick another |

   - If user picks **Type a new folder name** → data-gathering AskUserQuestion with the warning above. Validate: non-empty, no `/` or `\`, no leading or trailing whitespace.

   Validate the final value:
   - Folder: non-empty; leading `/` stripped (defensive — the user shouldn't have typed one given the warning, but the helper output starts with `/` and we strip it when displaying). **Per the warning above, the user should be guided NOT to type a trailing slash in the first place** (this skill intentionally does NOT silently sanitize trailing slashes — see the rationale in `references/inner-loop-empirical-findings.md` §5 / mentor directive).

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
     | The ADO repo `{org}/{project}/{repo}` is empty. Initialize it now with a single README commit on `{branch}` so `ConnectToGit` can bind cleanly? | Repo initialization | Initialize now (Recommended), Cancel |

     - **Initialize now** → push a stub `README.md` on the chosen branch via the ADO Git Pushes REST API:

       ```bash
       node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/init-ado-repo.js" \
           --organization "<org>" --project "<proj>" --repository "<repo>" \
           --branch "<branch>" --token "<adoToken>"
       ```

       - `ok:true, initialized:true` (or `alreadyInitialized:true` — re-running the gate is safe) → continue to Phase 3.
       - `ok:false, statusCode:403` → surface the helper's `hint` ("Your account lacks Contribute on this repo. Ask the project admin to grant the Contributors group write access on `<org>/<proj>/<repo>`, then re-run.") and stop. Cannot auto-fix; this is an ADO permission grant only the project admin can make.
       - `ok:false, statusCode:404` → surface the helper's `hint` ("Repository `<org>/<proj>/<repo>` not found...") and stop. Most often a typo in one of the 5 free-text fields; the user should re-run the skill and double-check the field values.
       - `ok:false` (other) → surface the helper's `error` + `hint` verbatim and stop. No Dataverse mutation has happened yet.

     - **Cancel** → exit cleanly. No Dataverse changes have been made. The user can manually initialize the repo (e.g. via the ADO portal "Initialize" button) and re-run this skill.

**Output:** All 5 fields validated; tenant alignment confirmed; target repo confirmed initialized (or just-initialized by `init-ado-repo.js`).

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
| Select ADO org | Selecting organization | Call `list-ado-orgs.js`; user picks from enumerated list or hits "Create new" (browser-only) |
| Verify tenant alignment | Verifying tenant alignment | Re-mint bearer with `get-ado-token.js --verifyTenant --organization <org>`; hard-block on mismatch |
| Select ADO project | Selecting project | Call `list-ado-projects.js`; user picks or creates via `create-ado-project.js` (consent + ~30-60 s poll) |
| Select ADO repo | Selecting repository | Call `list-ado-repos.js`; user picks or creates via `create-ado-repo.js` (consent + synchronous) |
| Collect branch | Collecting branch | Free-text AskUserQuestion; default = repo's `defaultBranch` (stripped of `refs/heads/`) or `main` |
| Select / name folder | Selecting folder-in-repo | Call `list-ado-folders.js`; user picks an existing folder (with co-exists gate) or types a new one (with format warning) |
| Verify ADO repo is initialized | Verifying repo init | Call `verify-repo-initialized.js`; offer README-commit flow when empty |
| Render and review binding plan | Rendering binding plan | Compose `.setup-plan-data.json`; show textual preview |
| Final consent before bind | Awaiting bind consent | Surface explicit consent gate before any Dataverse mutation |
| Execute `ConnectToGit` | Executing ConnectToGit | Call `connect-to-git.js` helper; surface platform errors |
| Verify binding round-trips | Verifying binding | Re-query `detect-git-binding.js`; capture canonical Dataverse-reported field values |
| Write `.git-integration-manifest.json` | Writing manifest | Persist manifest at project root + skill-run marker at `docs/inner-loop/last-setup.json` |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: Prereq failure (Managed Env / sys-admin / ADO Contributor) → open remediation URLs or cancel (gate `setup-git-integration:1.prereq-fail`).
2. **Phase 1**: Already-bound check → disconnect-and-rebind or cancel (no marker — conversational).
3. **Phase 2 sub-step 1a**: Select ADO org from enumerated list, or "Create new" (browser hint + clean exit) (data-gathering `setup-git-integration:2.select-org`).
4. **Phase 2 sub-step 1b**: Select ADO project, or "Create new" (data-gathering `setup-git-integration:2.select-project` + consent gate `setup-git-integration:2.create-project` when creating).
5. **Phase 2 sub-step 1c**: Select ADO repo, or "Create new" (data-gathering `setup-git-integration:2.select-repo` + consent gate `setup-git-integration:2.create-repo` when creating).
6. **Phase 2 sub-step 1d**: Collect branch (data-gathering, not a gate).
7. **Phase 2 sub-step 1e**: Select folder (existing → confirm co-exists via gate `setup-git-integration:2.folder-coexists`; or "Type new" with the format warning) (data-gathering `setup-git-integration:2.select-folder`).
8. **Phase 2 step 2**: Empty repo detected → initialize automatically with a README commit, or cancel (gate `setup-git-integration:2.repo-init`).
9. **Phase 4**: Approve the binding plan (gate `setup-git-integration:4.plan`).
10. **Phase 5**: Final consent before `ConnectToGit` (gate `setup-git-integration:5.consent`).
11. **Phase 8**: Choose next action — `sync-from-git`, `commit-to-git`, or exit (gate `setup-git-integration:8.final`).

---

## Error Handling

- **`ConnectToGit` returns 400 with "repo not initialized"**: Phase 2's verify-repo-initialized check passed but the platform rejected the bind. The repo may have been re-emptied between Phase 2 and Phase 5. Surface the error and offer to re-run Phase 2.
- **`ConnectToGit` returns 401 / 403**: the tenant Entra OAuth grant on the target ADO org is missing or revoked. `ConnectToGit` itself does NOT use the bearer token this skill mints for pre-checks — server-side it uses the tenant-level "Authorize ADO" grant configured once per tenant via the maker portal. Surface the remediation from `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md` (typically: ask a tenant admin to re-authorize the ADO connection in the maker portal, then re-run).
- **`ConnectToGit` returns 5xx**: transient — retry once. If second attempt fails, surface verbatim and stop; no manifest is written.
- **Phase 6 reports drift between sent values and Dataverse-reported values**: write the canonical values into the manifest. This is normal for branch (`main` vs `refs/heads/main`) and is not an error.
- **Manifest write fails** (permission / full disk): hard stop after `ConnectToGit` already succeeded — surface the error AND the canonical binding fields so the user can write the manifest manually.

---

**Begin with Phase 1: Prereq Check**
