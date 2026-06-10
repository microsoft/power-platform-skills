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

3. Verify Managed Environment.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-managed-env.js" --envUrl "<envUrl>"
   ```

   Classification rules:
   - **Hard-block** on PAC CLI / Az CLI auth failure (no recovery within this skill).
   - **Hard-block** on a clearly malformed `verify-managed-env` response (HTTP/network error). A successful 200 returning `enabled:false` is NOT a hard-block (see warn-not-block below).
   - **Warn** on `verify-managed-env` returning `enabled:false`. Microsoft Learn lists Managed Env as required, but env-level binding behavior without Managed Env has not been fully characterized. Solution-level binding empirically works on Basic envs (see `references/inner-loop-empirical-findings.md` §1) — if the user knows that, they may want to switch to `/power-pages:connect-solution-to-git`.

   > ℹ️ **ADO permissions are NOT verified here.** Under the cascading-discovery design (Phase 2 sub-steps 1a / 1b / 1c), the `<org>` / `<proj>` / `<repo>` values are unknown at Phase 1 time — the user picks them later. The `verify-ado-permissions.js` call runs in **Phase 2 sub-step 1c.5** (immediately after the repo is picked, before the branch / folder sub-steps), where all three flags have real values. **Bug fixed 2026-06:** earlier revisions of this step inlined a `verify-ado-permissions.js` call with empty `<adoOrg> / <adoProject> / <adoRepo>` placeholders; that only worked by accident when `detect-git-binding` short-circuited Phase 2 entirely (already-bound env), and would have failed silently or hard-erred on a fresh-bind env.

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

   **Sub-step 1c.5 — Verify ADO permissions on the picked repo.**

   This is the first moment all three flags (`<org>` / `<proj>` / `<repo>`) have real values, so it's the earliest valid place to verify the user has Contribute on the target. Moved here from Phase 1 step 3 (see the rationale note in that step).

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-ado-permissions.js" \
       --organization "<org>" --project "<proj>" --repository "<repo>" --token "<adoToken>"
   ```

   - `ok:true, hasAccess:true` → continue to sub-step 1d.
   - **Hard-block** on any failure (`ok:false` or `hasAccess:false`). `adoToken` is always present (acquired in Phase 1 step 0), so a failure means a real Contribute / repo / project issue worth surfacing. Surface the helper's `error` + `hint` verbatim and present:

     <!-- gate: setup-git-integration:2.ado-perms-fail | category=intent | cancel-leaves=nothing -->
     > 🚦 **Gate (intent · setup-git-integration:2.ado-perms-fail):** When the permissions check fails, surface `AskUserQuestion`:

     | Question | Header | Options |
     |---|---|---|
     | ADO permissions check failed on `{org}/{proj}/{repo}` (`{shortError}`). How would you like to proceed? | ADO permissions failure | Pick a different repo (back to sub-step 1c), Cancel and fix permissions manually |

     - **Pick a different repo** → loop back to sub-step 1c with the existing `<org>` + `<proj>` preserved (re-running 1a / 1b is unnecessary; only the repo choice was wrong).
     - **Cancel and fix permissions manually** → exit cleanly; no Dataverse mutation has happened yet.

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

## Phase 8 — Verify Post-Bind State (branches on `bindingType`)

