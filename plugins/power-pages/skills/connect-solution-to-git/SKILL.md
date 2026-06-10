---
name: connect-solution-to-git
description: >-
  Binds a SPECIFIC SOLUTION (not the whole environment) to an Azure DevOps
  repository + branch + folder via the ConnectToGit OData action with
  ConnectionType=0. Use when different solutions in the same env need
  different repos OR you want to keep the rest of the env outside Git scope.
  Warns about the shared-object restriction (a component cannot be in two
  Git-bound solutions concurrently).
  Use when asked: "bind this solution to git", "connect solution to ADO",
  "git-bind only my custom solution", "solution-scoped git integration",
  "put just this solution in source control".
user-invocable: true
argument-hint: "Optional: solution unique name to skip the picker"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Connect Solution to Git

<!-- alm-lint-ignore: SKILL-must-read-manifest — solution-binding identity is selected interactively from a live Dataverse query in Phase 2 (the unmanaged-solutions list), not from .solution-manifest.json. This skill is the OPPOSITE direction from manifest-consuming skills: it produces a binding for ONE solution that may or may not be in the project's solution manifest. -->

Binds **one Dataverse solution** (not the whole env) to an Azure DevOps repo + branch + folder via the `ConnectToGit` OData action with `ConnectionType=0` and an explicit `SolutionUniqueName` parameter. Use this when env-level binding doesn't fit (e.g. one solution per team, partial Git scope, low-risk Connect-to-Git pilot).

## Overview

The wire-level OData action is the same as `setup-git-integration`, but with `ConnectionType=0` and a `SolutionUniqueName` parameter. The trade-off is the **shared-object restriction** (read it below before invoking this skill).

Prefer `/power-pages:setup-git-integration` unless solution-level binding is specifically required:
- Different solutions need different repos (e.g. one solution per team).
- The rest of the env should stay outside Git (legacy stuff, sandbox experiments).
- You're piloting Connect-to-Git and want a low-risk first binding.

### Shared-object restriction (read first)

A Git-bound solution **cannot share component instances** with another Git-bound solution. When you later try to add a shared component, the platform rejects the add with:

```
A component cannot be added because it is already part of another Git-bound solution.
```

Concretely: if Solution A is Git-bound and Solution B is also Git-bound, adding `mspp_webpage:About` to both will fail at the second add. Either keep one of the two **unbound** (the typical sandbox pattern) or merge into a single solution.

This skill warns the user when the selected solution shares components with an already-Git-bound solution (Phase 3 gate `shared-object-warning`).

**References:**
- `${CLAUDE_PLUGIN_ROOT}/references/binding-strategy.md` (env vs solution binding tradeoffs)
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-prerequisites.md`
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-api-patterns.md` §1-§3 (`ConnectToGit` payload + `ConnectionType` values)

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and logged in (`az login`) — this skill mints an ADO Entra bearer token via `az account get-access-token`; the user is **never** asked for a PAT
- **Recommended** Managed Environment ON for the target env, but **empirically not required** for solution-binding — HAR-confirmed 2026-06 that `ConnectionType=0` succeeds on Basic envs (see `references/inner-loop-empirical-findings.md` §1). Skill warns but does not block.
- The signed-in user holds the system-administrator role on the target env
- The target ADO repo exists and is initialized (Phase 3 step 4 auto-initializes empty repos on consent)
- The env is NOT already env-bound (env-binding and solution-binding are mutually exclusive)

**Initial request:** $ARGUMENTS

---

## Phase 1 — Prereq Check

**Goal:** Hard-gate every Connect-to-Git prerequisite — auth, env-target match, existing-binding state, Managed Env, and ADO permissions — before doing any work.

**Required parameter:** `<envUrl>` — the full Dataverse environment URL the user wants to bind (e.g. `https://orgXXXXXXXX.crm.dynamics.com/`). This skill does NOT have an implicit "use whatever PAC is signed into" fallback; the user (or upstream skill) must supply it. Capture it before Phase 1 begins, either via `$ARGUMENTS` or via `AskUserQuestion`.

**Do NOT create tasks yet.** Use natural-language progress reporting only during this phase.

Steps:

0. **Acquire an ADO Entra bearer token (`adoToken`) — written to a file, never echoed to stdout.** Mint a tenant-scoped OAuth token for the ADO Entra app and persist it to a gitignored 0o600 file for the Phase 3 ADO pre-checks (`list-ado-orgs`, `list-ado-projects`, `list-ado-repos`, `verify-ado-permissions`, `verify-repo-initialized`, `list-ado-folders`, `check-ado-folder-exists`). This replaces the legacy "Optional ADO PAT" prereq — the user is **never** asked for a PAT.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/get-ado-token.js" --writeToFile "docs/inner-loop/.ado-token"
   ```

   The helper writes the full token payload (`{ token, tokenType, tenantId, expiresOn, adoOrgTenantId, tenantMismatch }`) to `docs/inner-loop/.ado-token` (mode `0o600` on POSIX) and returns a redacted JSON envelope to stdout containing `tokenFile`, `tokenSha256`, and the non-token metadata — but never the raw token itself. **Read the token from the file at call-time when invoking downstream helpers** (preferred shell pattern: `--token "$(node -e 'console.log(JSON.parse(require(\"fs\").readFileSync(\"docs/inner-loop/.ado-token\",\"utf8\")).token)')"`) so the JWT never lands in tool-call arguments captured by the session log.

   - **Never echo the token (or the file's contents) to the user, never `cat` / `view` the file into agent-visible output.** The 2026-06-11 live test showed a JWT leaked via stdout in the session event log; `--writeToFile` is the helper-side fix.
   - The file is under `docs/inner-loop/` which must already be gitignored (covered by the inner-loop conventions).
   - On `ok:false`: the most common cause is `az login` is missing or stale. Surface the error verbatim (it already contains the actionable hint) and stop. No further steps run.

   > 🔒 Tenant verification against the target ADO org happens in **Phase 3 step 3a** (once we know the org name) — not here.

1. **envUrl ↔ PAC CLI target check.** Compare `<envUrl>` against the env PAC is currently signed into, via `pac env who --json`. **Hard-fail with recovery on mismatch.** This guard prevents a 2026-06-11 misfire mode where PAC was signed into `prod-sri-pp-alm` but the user asked to bind `sri-alm-dev-1` — without the check, the wrong env would have been bound (see `references/inner-loop-empirical-findings.md` §1).

   ```powershell
   # E1: envUrl mismatch hard-fail (recovery via `pac org select`)
   $expected = "<envUrl>"                                # the --envUrl arg the user passed
   $who      = pac env who --json | ConvertFrom-Json
   $actual   = $who.OrgUrl

   # Normalize trailing slash + case for stable comparison
   $expectedNorm = $expected.TrimEnd('/').ToLowerInvariant()
   $actualNorm   = $actual.TrimEnd('/').ToLowerInvariant()

   if ($expectedNorm -ne $actualNorm) {
       Write-Host "[envUrl-mismatch] expected=$expected actual=$actual ($($who.FriendlyName))"
       exit 1
   }
   ```

   On mismatch (script exits non-zero), surface (no marker — conversational; this is a recovery prompt, not a gate):

   | Question | Header | Options |
   |---|---|---|
   | PAC CLI is signed into `{actualOrgUrl}` ({actualFriendlyName}) but you asked to bind `{expectedOrgUrl}`. Switch PAC to the target env, or cancel? | envUrl mismatch | Switch PAC: `pac org select --environment {expectedOrgUrl}` (Recommended), Cancel — re-run with the correct --envUrl |

   - On **Switch PAC** → run `pac org select --environment "<envUrl>"`, then re-run `pac env who --json` and assert the OrgUrl now matches before continuing. If the switch fails (e.g. the auth profile has no access to `<envUrl>`), surface the error verbatim and stop.
   - On **Cancel** → exit cleanly. No Dataverse mutation has happened yet.

2. PAC CLI + Azure CLI authenticated (hard-block on failure); Managed Env probe (**warn only — solution-binding works on Basic envs**); system-admin role; ADO permissions (warn-only when no PAT was supplied).

   <!-- gate: connect-solution-to-git:1.prereq-fail | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · connect-solution-to-git:1.prereq-fail):** Same shape as `setup-git-integration:1.prereq-fail`. Block only on auth / hard-network failures; warn-not-block on Managed Env OFF (see `references/inner-loop-empirical-findings.md` §1 — solution-level bind is HAR-confirmed working on Basic envs).

3. Check whether the env is already env-bound. Run `detect-git-binding.js` (with no `--solutionUniqueName`). If the helper reports `bindingType === 'environment'`, you cannot also bind a solution — surface this and exit (the user must `disconnect-from-git` the env binding first, then re-invoke this skill).

   When the helper falls back to the `sourcecontrol-entities` path (`detectedVia === 'sourcecontrol-entities'`) and returns a single solution-folder binding, that does NOT mean the env is env-bound — it just means another solution was previously bound here. Look at `rootfolderpath` on every `sourcecontrolbranchconfigurations` row to be sure: an env-binding writes to the repo root (no `/<solution>` suffix); solution-bindings write to `<rootFolder>/<solutionUniqueName>`.

**Output:** `<envUrl>` matches PAC's current env; all prereqs green (or warnings acknowledged); env is not env-bound.

---

## Phase 2 — Discover Bindable Solutions

**Goal:** Enumerate unmanaged solutions in the env that are eligible for Git binding.

Tasks to create (`TaskCreate`):

1. List bindable solutions
2. User picks target solution
3. Check shared-object overlap
4. Gather ADO coordinates
5. Verify ADO repo initialized
6. Render binding plan
7. Final consent
8. Execute `ConnectToGit` (solution)
9. Verify binding round-trips
10. Write `.git-integration-manifest.json`

Steps:

1. Query Dataverse for unmanaged solutions that are eligible for Git binding (exclude Default and Common Data Service Default per Microsoft Learn):

   ```bash
   # Pseudo-call — issue an OData GET to /solutions
   GET {envUrl}/api/data/v9.2/solutions
     ?$select=solutionid,uniquename,friendlyname,version,ismanaged
     &$filter=ismanaged eq false
       and uniquename ne 'Default'
       and uniquename ne 'Active'
       and uniquename ne 'Basic'
       and uniquename ne 'CommonDataServiceDefault'
     &$orderby=modifiedon desc
   ```

   Use `Bash` with `makeRequest`-style invocation, or the `Read` tool to read a prior `solutions.json` dump if you've already cached it. The skill is interactive — getting a fresh list is fine.

**Output:** A list of eligible solutions.

---

## Phase 3 — Pick Solution, Gather Coordinates, Warn on Shared Objects

**Goal:** Have the user pick the target solution, then check for shared-component overlap with any already-bound solutions, then collect ADO coordinates and verify the target repo is initialized.

Steps:

1. <!-- gate: connect-solution-to-git:3.solution-pick | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · connect-solution-to-git:3.solution-pick):** Present the discovered solutions via `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Which solution do you want to Git-bind? | Solution picker | (dynamic list: `<friendlyname>` (`<uniquename>`, v`<version>`)), Cancel |

   If only one eligible solution exists, you may skip the gate and proceed with it — but state that fact in your progress message so the user can object.

