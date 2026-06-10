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

3. Gather ADO fields:

   `connect-solution-to-git:3.ado-fields` (not-a-gate) — same fields as `setup-git-integration`: org, project, repo, branch (default `main`), folder-in-repo (default `<solutionUniqueName>`).

4. Repo-init check:

   Same as `setup-git-integration` Phase 2 step 2 — call `verify-repo-initialized.js`. If empty, offer the README-commit option or exit for manual init.

   *(No separate gate ID in the catalog for this — re-use the same conversational pattern as `setup-git-integration:2.repo-init` but DO NOT use that gate marker; it's owned by the other skill. Surface the prompt directly via `AskUserQuestion` without a marker comment — this is a documented exception per `approval-gates.md` §3 footnote on shared remediation prompts.)*

**Output:** Target solution picked; shared-object risk acknowledged (or absent); ADO coordinates gathered; repo confirmed initialized.

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
| Gather ADO coordinates | Gathering ADO fields | Collect org / project / repo / branch / folder via `AskUserQuestion` |
| Verify ADO repo initialized | Verifying repo init | Call `verify-repo-initialized.js`; offer README-commit flow when empty |
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
6. **Phase 3**: ADO fields (data-gathering, not a gate).
7. **Phase 3**: Empty repo detected → README-commit, manual, or cancel (no marker — conversational; see Phase 3 step 4 footnote).
8. **Phase 4**: Approve the binding plan (gate `connect-solution-to-git:4.plan`).
9. **Phase 5**: Final consent before `ConnectToGit` (gate `connect-solution-to-git:5.consent`).
10. **Phase 8**: Choose next action (gate `connect-solution-to-git:8.final`).

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