**Goal:** Confirm the placeholder bookkeeping commit landed; for solution-binding wait for component staging; for env-binding skip the per-solution wait (env-binding never stages components automatically — it's opt-in per solution, handled in Phase 9). Print the ADO browse URL so the user can see what was bound. Do NOT render any final gate here — control passes to Phase 9 (env-bind) or Phase 11 (solution-bind).

> ⚠️ **Earlier docs incorrectly claimed Connect-to-Git auto-pushes all components for env-binding.** It does not. For `ConnectionType=1` (environment) the action only writes a placeholder `Readme.md` commit at `<rootFolder>/<gitFolder>/`; it does NOT flip `enabledforsourcecontrolintegration` on any solution and does NOT create any `sourcecontrolcomponent` rows. The opt-in per solution is what Phase 9 handles. For `ConnectionType=0` (solution) the existing per-solution staging flow applies. See `references/inner-loop-empirical-findings.md` §3 + §10.

### Step 1 — Branch on `bindingType`

Read `bindingType` from the in-flight binding state (the field captured in Phase 6 / written to `.git-integration-manifest.json` in Phase 7).

- **`bindingType === "solution"`** → execute step 2 below (per-solution staging poll), then step 3 (browse URL), then go to Phase 11 directly (Phase 9 + Phase 10 are env-only and are skipped).
- **`bindingType === "environment"`** → SKIP step 2 entirely. Run a single verification probe that the placeholder commit landed (read `sourcecontrolbranchconfigurations.branchsyncedcommitid` for the env-level row — non-null means the post-bind `SourceControlInitialSyncPlugin` finished its env-level work). Then run step 3 (browse URL), then continue to **Phase 9** (NOT Phase 11). Report explicitly to the user: *"Env binding complete. 0 solutions staged — solutions are opt-in. Continuing to solution discovery..."*

### Step 2 — Per-solution staging poll (solution-binding only)

For `bindingType === "solution"`, poll the solutions endpoint every 15 s, up to 30 attempts (≈ 7.5 min — large solutions may need more):

```bash
GET <envUrl>/api/data/v9.2/solutions
  ?$select=uniquename,enabledforsourcecontrolintegration,sourcecontrolsyncstatus,solutionid
  &$filter=enabledforsourcecontrolintegration eq true and solutionid eq <boundSolutionId>
```

Wait until `sourcecontrolsyncstatus == 3` (Synced = staging finished) for the bound solution. If the poll budget is exhausted, tell the user staging is still running in the background — re-checking via `/power-pages:plan-inner-loop` later will show the final pending-count.

> 💡 **Why not run this poll for env-binding?** For `ConnectionType=1` there is nothing to wait for — env-binding does not flip `enabledforsourcecontrolintegration` on any solution. The poll's filter (`enabledforsourcecontrolintegration eq true`) returns an empty set permanently, so the convergence check (`every row has sourcecontrolsyncstatus == 3`) would never fail OR succeed — it would simply run 30 × 15 s = 7.5 min and timeout pointlessly. Bug 3 fixed 2026-06: branch on `bindingType` instead.

### Step 3 — Print the ADO browse URL

Print the full ADO browse URL with the `&path=` parameter so the user lands on `<rootFolder>/<gitFolder>/` directly (initially almost-empty — just the placeholder Readme) — not the repo root, which often only shows the pre-existing README and confuses fresh-bind users (`references/inner-loop-empirical-findings.md` §7):

```
https://dev.azure.com/<org>/<project>/_git/<repo>?path=/<rootFolder>/<gitFolder>&version=GB<branch>&_a=contents
```

**Output (solution-binding):** Component staging confirmed; placeholder commit verified; browse URL shown. Proceed to Phase 11.
**Output (env-binding):** Placeholder commit verified; browse URL shown. Proceed to Phase 9 (solutions are opt-in — let's pick the ones to enable).

---

## Phase 9 — Discover & Enable Solutions for Source Control (env-binding only)

**Goal:** After env-binding completes (Phase 8 step 1 branch), the env is wired up but ZERO solutions are bound. This phase lets the user enable one or more solutions in a single guided flow, without having to use the maker portal's "Enable for source control" button per solution.

> 🔵 **Skipped for solution-binding.** This phase only runs when `bindingType === "environment"`. For `bindingType === "solution"`, the single bound solution is already enabled at `ConnectToGit` time — skip directly to Phase 11.

### Step 1 — Discover candidate solutions

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/discover-enableable-solutions.js" --envUrl "<envUrl>"
```

The helper queries unmanaged + visible solutions where `enabledforsourcecontrolintegration eq false` and excludes system solutions (by uniquename allowlist and publisher-prefix blocklist).

- `ok:true, count:0, solutions:[]` → no candidate solutions in the env. Surface a note: *"No user-authored unmanaged solutions found that can be enabled. Either all of your solutions are already enabled, or the env only contains system solutions. Continuing to Phase 11."* Then skip to Phase 11.
- `ok:true, count:N, solutions:[…]` → render the solutions as a table (columns: `#`, `uniqueName`, `friendlyName`, `version`, `modifiedOn`, `publisherPrefix`). Continue to Step 2.
- `ok:false` → surface the helper's `error` + `hint` verbatim. Phase 9 fails soft (do NOT abort the whole skill — the env-binding was successful in Phase 5; this is just convenience). Skip to Phase 11 with a note that the user can re-run Phase 9 manually later by invoking `/power-pages:setup-git-integration` again or calling `enable-solution-source-control.js` directly per solution.

### Step 2 — Pick approach gate

<!-- gate: setup-git-integration:9.enable-approach | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-git-integration:9.enable-approach):** Surface `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Found `{count}` unmanaged solutions in `{envUrl}` that can be enabled for source control. Each one will be PATCH'd with `enabledforsourcecontrolintegration:"true"` (HAR-confirmed; this is exactly what the maker portal's "Enable for source control" button does). How do you want to proceed? | Enable solutions | Enable ALL `{count}` solutions now (Recommended for fresh-bind envs), Pick individually (one consent gate per solution), Skip — I will enable solutions later via the maker portal or by re-running this skill |

- **Enable ALL** → loop over every solution in the candidate list; for each, run Step 3.
- **Pick individually** → for each solution in the candidate list, surface a per-solution gate (next sub-step), then run Step 3 only for the consented ones.
- **Skip** → do nothing in Phase 9; skip directly to Phase 11.

For **Pick individually**, the per-solution gate is:

<!-- gate: setup-git-integration:9.enable-solution | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · setup-git-integration:9.enable-solution):** Surface `AskUserQuestion` per candidate:

| Question | Header | Options |
|---|---|---|
| Enable solution `{uniqueName}` (`{friendlyName}` v`{version}`, modified `{modifiedOn}`) for source control? | Per-solution enable | Enable this one, Skip this one |

### Step 3 — Call the enable API per consented solution

For each consented solution, call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/enable-solution-source-control.js" \
    --envUrl "<envUrl>" --solutionId "<solutionId>" --poll
```

The helper PATCHes `solutions(<solutionId>)` with `{"enabledforsourcecontrolintegration":"true"}` (note: string `"true"`, not boolean `true` — Dataverse OData quirk; HAR-confirmed 2026-06). With `--poll`, it then waits for `sourcecontrolsyncstatus === 3` (Synced) — the server-side `SourceControlInitialSyncPlugin` finishes asynchronously, typically in 5-30 s for a small-to-medium solution.

Per-solution outcome handling:
- `ok:true, finalSyncStatus:3` → record success; mark the solution `enabled=true`.
- `ok:true, timedOut:true` → PATCH succeeded but the sync poll exhausted its budget. This is NOT a failure; sync continues server-side. Record `enabled=true, syncPending=true` and continue.
- `ok:false, statusCode:404` → solution was deleted between Step 1 and Step 3. Record skip.
- `ok:false` (other) → surface the helper's `error` + `hint`; record `enabled=false`. Continue with the next solution (don't abort the loop on a single failure).