2. Shared-object overlap check (HARD BLOCK — see warning below):

   - Query already-Git-bound solutions: `GET /solutions?$filter=enabledforsourcecontrolintegration eq true&$select=solutionid,uniquename,friendlyname`.
   - For each, compare component membership of the target solution against the bound solution's components by intersecting `(objectid, componenttype)` from `solutioncomponents` filtered by `_solutionid_value`.
   - If any overlap exists, this is **not just a warning** — the first `CommitToGit` will fail with error code `0x80040216` *"Shared components are not supported in source control"*, ONE component at a time. See `references/inner-loop-empirical-findings.md` §9.

   <!-- gate: connect-solution-to-git:3.shared-object-overlap | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · connect-solution-to-git:3.shared-object-overlap):** Only fires when overlap exists. Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Solution `{name}` shares N component(s) with already-bound solution(s) `{otherNames}` ({componentList}). The first commit WILL fail until these overlaps are resolved. How should I resolve this? | Shared-component overlap | Remove the N components from `{name}` (keep them in `{otherNames}`) (Recommended), Remove them from `{otherNames}` instead (keep in `{name}`), Cancel — let me redesign solution membership in the maker portal first |

   - If the user picks **Remove from `{name}`**: for each shared component, call:
     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/remove-solution-component.js" \
         --envUrl             "<envUrl>" \
         --objectId           "<componentId>" \
         --componentType      <typeInt> \
         --solutionUniqueName "<targetSolutionUniqueName>"
     ```
     Loop until all overlaps are gone, then re-verify the intersection is empty before proceeding.
   - If the user picks **Remove from `{otherNames}`**: same script but with `--solutionUniqueName` set to the OTHER solution. Be explicit that this affects the already-bound solution (a follow-up `commit-to-git` on that solution will reflect the removal).
   - If the user picks **Cancel**: exit cleanly and leave a note in the marker explaining the unresolved overlap.

3. **Cascading selection of ADO coordinates (org → project → repo → branch → folder).** Each level lists what already exists in ADO and either auto-selects (when only one option exists) or surfaces a picker; the user picks (or creates, where supported) before the next prompt fires. This replaces the legacy free-text gather — every typo in this phase costs the user a `ConnectToGit` 400 at Phase 5 (the most-irreversible point), and enumerating the real ADO objects eliminates the typo surface entirely.

   > 💡 The list / create / verify helpers below all consume the `<adoToken>` minted by Phase 1 step 0 (and re-verified for tenant alignment in sub-step 3a). No additional auth prompts. Pass the token via the shell-expansion pattern documented in Phase 1 step 0 so it never enters tool-call arguments captured by the session log.

   **Sub-step 3a — Select organization.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-ado-orgs.js" --token "<adoToken>"
   ```

   - `ok:true, orgs:[singleOrg]` (exactly one) → **auto-select** without a gate. State the auto-pick in your progress message so the user can object before the next prompt.
   - `ok:true, orgs:[…]` (two or more) → render as a table (columns: `#`, `accountName`, `accountUri`) and surface:

     <!-- gate: connect-solution-to-git:3.ado-org | category=plan | cancel-leaves=nothing -->
     > 🚦 **Gate (plan · connect-solution-to-git:3.ado-org):** Surface `AskUserQuestion`:

     | Question | Header | Options |
     |---|---|---|
     | Which ADO organization holds the target repo? | ADO organization | (dynamic list: `<accountName>`), `Create new (opens browser — orgs cannot be created via API)`, Cancel |

     - If user picks an org → set `<org>` to its `accountName`.
     - If user picks **Create new** → surface the hint *"Azure DevOps orgs can only be created via the web. Visit https://aex.dev.azure.com/go/signup, sign in with the same identity `az login` is using, finish the wizard, then re-run `/power-pages:connect-solution-to-git`."* and exit cleanly. (No Dataverse mutation has happened yet.)
     - If user picks **Cancel** → exit cleanly.

   - `ok:true, orgs:[]` (the user is signed in but has no orgs) → surface the "Create new" hint above and exit cleanly.
   - `ok:false` → surface the helper's `error` + `hint` verbatim and stop.

   **Tenant cross-check.** Now that `<org>` is known, re-mint the bearer token with tenant verification turned on. Pass `--writeToFile` so the refreshed token replaces `docs/inner-loop/.ado-token` and **no JWT enters stdout**:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/get-ado-token.js" \
       --verifyTenant --organization "<org>" \
       --writeToFile "docs/inner-loop/.ado-token"
   ```

   - `ok:true, tenantMismatch:false` (the common case, including the soft-skip path where the org tenant could not be extracted from `connectionData`) → the token file has been refreshed atomically; continue to sub-step 3b using the same shell-expansion pattern documented in Phase 1 step 0.
   - `ok:true, tenantMismatch:true` → **hard-block** with the helper's `hint` (it contains the exact `az login --tenant <guid>` command). Do not proceed; cross-tenant binding is not supported by this skill.
   - `ok:false` → surface the error verbatim and stop.

   **Sub-step 3b — Select project.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-ado-projects.js" --organization "<org>" --token "<adoToken>"
   ```

   - `ok:true, projects:[singleProject]` (exactly one) → **auto-select** without a gate. State the auto-pick in your progress message so the user can object.
   - `ok:true, projects:[…]` (two or more) → render as a table (columns: `#`, `name`, `state`, `visibility`) and surface:

     <!-- gate: connect-solution-to-git:3.ado-project | category=plan | cancel-leaves=nothing -->
     > 🚦 **Gate (plan · connect-solution-to-git:3.ado-project):** Surface `AskUserQuestion`:

     | Question | Header | Options |
     |---|---|---|
     | Which project in `{org}` holds the target repo? | ADO project | (dynamic list: `<name>`), Cancel |

     - If user picks a project → set `<proj>`. **This skill intentionally does NOT offer "Create new project"** — project creation requires repo-init flows that are out of scope here. If the user needs a new project, they should run `/power-pages:setup-git-integration` (which has the full create branch) for the initial setup, then return here to bind additional solutions.
     - If user picks **Cancel** → exit cleanly.

   - `ok:true, projects:[]` → no projects in the org. Surface *"No projects in `{org}`. Create one via the web (https://dev.azure.com/{org}) or run `/power-pages:setup-git-integration` first, then re-run this skill."* and exit cleanly.
   - `ok:false` → surface the helper's `error` + `hint` verbatim and stop.

   **Sub-step 3c — Select repository.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-ado-repos.js" --organization "<org>" --project "<proj>" --token "<adoToken>"
   ```

   - `ok:true, repos:[…]` → render as a table (columns: `#`, `name`, `defaultBranch`, `size`). Annotate each row: rows with `defaultBranch === null` are empty (Phase 3 step 4 will offer to auto-init them; this is friendly, NOT a blocker). Then surface:

     <!-- gate: connect-solution-to-git:3.ado-repo | category=plan | cancel-leaves=nothing -->
     > 🚦 **Gate (plan · connect-solution-to-git:3.ado-repo):** Surface `AskUserQuestion`:

     | Question | Header | Options |
     |---|---|---|
     | Which repo in `{org}/{proj}` should the solution bind to? | ADO repository | (dynamic list: `<name>` annotated `(empty)` when `defaultBranch === null`), `Create new`, Cancel |

     - If user picks an existing repo → set `<repo>` and capture its `defaultBranch` for use as the branch default in sub-step 3d.
     - If user picks **Create new** → prompt for the new repo name (data-gathering AskUserQuestion, validate non-empty + no `/`/`\`), then surface a consent gate:

       <!-- gate: connect-solution-to-git:3.create-repo | category=consent | cancel-leaves=nothing -->
       > 🚦 **Gate (consent · connect-solution-to-git:3.create-repo):** Surface `AskUserQuestion`:

       | Question | Header | Options |
       |---|---|---|
       | Create new git repo `{newRepoName}` in project `{org}/{proj}`? This is synchronous (~1 s) and the new repo starts empty (no default branch). Phase 3 step 4 will then auto-init it with a README commit. | Create repo | Create now (Recommended), Cancel — go back to repo selection |

       On **Create now**:
       ```bash
       node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/create-ado-repo.js" \
           --organization "<org>" --project "<proj>" --projectId "<projectId>" \
           --name "<newRepoName>" --token "<adoToken>"
       ```
       On `ok:true, repoId` → set `<repo>` = `<newRepoName>`. The new repo is empty, so Phase 3 step 4 will auto-init it with a README commit (no user action needed beyond accepting the init consent gate). On `ok:false, statusCode:409` → name conflict; surface hint and re-prompt at sub-step 3c. On other `ok:false` → surface `error` + `hint` and stop.

   - `ok:true, repos:[]` → no repos in the project. Skip directly to the **Create new** branch above.
   - `ok:false` → surface the helper's `error` + `hint` verbatim and stop.

   **Sub-step 3c.5 — Verify ADO permissions on the picked repo.**

   This is the first moment all three flags (`<org>` / `<proj>` / `<repo>`) have real values, so it's the earliest valid place to verify the user has Contribute on the target.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-ado-permissions.js" \
       --organization "<org>" --project "<proj>" --repository "<repo>" --token "<adoToken>"
   ```

   - `ok:true, hasAccess:true` → continue to sub-step 3d.
   - **Hard-block** on any failure (`ok:false` or `hasAccess:false`). `adoToken` is always present (acquired in Phase 1 step 0), so a failure means a real Contribute / repo / project issue worth surfacing. Surface the helper's `error` + `hint` verbatim and present:

     <!-- gate: connect-solution-to-git:3.ado-perms | category=intent | cancel-leaves=nothing -->
     > 🚦 **Gate (intent · connect-solution-to-git:3.ado-perms):** When the permissions check fails, surface `AskUserQuestion`:

     | Question | Header | Options |
     |---|---|---|
     | ADO permissions check failed on `{org}/{proj}/{repo}` (`{shortError}`). How would you like to proceed? | ADO permissions failure | Pick a different repo (back to sub-step 3c), Cancel and fix permissions manually |

     - **Pick a different repo** → loop back to sub-step 3c with the existing `<org>` + `<proj>` preserved (re-running 3a / 3b is unnecessary; only the repo choice was wrong).
     - **Cancel and fix permissions manually** → exit cleanly; no Dataverse mutation has happened yet.

   **Sub-step 3d — Collect branch (free-text, not-a-gate).**

   <!-- not-a-gate: connect-solution-to-git:3.branch — data-gathering for branch name -->
   `connect-solution-to-git:3.branch` (not-a-gate) — branch name. Default: the existing repo's `defaultBranch` (stripped of any `refs/heads/` prefix) if non-null, else `main`. Validate non-empty.

   **Sub-step 3e — Select folder-in-repo (the `gitFolder`).**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-ado-folders.js" \
       --organization "<org>" --project "<proj>" --repository "<repo>" --token "<adoToken>"
   ```

   The helper enumerates top-level folders in the repo so the user can SEE what's already there and avoid colliding with unrelated content. On `ok:true, emptyRepo:true` the folder list is empty (the repo has no commits yet — Phase 3 step 4 will init it). On `ok:true, folders:[…]` non-empty, render as a table (columns: `#`, `path`, `gitObjectType`).

   > ⚠️ **CRITICAL — folder name format (read this BEFORE prompting for the folder value).** The Dataverse `ConnectToGit` action validates the folder name **strictly** and rejects anything that looks path-like with HTTP 400, error code `0x80040265` *("The folder name 'solutions/' is invalid.")*. The validation failure fires at Phase 5 (the most expensive step, after every prior consent gate), so we MUST prevent the mistake at the prompt itself.
   >
   > When presenting the `gitFolder` field, the prompt's helper-text / placeholder MUST explicitly say:
   >
   > - **Accepted:** a plain folder name like `solutions`, `Power Pages`, `src`, `my-bound-folder`.
   > - **Rejected:** anything containing `/`, `\`, leading or trailing slashes (e.g. `solutions/`, `/solutions`, `solutions/sub`), or whitespace-only.
   > - **Default to suggest:** the target `solutionUniqueName` (which is the conventional 1:1 mapping for solution-bindings). Validate the same constraints — strip any leading `/` and reject `/`, `\`, trailing whitespace.
   > - **One-line summary in the prompt:** *"Folder name only — no slashes, no path separators. Type `{solutionUniqueName}`, NOT `{solutionUniqueName}/`."*

   <!-- not-a-gate: connect-solution-to-git:3.folder — data-gathering for ADO folder-in-repo -->
   `connect-solution-to-git:3.folder` (not-a-gate) — select or name the folder. Options:
   - Each existing folder by `path` (strip the leading `/` from the helper output before displaying so the value matches what `ConnectToGit` expects).
   - `Type a new folder name (Recommended — default: <solutionUniqueName>)`.

   - If user picks an existing folder → the Phase 3 step 5 folder-occupancy check (E7) will fire next to surface the collision-risk consent gate.
   - If user picks **Type a new folder name** → data-gathering AskUserQuestion with the warning above. Validate: non-empty, no `/` or `\`, no leading or trailing whitespace.

   Validate the final value: non-empty; leading `/` stripped (defensive — the user shouldn't have typed one given the warning, but the helper output starts with `/` and we strip it when displaying). Per the warning above, the user should be guided NOT to type a trailing slash in the first place (this skill intentionally does NOT silently sanitize trailing slashes).

4. Repo-init check — confirm the target repo has at least one commit on `<branch>` before any Dataverse mutation.

   `ConnectToGit` fails with a cryptic 400 against an empty repo (no `defaultBranch`, no refs), so we MUST verify here. The check uses the same `adoToken` already minted in Phase 1 step 0 / re-minted in 3a tenant cross-check — the user is never re-prompted for credentials.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-repo-initialized.js" \
       --organization "<org>" --project "<proj>" --repository "<repo>" --token "<adoToken>"
   ```

   Decision tree on the helper output:

   - `initialized:true` → repo has `defaultBranch` and `branchCount > 0`. Continue to Phase 4 (no gate fires).
   - `error` (non-200 / network / token rejected) → surface the helper's `error` field verbatim and stop. No Dataverse mutation has happened yet. Do NOT auto-retry; the user must fix the underlying issue (most often: tenant-scoped token expired between Phase 1 step 0 and now — re-run the skill).
   - `initialized:false` → the repo is empty (just-created via 3c's create-repo branch, or it always was). Fire the repo-init consent gate below.

   <!-- gate: connect-solution-to-git:3.repo-init | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · connect-solution-to-git:3.repo-init):** Surface `AskUserQuestion`:
   >
   > | Question | Header | Options |
   > |---|---|---|
   > | The ADO repo `{org}/{project}/{repo}` is empty (no default branch, no commits). `ConnectToGit` will fail with a cryptic 400 against an empty repo. Initialize it now with a single README commit on `{branch}` so the bind can proceed cleanly? | Repo initialization | Auto-init (Recommended), Initialize manually then re-run, Cancel and pick a different repo |
   >
   > - **Auto-init (Recommended)** → push a stub `README.md` on `<branch>` via the ADO Git Pushes REST API:
   >
   >   ```bash
   >   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/init-ado-repo.js" \
   >       --organization "<org>" --project "<proj>" --repository "<repo>" \
   >       --branch "<branch>" --token "<adoToken>"
   >   ```
   >
   >   - `ok:true, initialized:true` → continue to Phase 4. Persist `initialCommitId` from the helper output into `planData` for later audit.
   >   - `ok:true, alreadyInitialized:true` → race: someone else (or a prior aborted run) initialized the repo between our `verify-repo-initialized` call and our push. Safe — the existing `defaultBranch` is preserved. Continue to Phase 4.
   >   - `ok:false, statusCode:401` → surface the helper's `hint` (token scope rejected by ADO — needs `vso.code_write`). Stop; the user must re-run after fixing token scope. This is rare with the default Entra ADO scope but possible with custom PATs.
   >   - `ok:false, statusCode:403` → surface the helper's `hint` ("Your account lacks Contribute on this repo. Ask the project admin to grant the Contributors group write access on `<org>/<proj>/<repo>`, then re-run.") and stop. Cannot auto-fix; this is an ADO permission grant only the project admin can make.
   >   - `ok:false, statusCode:404` → surface the helper's `hint` ("Repository `<org>/<proj>/<repo>` not found...") and stop. Most often a typo somewhere in 3a/3b/3c that snuck past validation — the user should re-run the skill.
   >   - `ok:false` (other) → surface the helper's `error` + `hint` verbatim and stop. No Dataverse mutation has happened yet.
   >
   > - **Initialize manually then re-run** → exit cleanly. No Dataverse changes have been made. Tell the user: *"Push your initial commit (e.g. README) to `{org}/{project}/{repo}` on branch `{branch}` — in the ADO portal use the "Initialize main branch with a README" button, or `git push` from a local clone — then re-run `/power-pages:connect-solution-to-git --envUrl {envUrl} --solutionUniqueName {sol}`."* This option exists for users who want full control over the initial commit (custom README, .gitignore, license file, etc.) instead of the stub README that auto-init writes.
   >
   > - **Cancel and pick a different repo** → exit cleanly. No Dataverse changes have been made. Tell the user: *"To pick a different repo, re-run `/power-pages:connect-solution-to-git --envUrl {envUrl} --solutionUniqueName {sol}` and select a different repo at sub-step 3c."* This exit path exists primarily for users who realize at this point that the empty repo they just selected in 3c was the wrong one (e.g. accidental Create-new at 3c with a typo'd name).

5. Folder-occupancy check — confirm `<gitFolder>` on `<branch>` is empty (or, if not, the user accepts the collision-risk explicitly).

   `ConnectToGit` will happily co-locate Dataverse-managed solution files with whatever already lives at `/<gitFolder>/` on `<branch>` — no warning, no error, no platform-side safeguard. This is the single most insidious failure mode of solution-binding because it doesn't fail at bind-time: it fails at COMMIT-time, when the user's first `commit-to-git` mixes the pre-existing files into the Dataverse-managed snapshot and either (a) confuses subsequent reconciliation or (b) clobbers content nobody intended to put under Dataverse management. This check surfaces the collision BEFORE the bind so the user can pick a different folder or repo while it's still cheap.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/check-ado-folder-exists.js" \
       --organization "<org>" --project "<proj>" --repository "<repo>" \
       --gitFolder "<gitFolder>" --branch "<branch>" --token "<adoToken>"
   ```

   Persist the result into a session-scoped variable `preBindFolderOccupancy` (used by Phase 4's `planData` and by Phase 8's empirical-findings emit):

   ```jsonc
   {
     "exists":       true | false,
     "itemCount":    <number>,
     "headCommitId": "<sha>" | null,
     "emptyRepo":    true | undefined,
     "checkedAt":    "<ISO 8601>"
   }
   ```

   Decision tree on the helper output:

   - `ok:true, exists:false` (whether `emptyRepo:true` or just folder-not-found-on-populated-repo) → no collision. Continue to Phase 4 (no gate fires). The folder doesn't exist on `<branch>` yet — the bind will create it cleanly.
   - `ok:true, exists:true, itemCount:N` (N > 0) → collision detected. Fire the folder-occupied consent gate below.
   - `ok:false` (any) → surface the helper's `error` + `hint` verbatim and stop. No Dataverse mutation has happened yet. Common cases the helper distinguishes: `401` (token rejected), `403` (token lacks Reader on repo), `404` (repo not found / typo). Re-running the skill is the safe recovery — the tenant-scoped token may have expired between Phase 1 step 0 and now.

   <!-- gate: connect-solution-to-git:3.folder-occupied | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · connect-solution-to-git:3.folder-occupied):** Surface `AskUserQuestion`:
   >
   > | Question | Header | Options |
   > |---|---|---|
   > | The folder `/{gitFolder}/` on branch `{branch}` of `{org}/{project}/{repo}` already contains {itemCount} item(s). `ConnectToGit` will co-locate Dataverse-managed solution files into this folder without warning. How do you want to proceed? | Folder collision | Pick a different gitFolder (back to 3e), Pick a different repo (back to 3c), Proceed anyway (acknowledge risk), Cancel |
   >
   > - **Pick a different gitFolder (back to 3e)** → loop back to sub-step 3e of step 3. The repo + branch are kept; only the folder selection is re-prompted. After re-selection, step 5 fires again against the new folder.
   > - **Pick a different repo (back to 3c)** → loop back to sub-step 3c of step 3. The org + project are kept; the repo + branch + folder are re-collected from scratch (since each new repo has its own defaultBranch + folder list). After re-selection, step 4 (repo-init) AND step 5 (folder-occupancy) both fire again.
   > - **Proceed anyway (acknowledge risk)** → continue to Phase 4. The `preBindFolderOccupancy` record is preserved in `planData` so the Phase 4 plan-render explicitly shows *"Pre-bind folder occupancy: {itemCount} item(s) — user acknowledged"* in the plan summary. This is the audit trail for the deliberate-collision case (e.g. a folder previously used by a now-disconnected solution that the user is intentionally re-using).
   > - **Cancel** → exit cleanly. No Dataverse changes have been made. Tell the user: *"To pick a different repo or folder, re-run `/power-pages:connect-solution-to-git --envUrl {envUrl} --solutionUniqueName {sol}`."*

**Output:** Target solution picked; shared-object risk acknowledged (or absent); ADO coordinates gathered; repo confirmed initialized (or just-initialized by `init-ado-repo.js`); target folder confirmed empty (or collision acknowledged via the folder-occupied consent gate).

---

## Phase 4 — Render and Approve the Binding Plan

**Goal:** Persist plan-data and get explicit plan-approval before any consent prompt.

Steps:

1. Write `planData` to `docs/inner-loop/.connect-solution-plan-data.json`:

   ```json
   {
     "skill":                "connect-solution-to-git",
     "generatedAt":          "<ISO>",
     "envUrl":               "<envUrl>",
     "bindingType":          "solution",
     "solutionUniqueName":   "<sol>",
     "solutionFriendlyName": "<friendly>",
     "solutionVersion":      "<x.y.z>",
     "organization":         "<org>",
     "project":              "<proj>",
     "repository":           "<repo>",
     "branch":               "<branch>",
     "gitFolder":            "<folder>",
     "preBindFolderOccupancy": { /* from Phase 3 step 5 check-ado-folder-exists.js */ },
     "sharedOverlap":        [ /* { uniquename, sharedComponentIds } */ ]
   }
   ```

2. Present a textual plan to the user:

   ```
   Binding plan
     Solution:    <friendly> (<unique>, v<version>)
     Environment: <envUrl>
     Type:        solution-level (ConnectionType=0)
     Target:      <org>/<proj>/<repo>  branch <branch>  folder <folder>
     Overlaps:    <none | list>
     Reverses?    Yes — disconnect-from-git --solutionUniqueName <name> unbinds this solution only.
   ```

3. <!-- gate: connect-solution-to-git:4.plan | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · connect-solution-to-git:4.plan):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Bind solution `{uniquename}` to repo `{org}/{project}/{repo}`, branch `{branch}`, folder `{folder}`? | Binding plan | Yes — proceed to consent (Recommended), Change a field, Cancel |

**Output:** `docs/inner-loop/.connect-solution-plan-data.json` written; plan approved.

---

## Phase 5 — Final Consent + Execute

**Goal:** Final consent before any Dataverse mutation, then call `ConnectToGit` with `ConnectionType=0`.

Steps:

1. <!-- gate: connect-solution-to-git:5.consent | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · connect-solution-to-git:5.consent):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Final consent — call `ConnectToGit` for solution `{uniquename}` now? Reversible via disconnect-from-git --solutionUniqueName. | Final consent | Connect now, Cancel |

2. On **Connect now**:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/connect-solution-to-git.js" \
       --envUrl              "<envUrl>" \
       --solutionUniqueName  "<sol>" \
       --organization        "<org>" \
       --project             "<proj>" \
       --repository          "<repo>" \
       --branch              "<branch>" \
       --rootFolder          "<rootFolder>" \
       --gitFolder           "<folder>"
   ```

   > ⏱ **Expected duration & timeout handling.** ConnectToGit holds the HTTP request open for 5-15 min while the `SourceControlInitialSyncPlugin` async op serializes every component in the solution and creates an **automatic initial commit**. The helper's HTTP timeout (~2 min) often fires before Dataverse responds — but the helper now **post-verifies** by re-querying `solutions.enabledforsourcecontrolintegration`. When that returns `true`, the helper returns `{ bound: true, isAsyncStillSyncing: true, note: "HTTP request timed out but the binding committed server-side..." }`. **Treat this as success** and proceed to Phase 6. See `references/inner-loop-empirical-findings.md` §3 + §4.

3. Error handling: 400 most commonly means the solution is the Default / Active / Basic / CommonDataServiceDefault (these are not bindable; the discovery query in Phase 2 should have filtered them out, but the platform re-validates). 401/403 means the tenant Entra OAuth grant to ADO is missing or expired — surface the maker-portal "Authorize ADO" flow.

**Output:** `ConnectToGit` returned success; solution is now bound.

---

## Phase 6 — Verify Binding Round-trips

**Goal:** Re-query Dataverse to confirm the solution-level bind landed and capture canonical field values.

Steps:

1. ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-git-binding.js" \
       --envUrl "<envUrl>" --solutionUniqueName "<sol>"
   ```

   Expected: `bound === true`, `bindingType === 'solution'`, `solutionUniqueName === <sol>`, ADO fields match.

2. If any field differs (e.g. branch normalized to `refs/heads/main`), record the canonical Dataverse-reported value for the manifest.

**Output:** Round-trip verified; canonical field values captured.

---

## Phase 7 — Write `.git-integration-manifest.json`

**Goal:** Persist the load-bearing manifest at the project root + the skill-run marker in `docs/inner-loop/`.

Steps:

1. Write to the **project root**. Schema is identical to `setup-git-integration`'s manifest but with `bindingType: "solution"` and the extra `solutionUniqueName` field:

   ```json
   {
     "bindingType":          "solution",
     "envUrl":               "<envUrl>",
     "solutionUniqueName":   "<sol>",
     "solutionFriendlyName": "<friendly>",
     "organization":         "<canonical>",
     "project":              "<canonical>",
     "repository":           "<canonical>",
     "branch":               "<canonical>",
     "gitFolder":            "<canonical>",
     "boundAt":              "<ISO>",
     "lastVerifiedAt":       "<ISO>",
     "lastCommitSha":        null,
     "manifestVersion":      "1"
   }
   ```

2. Also write `docs/inner-loop/last-setup.json` (same marker name used by `setup-git-integration` — last setup wins; both skills are mutually exclusive once a binding exists). The marker path is registered in `scripts/lib/inner-loop-paths.js` under the key `lastSetup`.

**Output:** `.git-integration-manifest.json` (project root) + `docs/inner-loop/last-setup.json` written.

---

## Phase 8 — Wait for Component Staging, Show ADO URL, Final Gate

**Goal:** Wait for the post-bind component-staging plugin to finish, count the now-staged pending Changes, route the user to `commit-to-git` (the staged components are the user's first **real** commit), and record skill usage.

> ⚠️ **Earlier docs incorrectly claimed Connect-to-Git auto-pushes all components.** It does not. Connect-to-Git only writes a placeholder `Readme.md` commit at `<rootFolder>/<gitFolder>/` and stages every solution component into the `sourcecontrolcomponent` Dataverse entity with `iscommitted=false`. The user MUST then run `/power-pages:commit-to-git` to push them. See `references/inner-loop-empirical-findings.md` §3 + §10.

Steps:

1. **Poll `solutions.sourcecontrolsyncstatus` for the bound solution** every 15 s (up to 30 attempts ≈ 7.5 min — larger solutions may need more):

   ```bash
   GET <envUrl>/api/data/v9.2/solutions
     ?$select=uniquename,sourcecontrolsyncstatus,solutionid
     &$filter=uniquename eq '<sol>'
   ```

   Wait until `sourcecontrolsyncstatus == 3` (Synced = component staging finished). If the budget is exhausted, tell the user staging is still running in the background — re-running `/power-pages:plan-inner-loop` later will show the final pending-count.

2. **Count the staged-but-uncommitted components** that Connect-to-Git has just enumerated:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-pending-changes.js" \
       --envUrl "<envUrl>" --solutionUniqueName "<sol>"
   ```

   The returned `count` is the number of items the user's first `CommitToGit` will push (typically larger than the raw `solutioncomponents` count because dependencies are included). Capture the **placeholder Readme commit SHA** from `sourcecontrolbranchconfigurations` (the row whose `rootfolderpath` ends with `/<sol>`); update the manifest's `lastCommitSha` to that placeholder SHA — the manifest will be updated again after the first real `CommitToGit`.

3. **Print the full ADO browse URL** with the `&path=` parameter so the user lands directly on `<rootFolder>/<gitFolder>/` (initially almost-empty — just the placeholder Readme) — not the repo root, which often only shows the pre-existing README and confuses fresh-bind users (`references/inner-loop-empirical-findings.md` §7):

   ```
   https://dev.azure.com/<org>/<project>/_git/<repo>?path=/<rootFolder>/<gitFolder>&version=GB<branch>&_a=contents
   ```

4. <!-- gate: connect-solution-to-git:8.final | category=final | cancel-leaves=nothing -->
   > 🚦 **Gate (final · connect-solution-to-git:8.final):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Solution `{uniquename}` is now Git-bound. The folder `solutions/{gitFolder}/` was seeded with a placeholder Readme (commit `{shortSha}`) and **{pendingCount}** components are now staged as pending Changes. Push them as the real initial commit? | Initial commit pending | Run /power-pages:commit-to-git now (Recommended), Review the staged Changes in the maker portal first, Exit — I will commit later |

   > 💡 **Why is `commit-to-git` the default?** Connect-to-Git only seeds the folder; the staged components stay pending until the user explicitly commits them. Skipping this step leaves the repo with only the placeholder Readme. See `references/inner-loop-empirical-findings.md` §3.

   > ℹ️ **About the placeholder commit you'll see in ADO:** the `Creating new project folder solutions/<gitFolder>` commit is a one-time bookkeeping commit created by ConnectToGit. It is permanent in the branch history. Your next `/power-pages:commit-to-git` will add **one additional commit** on top of it (CommitToGit is strictly 1-call → 1-commit; it does NOT split into batches). See `references/inner-loop-empirical-findings.md` §12.

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "ConnectSolutionToGit"`.

**Output:** User routed to next action; skill counter incremented.

---

## Artifacts Written

| File | Location | Purpose |
|---|---|---|
| `.git-integration-manifest.json` | project root | Source of truth for binding type / solution / repo / branch / folder. |
| `last-setup.json` | `docs/inner-loop/` | Skill-run marker validated by `validate-setup-git-integration.js` (shared validator — same as `setup-git-integration`). |

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| List bindable solutions | Listing bindable solutions | Query unmanaged solutions excluding Default / Active / Basic / CommonDataServiceDefault |
| User picks target solution | Awaiting solution pick | Surface picker gate; skip with note when only one eligible solution exists |
| Check shared-object overlap | Checking shared overlap | Query already-Git-bound solutions; compare component membership; surface warning gate on overlap |
| Gather ADO coordinates | Gathering ADO fields | Cascading discovery org → project → repo → branch → folder (Phase 3 step 3 sub-steps 3a-3e); helpers `list-ado-orgs.js`, `list-ado-projects.js`, `list-ado-repos.js`, `verify-ado-permissions.js`, `list-ado-folders.js`; tenant cross-check between 3a and 3b |
| Verify ADO repo initialized | Verifying repo init | Call `verify-repo-initialized.js`; offer README-commit flow via `init-ado-repo.js` when empty (Phase 3 step 4 gate `connect-solution-to-git:3.repo-init`) |
| Check folder occupancy | Checking folder occupancy | Call `check-ado-folder-exists.js`; surface collision-risk consent gate when `itemCount > 0` (Phase 3 step 5 gate `connect-solution-to-git:3.folder-occupied`) |
| Render binding plan | Rendering binding plan | Compose `.connect-solution-plan-data.json`; show textual preview |
| Final consent | Awaiting bind consent | Surface explicit consent gate before any Dataverse mutation |
| Execute `ConnectToGit` (solution) | Executing ConnectToGit | Call `connect-solution-to-git.js` helper; surface platform errors |
| Verify binding round-trips | Verifying binding | Re-query `detect-git-binding.js`; capture canonical field values |
| Write `.git-integration-manifest.json` | Writing manifest | Persist manifest at project root + skill-run marker at `docs/inner-loop/last-setup.json` |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: envUrl mismatch with `pac env who` (no marker — conversational; recovery via `pac org select --environment <envUrl>` or cancel).
2. **Phase 1**: Prereq failure → open remediation URLs or cancel (gate `connect-solution-to-git:1.prereq-fail`).
3. **Phase 1**: Env-bound check (no marker — conversational; hard stop if env-bound).
4. **Phase 3**: Solution picker (gate `connect-solution-to-git:3.solution-pick`).
5. **Phase 3**: Shared-object overlap warning (gate `connect-solution-to-git:3.shared-object-warning`).
6. **Phase 3 sub-step 3a**: ADO organization picker (gate `connect-solution-to-git:3.ado-org`; auto-selects when count==1).
7. **Phase 3 sub-step 3b**: ADO project picker (gate `connect-solution-to-git:3.ado-project`; auto-selects when count==1; no Create-new branch).
8. **Phase 3 sub-step 3c**: ADO repository picker (gate `connect-solution-to-git:3.ado-repo`), with optional create consent (gate `connect-solution-to-git:3.create-repo`).
9. **Phase 3 sub-step 3c.5**: ADO permissions verification — hard-block on failure (gate `connect-solution-to-git:3.ado-perms`).
10. **Phase 3 sub-step 3d**: Branch name (not-a-gate; default = repo's `defaultBranch` stripped of `refs/heads/`, else `main`).
11. **Phase 3 sub-step 3e**: Folder-in-repo picker (not-a-gate; format warning enforced in prompt helper-text).
12. **Phase 3 step 4**: Empty repo detected → auto-init / manual / cancel (gate `connect-solution-to-git:3.repo-init`).
13. **Phase 3 step 5**: Folder-occupied warning (gate `connect-solution-to-git:3.folder-occupied`; only fires when `check-ado-folder-exists` returns `itemCount > 0`).
14. **Phase 4**: Approve the binding plan (gate `connect-solution-to-git:4.plan`).
15. **Phase 5**: Final consent before `ConnectToGit` (gate `connect-solution-to-git:5.consent`).
16. **Phase 8**: Choose next action (gate `connect-solution-to-git:8.final`).

---

## Error Handling

- **Env already env-bound**: hard stop in Phase 1 — solution-binding is mutually exclusive with env-binding. The user must `disconnect-from-git` the env binding first.
- **No eligible solutions found** (only managed / system solutions exist): surface the discovery gap and suggest `/power-pages:setup-solution` to create one.
- **Shared-object overlap detected**: hard-block (not just a warning). Resolve via Phase 3 step 2 by removing the shared components from one side, OR cancel. The first `CommitToGit` will fail otherwise with `0x80040216`. See `references/inner-loop-empirical-findings.md` §9.
- **`ConnectToGit` returns 400 "solution not bindable"**: re-validate the solution unique name; verify it is unmanaged and not in the excluded-name list.
- **`ConnectToGit` returns 5xx**: transient — retry once. If second attempt fails, surface verbatim and stop.
- **Phase 6 reports `bindingType === 'env'` somehow**: anomaly — Dataverse claims env-binding when solution-binding was requested. Surface the discrepancy and instruct the user to invoke `/power-pages:diagnose-git-integration`.

---

**Begin with Phase 1: Prereq Check**