### Step 4 — Summary table

Render a results table after the loop (columns: `Solution`, `Status` [Enabled / Sync pending / Skipped / Failed], `Notes`). Capture the list of successfully-enabled solutions for Phase 10.

**Output:** A possibly-empty list of solutions now enabled for source control. If the list is empty (all skipped or all failed), skip Phase 10 entirely and go to Phase 11.

---

## Phase 10 — Initial Commits for Enabled Solutions (only when ≥1 solution enabled in Phase 9)

**Goal:** Solutions enabled in Phase 9 now have their components staged as pending `sourcecontrolcomponent` rows but nothing has been pushed to ADO yet. This phase lets the user commit them in one guided flow.

> 🔵 **Skipped when Phase 9 enabled zero solutions** (either because the user picked Skip in Phase 9 step 2, or because every per-solution enable failed). Skip directly to Phase 11.

### Step 1 — Pick commit approach gate

<!-- gate: setup-git-integration:10.commit-approach | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · setup-git-integration:10.commit-approach):** Surface `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| `{enabledCount}` solution(s) were enabled for source control in Phase 9. Each one's components are now staged as pending Changes. Push the initial commit per solution now? | Initial commits | Commit ALL `{enabledCount}` now with a default message (one CommitToGit per solution; Recommended), Commit one-by-one with a custom message per solution, Skip — I will commit later via /power-pages:commit-to-git per solution |

- **Commit ALL** → loop over every enabled solution; for each, call `commit-to-git.js` with a default message (Step 2 below).
- **Commit one-by-one** → for each enabled solution, surface a per-solution gate (sub-step below), then call `commit-to-git.js` only for the consented ones, optionally using a user-supplied message per solution.
- **Skip** → do nothing in Phase 10; skip to Phase 11 with a reminder that `/power-pages:commit-to-git --solutionUniqueName <name>` can be run per solution at any time.

For **Commit one-by-one**, the per-solution gate is:

<!-- gate: setup-git-integration:10.commit-solution | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · setup-git-integration:10.commit-solution):** Surface `AskUserQuestion` per enabled solution:

| Question | Header | Options |
|---|---|---|
| Commit the initial pending Changes for solution `{uniqueName}` now? Default message: `"Initial source-control commit for {uniqueName}"`. | Per-solution commit | Commit now with default message, Commit with custom message (next prompt), Skip this one |

If the user picks **Commit with custom message**, follow up with a `not-a-gate` data-gathering AskUserQuestion to collect the message (validate non-empty, ≤ 250 chars).

### Step 2 — Call CommitToGit per consented solution

For each consented solution:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/commit-to-git.js" \
    --envUrl "<envUrl>" \
    --solutionUniqueName "<uniqueName>" \
    --commitMessage "Initial source-control commit for <uniqueName>"
```

(Override `--commitMessage` with the user-supplied message when one was collected.)

Per-solution outcome handling:
- `committed:true, commitId:"<sha>"` → record success. Note the `polled.reached` flag — if `true` the pending Changes have already cleared; if `false` the post-commit poll timed out (non-fatal — commit landed, the Changes tab just hasn't refreshed yet).
- `statusCode:400` with errorCode `0x80040216` (shared components) → surface the error verbatim; for this skill flow, record failure and skip to next solution. The user can resolve the overlap manually and re-run `/power-pages:commit-to-git` per affected solution.
- `statusCode:400` with errorCode `0x80098015` (conflicts present) → record failure; the env has unresolved conflicts that block the commit. Surface guidance to run `/power-pages:resolve-conflicts` first, then re-run this skill or `/power-pages:commit-to-git` per solution.
- Other failure → surface verbatim; record failure; continue with next solution.

> 💡 **Why call `commit-to-git.js` directly instead of invoking `/power-pages:commit-to-git` as a sub-skill?** The full `/power-pages:commit-to-git` skill runs 5 pre-flight validators (file sizes, supported types, large canvas, PCF duplication, dependencies) plus its own consent gates. For the initial-commit case in Phase 10, the helper-only path is faster (no extra prompts) and the pre-flight risk is low (the solutions were just discovered + enabled in Phase 9; no maker edits have happened yet). Users who want the full pre-flight pipeline can re-run `/power-pages:commit-to-git --solutionUniqueName <name>` later.

### Step 3 — Summary table

Render a results table after the loop (columns: `Solution`, `Commit SHA` [short form] / `Status`, `Notes`).

**Output:** A list of (solution, commit SHA) pairs that landed in ADO. The env is now in the same state it would be in after `/power-pages:setup-git-integration` + N x `/power-pages:connect-solution-to-git` + N x `/power-pages:commit-to-git` — but accomplished in a single guided flow.

---

## Phase 11 — Final Gate

**Goal:** Final user touchpoint after all the binding + enable + commit work is complete.

### Step 1 — Final gate

<!-- gate: setup-git-integration:11.final | category=final | cancel-leaves=nothing -->
> 🚦 **Gate (final · setup-git-integration:11.final):** Surface `AskUserQuestion`. The option set depends on what just ran:

For env-binding where Phase 9 + Phase 10 ran successfully (≥1 solution enabled + ≥1 commit landed):

| Question | Header | Options |
|---|---|---|
| Setup complete — `{commitCount}` initial commit(s) landed in `{branch}`. What next? | Setup complete | Open the ADO branch in browser (path = `solutions/{gitFolder}`), Enable more solutions for source control (re-run Phase 9), Open a PR now (/power-pages:open-pr), Done — exit |

For env-binding where Phase 9 ran but Phase 10 was skipped (or all commits skipped/failed):

| Question | Header | Options |
|---|---|---|
| Setup complete — `{enabledCount}` solution(s) enabled but no initial commits were pushed. What next? | Setup complete | Run /power-pages:commit-to-git per solution (Recommended), Enable more solutions for source control (re-run Phase 9), Open the ADO branch in browser, Done — exit |

For env-binding where Phase 9 enabled zero solutions:

| Question | Header | Options |
|---|---|---|
| Env binding complete — no solutions were enabled for source control yet. What next? | Setup complete | Enable solutions for source control (re-run Phase 9), Open the ADO branch in browser, Done — exit |

For solution-binding (Phases 9 + 10 were skipped):

| Question | Header | Options |
|---|---|---|
| Binding complete — folder `solutions/{gitFolder}/` was seeded with a placeholder Readme (commit `{shortSha}`). **{pendingCount}** components are now staged as pending Changes. Push them as the real initial commit? | Initial commit pending | Run /power-pages:commit-to-git now (Recommended), Run /power-pages:sync-from-git first (only if the branch had pre-existing content), Review staged Changes in the maker portal, Exit — I will commit later |

> 💡 **Why is `commit-to-git` the default for solution-binding?** Connect-to-Git only seeds the folder; staged components stay pending until the user explicitly commits them. Skipping this step leaves the repo with only the placeholder Readme. See `references/inner-loop-empirical-findings.md` §3.

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
| Select ADO org (enumerated) | Selecting ADO organization | Enumerate orgs via `list-ado-orgs.js`; pick one or exit-with-signup hint |
| Select ADO project (enumerated, create if needed) | Selecting ADO project | Enumerate projects via `list-ado-projects.js`; pick one OR create-new via `create-ado-project.js` (with consent gate + poll) |
| Select ADO repo (enumerated, create if needed) | Selecting ADO repo | Enumerate repos via `list-ado-repos.js`; pick one OR create-new via `create-ado-repo.js` (with consent gate) |
| Pick branch + select / name folder | Choosing branch and folder | Free-text branch (default = existing repo's defaultBranch or `main`); enumerate folders via `list-ado-folders.js`; pick existing (with co-exist confirm) OR type new (with strict format warning) |
| Verify ADO repo is initialized | Verifying repo init | Call `verify-repo-initialized.js`; offer README-commit flow via `init-ado-repo.js` when empty |
| Render and review binding plan | Rendering binding plan | Compose `.setup-plan-data.json`; show textual preview |
| Final consent before bind | Awaiting bind consent | Surface explicit consent gate before any Dataverse mutation |
| Execute `ConnectToGit` | Executing ConnectToGit | Call `connect-to-git.js` helper; surface platform errors |
| Verify binding round-trips | Verifying binding | Re-query `detect-git-binding.js`; capture canonical Dataverse-reported field values |
| Write `.git-integration-manifest.json` | Writing manifest | Persist manifest at project root + skill-run marker at `docs/inner-loop/last-setup.json` |
| Verify post-bind state (Phase 8) | Verifying post-bind state | For `bindingType=solution`: poll per-solution sync. For `bindingType=environment`: skip poll, verify placeholder commit, proceed to Phase 9. |
| Discover & enable candidate solutions (Phase 9, env-binding only) | Enabling solutions for source control | Call `discover-enableable-solutions.js`; gate approach (Enable all / Pick / Skip); per-consented solution call `enable-solution-source-control.js --poll` |
| Push initial commits per enabled solution (Phase 10, env-binding only) | Pushing initial commits | Gate commit approach (All / One-by-one / Skip); call `commit-to-git.js --solutionUniqueName` per consented solution |
| Final routing (Phase 11) | Routing to next action | Surface env-binding-aware final gate (open ADO / re-run Phase 9 / open-pr / exit; option set depends on what just ran) |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: Prereq failure (Managed Env / sys-admin / ADO Contributor) → open remediation URLs or cancel (gate `setup-git-integration:1.prereq-fail`).
2. **Phase 1**: Already-bound check → disconnect-and-rebind or cancel (no marker — conversational).
3. **Phase 2 sub-step 1a**: Select ADO org from enumerated list, or exit to web for new-org signup (not-a-gate `setup-git-integration:2.select-org`).
4. **Phase 2 sub-step 1b**: Select ADO project or trigger create-new (not-a-gate `setup-git-integration:2.select-project` → gate `setup-git-integration:2.create-project` on creation).
5. **Phase 2 sub-step 1c**: Select ADO repo or trigger create-new (not-a-gate `setup-git-integration:2.select-repo` → gate `setup-git-integration:2.create-repo` on creation).
6. **Phase 2 sub-step 1c.5**: ADO permissions check fails on picked repo → pick a different repo or cancel (gate `setup-git-integration:2.ado-perms-fail`).
7. **Phase 2 sub-step 1d**: Free-text branch (not-a-gate `setup-git-integration:2.branch`).
8. **Phase 2 sub-step 1e**: Select or name folder (not-a-gate `setup-git-integration:2.select-folder` → gate `setup-git-integration:2.folder-coexists` when an existing folder is picked).
9. **Phase 2 step 2**: Empty repo detected → initialize automatically with a README commit, or cancel (gate `setup-git-integration:2.repo-init`).
10. **Phase 4**: Approve the binding plan (gate `setup-git-integration:4.plan`).
11. **Phase 5**: Final consent before `ConnectToGit` (gate `setup-git-integration:5.consent`).
12. **Phase 8** (env-binding only): Discover candidate solutions → consent-and-enable for source control (gate `setup-git-integration:9.enable-approach` → per-solution gate `setup-git-integration:9.enable-solution`).
13. **Phase 10** (only when ≥1 solution enabled in Phase 9): Choose initial-commit approach (gate `setup-git-integration:10.commit-approach` → per-solution gate `setup-git-integration:10.commit-solution`).
14. **Phase 11**: Final routing — open ADO, re-run Phase 9 to enable more solutions, run `commit-to-git`, or exit (gate `setup-git-integration:11.final`).

---

## Error Handling

- **`ConnectToGit` returns 400 with "repo not initialized"**: Phase 2's verify-repo-initialized check passed but the platform rejected the bind. The repo may have been re-emptied between Phase 2 and Phase 5. Surface the error and offer to re-run Phase 2.
- **`ConnectToGit` returns 401 / 403**: the tenant Entra OAuth grant on the target ADO org is missing or revoked. `ConnectToGit` itself does NOT use the bearer token this skill mints for pre-checks — server-side it uses the tenant-level "Authorize ADO" grant configured once per tenant via the maker portal. Surface the remediation from `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-error-catalog.md` (typically: ask a tenant admin to re-authorize the ADO connection in the maker portal, then re-run).
- **`ConnectToGit` returns 5xx**: transient — retry once. If second attempt fails, surface verbatim and stop; no manifest is written.
- **Phase 6 reports drift between sent values and Dataverse-reported values**: write the canonical values into the manifest. This is normal for branch (`main` vs `refs/heads/main`) and is not an error.
- **Manifest write fails** (permission / full disk): hard stop after `ConnectToGit` already succeeded — surface the error AND the canonical binding fields so the user can write the manifest manually.
- **Phase 9 `enable-solution-source-control.js` returns 404**: solution was deleted between discovery (Phase 9 step 1) and enable (step 3). Record skip; continue with next solution.
- **Phase 9 `enable-solution-source-control.js` returns `ok:true, timedOut:true`**: the PATCH succeeded but the server-side `SourceControlInitialSyncPlugin` is still running after the poll budget (~2 min). NOT a failure — record `enabled=true, syncPending=true` and continue. The user can verify later via `/power-pages:plan-inner-loop` or by querying `solutions(<id>)?$select=sourcecontrolsyncstatus`.
- **Phase 10 `commit-to-git.js` returns 400 / `0x80040216` (shared components)**: a component in the solution being committed also lives in another Git-bound solution. Record failure; skip to next solution. The user can resolve the overlap manually (remove the shared component from one solution) and re-run `/power-pages:commit-to-git --solutionUniqueName <name>`.
- **Phase 10 `commit-to-git.js` returns 400 / `0x80098015` (conflicts present)**: the env has unresolved conflicts that block the commit. Record failure; surface guidance to run `/power-pages:resolve-conflicts` first. This generally only fires when a `sync-from-git` was attempted between Phase 9 enable and Phase 10 commit.
- **Phase 9 or Phase 10 helper fails entirely** (network / Dataverse 5xx): record the failure, continue with remaining solutions, surface a summary table at the end of the phase. Do NOT abort the whole skill — the env-binding (Phase 5) already succeeded; Phase 9 + Phase 10 are convenience flows on top.

---

**Begin with Phase 1: Prereq Check**
