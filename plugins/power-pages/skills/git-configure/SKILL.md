---
name: git-configure
description: >-
  Configure Power Pages Dataverse Git integration: detect code site, solution,
  env, and current binding; run auth, Managed Env, sys-admin, tenant, BYOK/CMK,
  license, ADO permission, and repo-init preflights; explain env vs solution
  binding; then connect, switch branch, rebind, or disconnect. Replaces
  setup-git-integration, connect-solution-to-git, and branch-switch while
  preserving gates, folder checks, shared-object remediation, workspace-clean
  stop, manifest writes, and enable/commit follow-ups.
user-invocable: true
argument-hint: "Optional: --mode=setup|switch-branch|rebind|disconnect; --binding=env|solution; --non-interactive; --no-intro; target branch or ADO coordinates"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Git Configure

`git-configure` is the unified Power Pages inner-loop skill for configuring where Dataverse talks to Azure DevOps Git. It merges the three legacy flows without dropping their protections:

- `setup-git-integration` → setup mode, environment binding (`ConnectionType=1`).
- `connect-solution-to-git` → setup mode, solution binding (`ConnectionType=0`, `SolutionUniqueName`).
- `branch-switch` → switch-branch mode (`DisconnectFromGit` + `ConnectToGit`).
- New surfaces: rebind and disconnect.

**Initial request:** $ARGUMENTS

**User-facing voice:** speak plainly. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-user-language.md` for the authoring rules — no raw API names, raw JSON, or GUIDs in user chat (except on failure); show progress as sequential `Phase {N} — {plainTitle}` (internal phase numbers stay internal).

**Shared references, do not duplicate:** `${CLAUDE_PLUGIN_ROOT}/references/binding-strategy.md`, `${CLAUDE_PLUGIN_ROOT}/references/git-integration-prerequisites.md`, `${CLAUDE_PLUGIN_ROOT}/references/git-integration-api-patterns.md`, `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md`, `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-flow.md`, and `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`.

## Global invariants

1. **No hidden Dataverse mutations.** Phases 6 and 7 always gate before `ConnectToGit`, `DisconnectFromGit`, `switch-branch.js`, or solution enable/commit follow-ups.
2. **Never persist ADO JWTs.** ADO helpers acquire an ADO-scoped Entra token in-process via `az` when no explicit token is supplied; the token is never written to disk, printed, or placed on a command line. Require the user's `az login` session to be current. Locked-down or CI environments can set `POWERPAGES_NO_ADO_ACQUIRE=1` so helpers fail instead of attempting interactive acquisition.
3. **Use deterministic helpers.** Do not inline Dataverse or ADO REST calls when a helper exists.
4. **Folder values are validated by binding type.** For **env binding** the folder is a single name — reject `/`, `\`, leading/trailing slash, and whitespace-only. For **solution binding** the `gitFolder` is a repo-relative *path* that MAY contain forward-slash segments (e.g. `solutions/<solutionName>`); reject `\`, leading/trailing slash, and empty/`.`/`..`/whitespace-only segments. Solution content lands at `/<gitFolder>/` in the repo and Dataverse stores the value **verbatim** (the `--rootFolder` arg is for the env-level row and is NOT prepended to the solution path), so to place files under `solutions/` the leading segment must be part of `gitFolder`. Do not silently sanitize; re-prompt with the helper text.
5. **Plan and final consent gates always fire.** Headless mode removes discovery prompts only, never safety prompts.
6. **Cancel before Phase 7 leaves no Dataverse mutation.** After a Phase 7 mutation failure, clearly report the partial state and recovery route.
7. **ConnectionType is explicit.** Env binding calls `connect-to-git.js` (`ConnectionType=1`); solution binding calls `connect-solution-to-git.js` (`ConnectionType=0`).
8. **Manifest fields come from post-verify.** If Dataverse normalizes branch/folder values, persist Dataverse's canonical values, not user input.

## Modes

| Mode | How selected | Mutates? | Low-level helper |
|---|---|---:|---|
| `setup` | Unbound env, or `--mode=setup` | Yes | `connect-to-git.js` or `connect-solution-to-git.js` |
| `switch-branch` | Bound env + branch-only intent, or `--mode=switch-branch` | Yes | `switch-branch.js` |
| `rebind` | Bound env + org/project/repo/folder change, or `--mode=rebind` | Yes | `disconnect-from-git.js` then connect helper |
| `disconnect` | Bound env + unbind intent, or `--mode=disconnect` | Yes | `disconnect-from-git.js` |

## Non-interactive mode contract (N7)

<!-- not-a-gate: contract description of prompt-suppression behaviour under --non-interactive — defines how existing gates fail-loud instead of prompting; introduces no new prompt or Dataverse/state change -->

When `$ARGUMENTS` contains `--non-interactive` (CI / unattended callers):

1. **Never block on a prompt.** Fail-loud: print the missing input and the required flag, then exit non-zero.
2. **Required inputs must be supplied as flags.** At minimum: `--envUrl`, `--binding=env|solution`, and for setup the ADO coordinates (org/project/repo/branch/folder); for solution binding also `--solutionUniqueName`. List ALL missing flags at once — don't fail one at a time.
3. **Safety gates still apply, cannot be auto-approved.** Hard-stop gates (cross-tenant block, shared-object overlap, workspace-dirty) still fail — `--non-interactive` is not a consent bypass. Destructive confirmations (disconnect/rebind) exit non-zero with the reason.
4. **No stack traces.** Every failure exits with a one-line `verb + reason + next-action` message (see `${CLAUDE_PLUGIN_ROOT}/references/helper-conventions.md`).

## Phase 0 — Mode Detection

**Goal:** Determine the run mode before any prompts.

Steps:

1. Report progress: "Detecting Git configuration mode."
2. Run current-binding discovery once with `detect-git-binding.js` using the env URL from context, PAC, or arguments.
3. Call `detectGitConfigureMode({ binding, args })` from `${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-git-configure-mode.js`. Trust its output shape: `{ mode, reason, explicitOverride, requiresIntentPrompt?, noOp?, headless: { eligible, blockers[] } }`.
4. Announce the mode and reason. If `explicitOverride` conflicts with state (for example disconnect while unbound), hard-stop in Phase 1 rather than improvising.
   - If `noOp` is true (e.g. requested branch already matches the current branch), report the no-op plainly — *"Already bound to `{org}/{project}/{repo}@{branch}`; nothing to change."* — and exit without mutating.
   - If `requiresIntentPrompt` is true (bound env, no mode/branch given), do NOT silently enter switch-branch. Defer to the Phase 1 intent gate (`git-configure:1.bound-intent`) so the user explicitly chooses switch-branch / rebind / disconnect.
5. Create the 10 phase tasks up front after mode detection.

**Output:** `mode` and `headless` eligibility are known.

---

## Phase 1 — Context Discovery

**Goal:** Discover project, environment, solution, and current Git binding state.

Steps:

1. Detect the code-site context via `detect-project-context.js`; use `powerpages-config.js` to read `powerpages.config.json` when present. Capture `siteName`, `websiteRecordId`, `environmentUrl`, and `.solution-manifest.json` metadata.

2. **First-run preamble (N1).** When this is a first run — no `docs/inner-loop/.git-integration-manifest.json`, `binding.bound === false`, and no pending changes — render a short orientation (≤6 lines) before any prompt, unless `--no-intro` was passed:
   > **git-configure** wires this Dataverse environment to an Azure DevOps Git repo so your solutions are source-controlled.
   > You'll choose: which environment, env-vs-solution binding, and the ADO org/project/repo/branch/folder.
   > I'll run preflights first (auth, Managed Env, BYOK, license, same-tenant, ADO permissions) and always ask before any change.
   > Nothing is committed without your explicit consent. You can stop at any prompt.
   Skip the preamble for `switch-branch`, `rebind`, `disconnect`, and re-runs on an already-bound env.

3. **Resolve and CONFIRM `<envUrl>` (U1 live picker — always confirm the active env).** The active PAC environment is the target of every Dataverse mutation in this run, so never assume it silently — confirm it explicitly even when an env URL is resolvable from context. Always, in every mode:

   1. Read the active PAC env (its friendly name + Org URL):

      ```bash
      pac env who
      ```

   2. List all available envs:

      ```bash
      node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-environments.js"
      ```

   3. Fire the env-confirm gate below.

   The *suggested default* is resolved in order — explicit argument → `powerpages.config.json` → `detect-project-context.js` → PAC active env — but the suggestion never bypasses the confirm prompt. Skip the picker (confirm silently) only for `--non-interactive` runs where `--envUrl` is supplied.

<!-- gate: git-configure:1.env-confirm | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-configure:1.env-confirm):** Fires in every interactive run, before any preflight or mutation, to confirm the target environment. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | PAC is signed into `{activeFriendlyName}` (`{activeUrl}`). Use this environment, or switch? | Target environment | `{activeFriendlyName} — {activeUrl} (active)`, …one option per other env as `{friendlyName} — {url} ({geo})`…, ➕ Connect to a different environment (sign in / enter URL), Cancel |
>
> - On the active env, continue with `<envUrl> = activeUrl`.
> - On a different **listed** env, run `pac org select --environment <url>`, re-run `pac env who`, and continue only once the active env matches the pick.
> - On **"➕ Connect to a different environment…"**, prompt for an env URL (validate `https://*.crm.dynamics.com`); if PAC is not authenticated to it, guide the user through `pac auth create --environment <url>`, then re-verify with `pac env who`.
> - If `list-environments.js` returns `ok:true` and `count === 1`, still present that single env as the one explicit choice (plus the ➕ and Cancel options) — never auto-select.
> - If `list-environments.js` returns `ok:false`, show its `hint` and fall back to a free-text `<envUrl>` prompt with validation (`https://*.crm.dynamics.com`). Never hard-fail solely because PAC is unavailable.
>
> Cancellation leaves nothing; no Dataverse or ADO mutation has happened.

<!-- gate: git-configure:1.prereq-fail | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-configure:1.prereq-fail):** Fires when PAC/Az auth is missing, env URL cannot be resolved, required context is malformed, or an explicit mode is impossible in the current binding state. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | One or more prerequisites failed before Git configuration can start: `{diagnostic}`. How do you want to proceed? | Git configure prerequisite failure | Show remediation steps, Cancel and fix manually |
>
> Cancellation leaves nothing; no Dataverse or ADO mutation has happened.

4. **Artifact-path choice (U5).** Inner-loop artifacts default to `<projectRoot>/docs/inner-loop/`. Only prompt when `<projectRoot>` is a pac-managed code-site folder (detected via `powerpages.config.json`), because writing artifacts into a pac download/upload root disturbs it.

<!-- gate: git-configure:1.artifact-path | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-configure:1.artifact-path):** Fires only when `<projectRoot>` is a pac-managed code-site root. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | `{projectRoot}` looks like a pac-managed Power Pages site. Writing run artifacts there can disturb pac. Where should inner-loop artifacts live? | Artifact path | Use a sibling folder `{projectRoot}/../{solution}-inner-loop` (recommended), Use `{projectRoot}/docs/inner-loop` anyway, Specify another path |
>
> Persist the chosen root into `docs/inner-loop/.git-integration-manifest.json` as `artifactRoot` so later inner-loop skills don't re-ask. The `docs/inner-loop/` folder is auto-gitignored fail-closed. Default (non-pac-managed roots) needs no prompt.

5. Compare explicit `<envUrl>` with `pac env who --json` `OrgUrl` when both exist. Normalize case and trailing slash only.

<!-- gate: git-configure:1.envurl-mismatch | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-configure:1.envurl-mismatch):** Fires when user-passed env URL differs from PAC's selected env. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | PAC CLI is signed into `{actualOrgUrl}` but this run targets `{expectedOrgUrl}`. Switch PAC to the target env before continuing? | envUrl mismatch | Switch PAC to target env, Cancel and re-run with the correct env |
>
> On switch, run `pac org select --environment <envUrl>`, re-run `pac env who --json`, and continue only when the values match. Cancellation leaves nothing.

6. Run `detect-git-binding.js` for env binding and, when a solution is known, for that solution.

   **Manifest reconcile (B3).** Compare the local `docs/inner-loop/.git-integration-manifest.json` against this server truth with `reconcile-manifest.js` (see `${CLAUDE_PLUGIN_ROOT}/references/manifest-contract.md`). A stale manifest (e.g. after the ADO branch was deleted or the binding was torn down in the maker portal) must not be trusted silently.

<!-- gate: git-configure:1.manifest-stale | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-configure:1.manifest-stale):** Fires when `reconcileManifest({ manifest, serverBinding })` returns `aligned:false`. Surface `AskUserQuestion` using the helper's `options` as choices:
>
> | Question | Header | Options |
> |---|---|---|
> | Local manifest and server binding disagree: `{summary}` (`{divergedFields}`). How should I reconcile? | Stale manifest | Overwrite manifest from server truth, Re-bind using the manifest's old coordinates, Clear local manifest and start fresh, Cancel |
>
> Only offer the options the helper returned. `Overwrite` rewrites the manifest from server truth; `Re-bind` routes to setup/rebind with the old coordinates; `Clear` deletes the local binding fields. Cancellation leaves the manifest untouched.

7. If `mode=setup` and already bound, surface current binding and route to `switch-branch`, `rebind`, or `disconnect`; do not accidentally double-bind.
8. If `mode=switch-branch`, `rebind`, or `disconnect` and unbound, stop with remediation to run setup mode.

9. **Bound-env intent confirmation (N2).** When mode detection returned `requiresIntentPrompt`, do not proceed silently. Surface the current binding and ask what the user wants.

<!-- gate: git-configure:1.bound-intent | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-configure:1.bound-intent):** Fires when the env is already bound and no `--mode`/`--branch` was given (`requiresIntentPrompt`). Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | This environment is already bound to `{org}/{project}/{repo}@{branch}` (folder `{gitFolder}`). What would you like to do? | Already bound | Switch branch, Rebind to different ADO coordinates, Disconnect, Cancel |
>
> Route to the matching mode. Cancellation leaves nothing — re-running with an explicit `--mode` skips this gate.

**Output:** Project, env, solution, binding, and mode constraints are known.

---

## Phase 2 — Preflight

**Goal:** Run all legacy and new preflights before planning a mutation.

Steps:

1. Verify PAC and Azure CLI authentication. Use plain `az login` guidance if missing; mention `az login --allow-no-subscriptions` only as a fallback for subscription-less accounts.
2. Ensure Azure CLI authentication is current for ADO helper self-acquisition. The pre-check helpers acquire an ADO-scoped Entra token in-process via `az` when invoked; no token file is created or passed.

3. Verify Managed Environment with `verify-managed-env.js`. **(O5)** If `enabled:false` (`protectionLevel:"Basic"`) **and** the binding is solution-scoped, do not raise a scary warning — print a one-line reassurance and continue: *"Managed Env: Basic — solution binding is HAR-confirmed OK on Basic. No action needed."* Only fire the warning gate below when env binding is intended (env binding on Basic is the genuinely risky combination).

<!-- gate: git-configure:2.managed-env-warn | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:2.managed-env-warn):** Fires when `verify-managed-env` returns `enabled:false` **and env binding is intended** (solution binding on Basic is fine — see step 3). Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Managed Env is OFF for `{envHost}`. Env binding is recommended only on Managed Envs; solution binding is HAR-confirmed on Basic. How do you want to proceed? | Managed Env warning | Switch to solution binding, Continue with current mode anyway, Cancel and enable Managed Env |
>
> This is warn-not-block. Cancellation leaves nothing.

4. Verify system-administrator role and Dataverse `WhoAmI`. Hard-block through `git-configure:1.prereq-fail` if the user lacks required privileges.
5. Verify BYOK/CMK with `verify-byok-cmk.js`. The POC-confirmed signal is `properties.protectionStatus.keyManagedBy`; the helper returns `{ ok, keyManagedBy: "Microsoft"|"Customer"|"Unknown", byokEnabled, hint }`.

<!-- gate: git-configure:2.byok-cmk-warn | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:2.byok-cmk-warn):** Fires when `verify-byok-cmk` returns `byokEnabled:true`. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | `{envHost}` uses customer-managed keys (`keyManagedBy=Customer`). Git integration may be subject to tenant policy. Continue? | BYOK/CMK warning | Continue, Cancel and confirm policy first |
>
> If `{ ok:false }`, show the helper `hint` and continue with an advisory; do not block solely on unknown BYOK status.

6. Verify Git-integration license/availability with `verify-license.js`. The POC-confirmed signal is `GET <envUrl>/api/data/v9.2/sourcecontrolconfigurations?$top=1`; HTTP 200 means available, HTTP 404 means unavailable.

<!-- gate: git-configure:2.license-warn | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:2.license-warn):** Fires when `verify-license` returns `gitIntegrationAvailable:false`. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Git integration entities are not reachable on `{envHost}` (status `{statusCode}`). Tenant admin may need to enable Git integration. Continue anyway? | Git integration license warning | Continue anyway, Cancel and fix tenant/license setup |
>
> Warn-not-block; show `hint` verbatim.

7. **Same-tenant ADO check (required).** The ADO org's Entra tenant must match the Dataverse env's tenant. This check is deferred until `<org>` is known: when Phase 4 selects org, run `get-ado-token.js --verifyTenant --organization <org>`. Stdout is masked and no token is persisted. A tenant mismatch is a hard stop via the gate below — it must run before any Phase 7 mutation.

<!-- gate: git-configure:2.cross-tenant-block | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-configure:2.cross-tenant-block):** HARD STOP. Fires when `get-ado-token.js --verifyTenant` reports the ADO org's tenant differs from the env's tenant. Cross-tenant Git authorship cannot be audited correctly (commits are authored by the platform service identity, not the human user — see `references/inner-loop-empirical-findings.md` §26) and is blocked by policy. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | ADO org `{org}` is in tenant `{adoTenantId}` but env `{envHost}` is in tenant `{envTenantId}`. Cross-tenant Git integration is blocked. | Cross-tenant block | Choose an ADO org in the env's tenant, Cancel |
>
> This gate has **no proceed-anyway path** — it is a hard stop. Choosing another org loops back to Phase 4 org selection. Cancellation leaves nothing. Do not improvise an override.
8. ADO permissions and repo-init checks require `<org>/<project>/<repo>/<branch>`. In headless or argument-complete runs, execute here; otherwise execute immediately after Phase 4 repo/branch selection, but use these Phase 2 gates.

<!-- gate: git-configure:2.ado-perms-fail | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-configure:2.ado-perms-fail):** Fires when `verify-ado-permissions.js` reports `ok:false` or `hasAccess:false` for the selected repo. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | ADO permissions check failed on `{org}/{project}/{repo}`: `{shortError}`. | ADO permissions failure | Pick a different repo, Cancel and fix permissions manually |
>
> Picking a different repo loops back to Phase 4 repository selection. Cancellation leaves nothing.

<!-- gate: git-configure:2.repo-init | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:2.repo-init):** Fires when `verify-repo-initialized.js` says the selected repo is empty. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Repo `{org}/{project}/{repo}` is empty. Initialize it with a README commit on `{branch}` so `ConnectToGit` can bind cleanly? | Repo initialization | Initialize now, Cancel |
>
> On initialize, call `init-ado-repo.js`. Handle `alreadyInitialized` as success, 403 as permission failure, 404 as wrong repo, and other failures verbatim. Cancellation leaves nothing.

**Output:** Preflight report is known; any warnings are acknowledged.

---

## Phase 3 — Two-Layer Explainer + Binding Strategy Choice (setup mode only)

**Goal:** In setup mode, explain env vs solution binding and choose `bindingType`.

Skip this phase for `switch-branch`, `rebind`, and `disconnect`. Also skip the choice gate when an explicit `--binding=env` or `--binding=solution` override is valid, but still mention what was selected.

<!-- gate: git-configure:3.two-layer-explainer | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-configure:3.two-layer-explainer):** Setup mode only. Show this text-only explainer in ≤8 lines, then continue to the binding choice:
>
> 1. Power Pages code sites are local source files; Dataverse Git integration is a separate server-side sync layer.
> 2. Env binding (`ConnectionType=1`) wires the whole dev env to one ADO repo/branch/folder.
> 3. Solution binding (`ConnectionType=0`) wires one unmanaged solution to ADO.
> 4. Env binding is the default for one team/one repo/one branch.
> 5. Solution binding is for per-solution repos, branches, or partial Git scope.
> 6. Solution binding has a shared-object restriction; overlapping components must be removed before commit.
> 7. Reference: `${CLAUDE_PLUGIN_ROOT}/references/binding-strategy.md`.

<!-- gate: git-configure:3.binding-type | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-configure:3.binding-type):** **This gate fires whenever the user did not pass an explicit `--binding=env` or `--binding=solution`.** Never infer the binding type from context or assume a default silently — the user must choose. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Which Git binding strategy should this environment use? | Binding strategy | Environment binding (recommended default), Solution binding for one solution, Cancel |
>
> If `--binding` was passed explicitly, skip the prompt but state which binding was selected. If solution binding is selected and no solution is explicit, drive the picker from the live helper so already-bound solutions are visible:
>
> ```bash
> node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-solutions.js" --envUrl "<envUrl>"
> ```
>
> Present each as a choice: `friendlyName (uniqueName) v{version} — prefix {publisherPrefix}`; mark rows with a non-null `boundTo` using a 🔗 and show `boundTo.repository@boundTo.branch` so the user doesn't double-bind. **Always present the list as choices for the user to pick — never auto-select, even when only one eligible solution exists** (show that single solution as the one option, plus Cancel). The helper already excludes `Active`, `Basic`, `Default`, and `CommonDataServiceDefault`.

**Output:** `bindingType` and optional `solutionUniqueName` are known.

---

## Phase 4 — Gather / Confirm ADO Coordinates

**Goal:** Let the user PICK every ADO coordinate — organization, project, repository, branch, and folder — from live, API-fetched lists. Each coordinate is a choice selection, never a silent auto-pick or a pre-filled path the user only confirms.

**Choice-centric rule (always, for interactive runs):** For each of org / project / repo / branch / folder, first fetch the available options via the live helper, then surface them as an `AskUserQuestion` choice list. Every list ends with a **"➕ Add new …"** option (create a new org-scoped project/repo/branch/folder) and a **"Cancel"** option. **Do NOT auto-select even when exactly one option exists** — present that single option as a choice the user explicitly picks. **Do NOT pre-fill a default coordinate and ask yes/no** — the user chooses from the fetched list.

The only exception is an explicit `--non-interactive` run (see the Non-interactive mode contract): there, every coordinate must be supplied as a flag, and a missing flag fails the run rather than prompting.

Steps:

0. **Dataverse-first reuse (§2).** Before the live ADO cascade, query the coordinates this env has used before — they survive even after a binding is torn down, so the user can pick a previously-used repo instead of re-entering it:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/discover-bindings.js" --envUrl "<envUrl>"
   ```

   Branch on `summary.repoCount`:
   - **0 known repos** → go to step 1 (live ADO cascade). State "first binding on this env."
   - **≥1 known repos** → present an `AskUserQuestion` **choice list** of every `{org}/{project}/{repo}` row (annotate each with its `branchConfigs` solutions/branches), then a final **"➕ Enter different coordinates"** option (→ step 1) and **"Cancel"**. Even a single known repo is shown as one pickable choice — never auto-reuse and never a yes/no.

   When the user picks a known repo, still re-run the Phase 2 same-tenant check (`git-configure:2.cross-tenant-block`) and `verify-ado-permissions.js` against it — a stored config may point at a repo the user has since lost access to. Then continue to the branch + folder pickers (steps 5-6). `gitprovider != 0` (non-Azure-DevOps) is reserved for future providers; surface the value and go to step 1 rather than assuming ADO.

1. **Organization (choice).** Call `list-ado-orgs.js` and present `orgs[].accountName` as a choice list (+ Cancel). If zero orgs, show the ADO signup hint and exit. Never auto-select a sole org — present it as the one choice. After the user picks, re-run the same-tenant token check described in Phase 2.

2. **Project (choice).** Call `list-ado-projects.js` for the chosen org and present `projects[].name` as a choice list, ending with **"➕ Create new project…"** and **"Cancel"**. If the user picks Create new (setup/rebind only), fire the create gate.

<!-- gate: git-configure:4.create-project | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:4.create-project):** Fires when the user picks "➕ Create new project…". Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Create new ADO project `{newProjectName}` in org `{org}`? Provisioning takes about 30-60 seconds. | Create project | Create now, Cancel and choose another project |
>
> On create, call `create-ado-project.js`, capture `projectId`, and loop on recoverable failures. Cancellation loops back to the project choice list.

3. **Repository (choice).** Call `list-ado-repos.js` for the chosen project and present `repos[].name` as a choice list, ending with **"➕ Create new repo…"** and **"Cancel"**. If the user picks Create new, fire the create gate.

<!-- gate: git-configure:4.create-repo | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:4.create-repo):** Fires when the user picks "➕ Create new repo…". Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Create new Git repo `{newRepoName}` in `{org}/{project}`? The repo starts empty and will need initialization. | Create repo | Create now, Cancel and choose another repo |
>
> On create, call `create-ado-repo.js`; 409 loops to name selection, other failures surface verbatim.

4. **Run deferred Phase 2 ADO checks.** After repo and branch are known, call `verify-ado-permissions.js`, `verify-repo-initialized.js`, and `init-ado-repo.js` if consented.

5. **Branch (choice).** Fetch the repo's branches and present them as a choice list — never silently default to `main` or the repo default:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/list-ado-branches.js" \
        --organization "<org>" --project "<project>" --repository "<repo>" --default-branch "<repoDefaultBranch>"
   ```

   Present `branches[]` as choices (mark the `defaultBranch` row as "(default)"), ending with **"➕ Create new branch…"** and **"Cancel"**. For switch-branch, exclude the current bound branch from the pick list (switching to the same branch is a no-op). Do not auto-create a branch — creation is an explicit pick. When the user picks **"➕ Create new branch…"**, prompt for the new name (validate as a git branch name — forward slashes allowed, e.g. `feature/dev-a`), then branch on repo state:
   - **Empty repo (`emptyRepo:true`)** — there is no base commit yet; the only branch that can be made is the repo's first one (default name `main`), seeded by `init-ado-repo.js` in step 4. No base-branch pick.
   - **Populated repo** — also prompt for the **base branch** to fork from (choice list of existing branches, default = the repo's default/bound branch), then fire the create-branch gate below. This is the path that lets switch-branch move onto a brand-new feature branch without leaving the tool.

<!-- gate: git-configure:4.create-branch | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:4.create-branch):** Fires when the user picks "➕ Create new branch…" on a NON-empty repo. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Create new branch `{newBranch}` from `{baseBranch}` in `{org}/{project}/{repo}`? It starts as an exact copy of `{baseBranch}`, so your bound content carries over. | Create branch | Create now, Cancel and choose another branch |
>
> On "Create now", call `create-ado-branch.js --organization <org> --project <project> --repository <repo> --newBranch <newBranch> --baseBranch <baseBranch>`. Treat `alreadyExists:true` as success (select the existing branch); `403` is a permission failure (needs Create Branch / Contribute), `404` means the base branch is gone (re-pick a base), other failures surface verbatim. On success, select `{newBranch}` and continue. Cancellation loops back to the branch choice list — no ADO mutation has happened.

6. **Folder (choice).** Call `list-ado-folders.js` to enumerate existing top-level folders, then present the destination as a choice list. **The presentation differs by binding type — never conflate the two:**

   - **Env binding** — the folder is a single top-level name. Present existing top-level folders + **"➕ New folder…"** + **"Cancel"**. "➕ New folder…" helper text: *"Folder name only — no slashes, no path separators."* Reject `/`, `\`, leading/trailing slash, and whitespace-only, then re-prompt.
   - **Solution binding** — the `gitFolder` is the **full repo-relative path** where this solution's files will live (Dataverse stores it verbatim and writes to `/<gitFolder>/`). Present these choices so the user never has to reason about `rootFolder` vs leaf:
     - **`solutions/{solutionUniqueName}`** (recommended — keeps every solution under a shared `solutions/` parent), shown whether or not `/solutions` exists yet.
     - **`{solutionUniqueName}`** (repo root — the solution gets its own top-level folder).
     - One option per existing top-level folder as **`{existingFolder}/{solutionUniqueName}`** (nest under a folder that already exists).
     - **"➕ Custom path…"** — helper text: *"Repo-relative path, forward slashes only (e.g. `solutions/{solutionUniqueName}`). No backslashes, no leading/trailing slash, no `.`/`..` segments."*
     - **"Cancel"**.
     Pass the chosen value through as a single `--gitFolder` (it may contain `/`); validate it with the solution-binding rules in invariant 4 before continuing. Do **not** split the path into `rootFolder` + leaf for placement — `gitFolder` alone determines where files land.

7. **Env-binding folder coexistence.** If env binding picks an existing non-empty folder, fire the coexistence gate.

<!-- gate: git-configure:4.folder-coexists | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:4.folder-coexists):** Env-binding only. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Folder `/{folder}/` already exists in `{repo}` and contains content. Dataverse will write env-bound solution files into that folder. | Existing folder | Use this folder, Go back and pick another |
>
> Choosing another loops to folder selection. Cancellation leaves nothing.

8. **Solution-binding folder occupancy.** Run `check-ado-folder-exists.js` with `--branch` and the **full** `--gitFolder` path chosen in step 6 (the helper accepts nested paths like `solutions/{name}`); if item count > 0, fire the occupancy gate.

<!-- gate: git-configure:4.folder-occupied | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:4.folder-occupied):** Solution-binding only. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Folder `/{gitFolder}/` on `{branch}` already contains `{itemCount}` item(s). `ConnectToGit` will co-locate Dataverse-managed files there. | Folder collision | Pick a different gitFolder, Pick a different repo, Proceed anyway, Cancel |
>
> Preserve `preBindFolderOccupancy` in plan data when proceeding anyway.

9. **Solution-binding shared-object overlap hard block.** Query already Git-bound solutions and compare `solutioncomponents` by `(objectid, componenttype)`.

<!-- gate: git-configure:4.shared-object-overlap | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-configure:4.shared-object-overlap):** Solution-binding only. HARD BLOCK when target solution shares components with already-bound solution(s). Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Solution `{name}` shares `{count}` component(s) with already-bound solution(s) `{otherNames}`. The first `CommitToGit` will fail until overlap is removed. How should this be resolved? | Shared-object overlap | Remove shared components from `{name}`, Remove them from `{otherNames}`, Cancel |
>
> For either remove option, call `remove-solution-component.js` for every `(componentId, componentType, solutionUniqueName)` and re-query until overlap is zero. This gate is a hard block; do not proceed with unresolved overlap.

**Output:** ADO coordinates and solution constraints are validated.

---

## Phase 5 — Workspace-Clean Gate

**Goal:** Prevent state loss before `switch-branch`, `rebind`, or `disconnect`.

Skip this phase for fresh setup. For deleted-source-branch recovery, if `detect-git-binding.js` reports an orphaned binding because the bound ADO branch is gone, short-circuit the dirty-workspace hard stop: there is no source branch left to preserve. Report that exception with a reference to `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §15.

Steps:

1. Run `list-pending-changes.js`, `list-incoming-updates.js`, and `list-conflicts.js` in parallel.
2. If any count is > 0, hard-stop.

<!-- gate: git-configure:5.workspace-dirty | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-configure:5.workspace-dirty):** Fires for switch-branch, rebind, or disconnect when Changes/Updates/Conflicts are non-zero. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Git configuration requires a clean workspace, but found Changes=`{C}`, Updates=`{U}`, Conflicts=`{X}`. Continuing would discard in-flight state. | Workspace not clean | Run /power-pages:git-sync --commit, Run /power-pages:git-sync --pull, Run /power-pages:revert-workspace, Run /power-pages:git-sync, Cancel |
>
> Do not proceed past Phase 5 unless all three counts are zero or the deleted-source-branch recovery exception applies. Cancellation leaves nothing.

**Output:** Workspace is clean or the deleted-source-branch exception is explicitly active.

---

## Phase 6 — Render Plan + Single Consent Gate

**Goal:** Persist plan data, render a concise text plan, and get a SINGLE mode-appropriate consent before mutation. There is no separate "plan approval" + "final consent" double-prompt — Phase 6's gate IS the final consent.

Steps:

1. Write plan data through `gitConfigurePath(root, 'gitConfigurePlanData')`. Include mode, envUrl, bindingType, solution metadata, old binding, new binding, ADO coordinates, preflight statuses, folder occupancy, shared-overlap results, workspace counts, and headless selections.
2. Render a concise text plan:
   - Setup/env: `ConnectToGit ConnectionType=1` for `{envUrl}` to `{org}/{project}/{repo}` branch `{branch}` folder `{folder}`.
   - Setup/solution: `ConnectToGit ConnectionType=0` for solution `{solutionUniqueName}`.
   - Switch: disconnect from `{oldBranch}` and reconnect to `{newBranch}` with other fields unchanged.
   - Rebind: disconnect current binding and reconnect to new `{org}/{project}/{repo}/{branch}/{folder}`.
   - Disconnect: remove current Git binding and clear/update local manifest.
3. Show reversibility and blast radius alongside the plan text.
4. Fire ONE gate appropriate to the mode (the gates below are mutually exclusive — exactly one fires per run). On the "Change a field" option, loop back to Phase 3 for binding type or Phase 4 for ADO coordinates, depending on what changed. Cancellation in any of these gates leaves nothing — no Dataverse mutation has happened.

   **Consent-question clarity (required).** Word every Phase 6 question so the user cannot mistake it for an earlier *planning* prompt (e.g. the binding-type or solution pick). The question MUST: (a) name the concrete action as the FINAL step — "bind", "disconnect", "rebind" — not a generic "execute {mode}"; (b) spell out the exact target (solution/env + `org/project/repo@branch` + folder); (c) state that confirming **performs the Dataverse Git change now**; and (d) make the verb on the confirm option match the action ("Bind now" / "Disconnect now" / "Rebind now"), never a bare "Yes". This is the only prompt in the run that mutates Dataverse — say so.

<!-- gate: git-configure:6.consent-setup | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:6.consent-setup):** Setup and switch-branch modes only. Single consent — combines plan review and execute. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | **Final step — apply this Git binding now?** This performs the Dataverse Git connection (the actual change), not a re-ask of an earlier choice. {For solution binding:} Bind solution `{solutionUniqueName}` to `{org}/{project}/{repo}` branch `{branch}`, folder `/{gitFolder}/`. {For env binding:} Bind environment `{envHost}` to `{org}/{project}/{repo}` branch `{branch}`, folder `/{gitFolder}/`. {For switch-branch:} Move the existing binding to branch `{branch}`. | Apply Git binding | Bind now, Change a field, Cancel |
>
> The confirm verb must reflect the action ("Bind now" for setup, "Switch branch now" for switch-branch). On confirm, proceed directly to Phase 7 dispatch (`connect-to-git.js` / `connect-solution-to-git.js` / `switch-branch.js`).

<!-- gate: git-configure:6.consent-disconnect | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:6.consent-disconnect):** Disconnect mode only. Single consent — combines plan review and execute. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Disconnect Git from `{envHost}`? This removes the current binding to `{org}/{project}/{repo}@{branch}` and drops the Source-control connection until setup/rebind runs again. | Disconnect Git | Disconnect now, Change a field, Cancel |
>
> On "Disconnect now", proceed directly to Phase 7 dispatch (`disconnect-from-git.js`).

<!-- gate: git-configure:6.consent-rebind | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:6.consent-rebind):** Rebind mode only. Single consent — combines plan review and execute. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Rebind Git on `{envHost}` from `{oldOrg}/{oldRepo}@{oldBranch}` to `{org}/{project}/{repo}@{branch}`? This disconnects the current binding and reconnects to the new coordinates; if reconnect fails after disconnect, the env may be left disconnected. | Rebind Git | Rebind now, Change a field, Cancel |
>
> On "Rebind now", proceed directly to Phase 7 dispatch (disconnect then reconnect).

**Output:** The plan is written and a single consent has been recorded.

---

## Phase 7 — Execute

**Goal:** Dispatch to the correct low-level helper. No gates fire in Phase 7 — the single consent in Phase 6 is the only mutation prompt.

Execution details:

1. **Setup/env:** call `connect-to-git.js` with `--envUrl`, `--organization`, `--project`, `--repository`, `--branch`, and `--gitFolder`.
2. **Setup/solution:** call `connect-solution-to-git.js` with `--envUrl`, `--solutionUniqueName`, ADO fields, `--gitFolder "<fullPath>"` (the full repo-relative path chosen in Phase 4 step 6 — e.g. `solutions/{name}` or `{name}`; this alone determines where files land), and `--rootFolder "<topSegment>"` (the first path segment of `gitFolder`, e.g. `solutions`; for a repo-root single-segment path pass that same name). `--rootFolder` is only required for the FIRST solution binding on the env and feeds the env-level row — it is never prepended to `gitFolder`.
3. **Switch-branch:** call `switch-branch.js --envUrl <envUrl> --newBranch <newBranch>`.
4. **Rebind:** call `disconnect-from-git.js`, poll until `detect-git-binding.js` reports unbound, then call the correct connect helper for the approved binding type.
5. **Disconnect:** call `disconnect-from-git.js` and do not reconnect.
6. Treat `ConnectToGit` HTTP timeouts that post-verify as bound (`isAsyncStillSyncing:true`) as success. Continue to Phase 8 polling; do not retry blindly.
7. If disconnect succeeds but reconnect fails, report the environment as **Disconnected**, preserve old/new plan details, and route to setup mode or diagnose.

**Output:** The requested mutation was executed or partial failure is clearly reported.

---

## Phase 8 — Verify Round-Trip + Update Manifest + Write Marker

**Goal:** Independently verify the result, update `docs/inner-loop/.git-integration-manifest.json`, and write `last-git-configure.json` through the new path helper.

Steps:

1. **Mid-flight divergence recovery (N3).** Before trusting either side, re-run `detect-git-binding.js` and compare against the local manifest with `reconcile-manifest.js`. ConnectToGit/Disconnect can half-succeed (server changed but manifest write failed, or vice-versa), leaving `serverBound XOR manifestBound`.

<!-- gate: git-configure:8.recovery | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-configure:8.recovery):** Fires when `reconcileManifest` reports `aligned:false` after the Phase 7 mutation (the mutation half-applied). Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | The Git binding half-applied: `{summary}`. Server and local manifest disagree on `{divergedFields}`. How should I recover? | Mid-flight recovery | Fix manifest from server truth, Re-execute the Phase 7 mutation, Cancel and diagnose |
>
> `Fix manifest from server truth` rewrites the manifest from `detect-git-binding`. `Re-execute` returns to Phase 7. Cancellation leaves current state and points at `/power-pages:diagnose-git-integration`.

2. Expected states: setup/rebind/switch require `bound:true` and matching fields; disconnect requires `bound:false` for env or selected solution.
3. For setup/solution, poll `solutions.sourcecontrolsyncstatus` for the bound solution until `3` (Synced) or timeout; then count pending changes with `list-pending-changes.js`.
4. **Wait for pending-changes to stabilise before reporting.** After ConnectToGit the platform asynchronously stages the rest of the solution's components, so the count climbs for a few minutes (see `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §17). Run `poll-pending-changes.js --until-stable` so the final summary reflects the settled count, not the early-poll count:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/poll-pending-changes.js" \
        --envUrl "<envUrl>" --solutionUniqueName "<name>" --until-stable
   ```

   If the result is `{ stable:false, trend:"increasing" }`, tell the user: *"Server is still ingesting components — wait until the count stabilises before running `/power-pages:git-sync --commit`. Current: `{finalCount}`."* Always report the **stable** `finalCount` (not the early count) in the Phase 8 summary.
5. For setup/env, verify the placeholder env-level commit (`sourcecontrolbranchconfigurations.branchsyncedcommitid` non-null when available) and report that zero solutions are staged until Phase 9 enables them.
6. Update the single Git-integration manifest at `docs/inner-loop/.git-integration-manifest.json` through the manifest path helper. Do not write a project-root or env-root duplicate. For bound states, write canonical binding fields. For switch, update branch and `lastVerifiedAt`; leave `lastCommitSha` unchanged. For disconnect, mark the manifest disconnected or remove only the binding fields according to the existing manifest convention; never fabricate a bound state. The `docs/inner-loop/` folder is auto-gitignored fail-closed.
7. Write the run marker with `gitConfigurePath(root, 'lastGitConfigure')`. Include `skill:"git-configure"`, `mode`, status, envUrl, oldBinding, newBinding, warnings, marker version, and timestamps.
8. **Write a per-run trace (N5).** Call `write-run-trace.js` with structured fields: mode, phase timings, gate decisions, mutations, finalState. Traces: `docs/inner-loop/git-configure-traces/<UTC-iso>.json`, 30-day/100-file retention. NEVER pass raw stdout or token values.
9. **Final summary (O3 + O6).** For bound states, print the ADO browse URL **inline** with `path=/<gitFolder>` (or `/<rootFolder>/<gitFolder>` for env binding) — user lands in the Dataverse-managed folder, not repo root. When `lastCommitSha === null`, also print: *"You may see up to 3 commits in ADO — a placeholder commit, a README commit, and your first real commit. This is normal for a fresh binding."*

**Output:** Round-trip verified, manifest updated, `last-git-configure.json` written.

---

## Phase 9 — Mode-Specific Follow-Up

**Goal:** Preserve the legacy post-bind guidance and convenience loops.

### Env-binding follow-up: discover and enable solutions

Run only when setup/rebind results in env binding. Env binding wires the environment but does not automatically stage every solution. Discover candidates with `discover-enableable-solutions.js`; if none, say so and continue to Phase 10.

<!-- gate: git-configure:9.enable-approach | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-configure:9.enable-approach):** Env-bind only. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Found `{count}` unmanaged solutions that can be enabled for source control. How should I proceed? | Enable solutions | Enable all, Pick individually, Skip |
>
> `Enable all` loops all candidates. `Pick individually` fires the per-solution gate below for each candidate. `Skip` leaves binding intact and proceeds.

<!-- gate: git-configure:9.enable-solution | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:9.enable-solution):** Env-bind only; fires PER LOOP ITERATION for each candidate in the individual-pick loop. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Enable solution `{uniqueName}` (`{friendlyName}` v`{version}`) for source control? | Per-solution enable | Enable this one, Skip this one |
>
> Consent for one solution does not cover the next solution. On consent, call `enable-solution-source-control.js --poll`. Continue on per-solution failure and summarize.

### Env-binding follow-up: initial commits for enabled solutions

Run only when Phase 9 enabled at least one solution.

<!-- gate: git-configure:9.commit-approach | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · git-configure:9.commit-approach):** Env-bind only. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | `{enabledCount}` solution(s) were enabled and have staged Changes. Push initial commits now? | Initial commits | Commit all with default messages, Commit one-by-one, Skip |
>
> `Commit all` loops all enabled solutions. `Commit one-by-one` fires the per-solution commit gate below.

<!-- gate: git-configure:9.commit-solution | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · git-configure:9.commit-solution):** Env-bind only; fires PER LOOP ITERATION for each enabled solution in the one-by-one loop. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | Commit initial pending Changes for solution `{uniqueName}` now? Default message: `Initial source-control commit for {uniqueName}`. | Per-solution commit | Commit now with default message, Commit with custom message, Skip this one |
>
> Consent for one solution does not cover the next. Custom message collection is data-gathering; validate non-empty and ≤250 chars. Call `commit-to-git.js` directly and continue on per-solution failures.

### Set up working clone

Run after binding verification, manifest write, and any placeholder or initial commit work above.

<!-- gate: git-configure:9.clone-location | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · git-configure:9.clone-location):** Surface `AskUserQuestion` according to mode:
>
> | Mode/result | Question | Header | Options |
> |---|---|---|---|
> | Setup binding | What should I name the local clone folder, and where should it live? Suggested name: `<solutionUniqueName>`, placed under `<userHome>/PowerPages/`. | Local working repo | Use suggested name, Enter a custom folder name, Choose another directory, Skip local clone |
> | Switch branch or rebind to the same repo | Use the recorded local clone for this branch? | Local working repo | Use recorded clone, Choose another directory, Skip local clone |
> | Rebind to a new repo | What should I name the local clone folder, and where should it live? Suggested name: `<solutionUniqueName>`, placed under `<userHome>/PowerPages/`. | Local working repo | Use suggested name, Enter a custom folder name, Choose another directory, Skip local clone |
> | Disconnect | Keep the recorded local clone on disk? | Local working repo | Keep it, Remove it, Decide later |
>
> When the user picks **"Enter a custom folder name"**, prompt for the folder name (validate as a single path segment — no slashes, no path separators, no `.`/`..`, not whitespace-only; re-prompt on failure), then place it under `<userHome>/PowerPages/<name>`. **"Choose another directory"** lets the user supply a full absolute path. The final `cloneDir` is `<chosenParent>/<chosenName>`. Cancel/skip leaves the binding and manifest as-is. Never remove a clone without consent.

Behavior:

- For setup binding, call `cloneOrUpdateRepo({ cloneDir, repoUrl, branch, token })`, then `writeCloneRecord({ projectRoot, clonePath: cloneDir, coordinates: { env, organization, project, repository, rootFolder, gitFolder, branch, solutionUniqueName } })`. Tell the user this is their local working repo, openable in VS Code, reused by `git-sync`; `<cloneDir>/repo` is the working tree.
- For switch-branch or same-repo rebind, read the recorded clone and reuse it: fetch, checkout the target branch (create it when the switch-branch flow created a new branch), then refresh the clone record with the new coordinates.
- For rebind to a different repo, prompt again and write a new clone record after the clone succeeds.
- For disconnect, offer to keep or remove only the recorded clone; if the user chooses remove, delete that chosen clone directory and clear only the manifest clone block.
- Acquire the Azure DevOps token in-process for the clone/update call and never write it to disk, logs, URLs, or command lines.

### Other mode follow-ups

- **Solution binding:** report pending Changes and ask in Phase 10 whether to run `/power-pages:git-sync --commit` now. Explain that `ConnectToGit` creates at most a placeholder Readme commit; the real content commit requires `git-sync --commit`. Preserve the observed `newCommitCreated` behavior from the legacy solution-binding skill.
- **Switch branch:** report that the binding points to the new branch but environment content may still reflect the old branch. Recommend `/power-pages:git-sync --pull` in Phase 10.
- **Disconnect:** re-run `detect-git-binding.js` and state clearly that the env or solution is unbound. Recommend setup mode if the user wants to connect again.

**Output:** Mode-specific follow-up work is completed or routed, and the local working clone is recorded, reused, skipped, or removed by consent.

---

## Phase 10 — Final Gate

**Goal:** Route the user to the next inner-loop action and record skill usage.

<!-- gate: git-configure:10.final | category=final | cancel-leaves=nothing -->
> 🚦 **Gate (final · git-configure:10.final):** Surface `AskUserQuestion` with options based on mode/result:
>
> | Result | Options |
> |---|---|
> | Env binding with commits | Open ADO folder, Open PR now, Enable more solutions, Done |
> | Env binding without commits | Run /power-pages:git-sync --commit per solution, Enable solutions, Open ADO folder, Done |
> | Solution binding | Run /power-pages:git-sync --commit now, Run /power-pages:git-sync --pull first, Review maker portal Changes, Done |
> | Switch branch | Run /power-pages:git-sync --pull now, Open ADO branch, Done |
> | Rebind | Run /power-pages:git-sync --pull now, Open ADO folder, Done |
> | Disconnect | Run setup mode again, Done |

Record skill usage via `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md` with skill name `GitConfigure`.

**Output:** User is routed and usage is tracked.

---

## Legacy preservation and consolidation map

Every legacy gate maps to one catalogued `git-configure` gate:

| Legacy gate(s) | New gate |
|---|---|
| `setup-git-integration:1.prereq-fail`, `connect-solution-to-git:1.prereq-fail`, `branch-switch:1.no-binding` | `git-configure:1.prereq-fail` |
| Connect-solution env mismatch prompt | `git-configure:1.envurl-mismatch` |
| Managed Env, BYOK/CMK, license, ADO perms, repo init | `git-configure:2.managed-env-warn`, `git-configure:2.byok-cmk-warn`, `git-configure:2.license-warn`, `git-configure:2.ado-perms-fail`, `git-configure:2.repo-init` |
| Legacy skill/binding selection | `git-configure:3.two-layer-explainer`, `git-configure:3.binding-type` |
| Create project/repo/branch and folder/object safety | `git-configure:4.create-project`, `git-configure:4.create-repo`, `git-configure:4.create-branch`, `git-configure:4.folder-coexists`, `git-configure:4.folder-occupied`, `git-configure:4.shared-object-overlap` |
| `branch-switch:2.workspace-dirty` | `git-configure:5.workspace-dirty` |
| Legacy plan + consent prompts | `git-configure:6.consent-setup`, `git-configure:6.consent-disconnect`, `git-configure:6.consent-rebind` |
| Env-bind enable and commit loops | `git-configure:9.enable-approach`, `git-configure:9.enable-solution`, `git-configure:9.commit-approach`, `git-configure:9.commit-solution` |
| Local clone setup | `git-configure:9.clone-location` |
| Legacy finals | `git-configure:10.final` |

Non-gate safety checks remain: in-process token acquisition, PAC/env match, env-vs-solution exclusivity, filtering, shared-object remediation, folder validation, repo init, same-tenant check, workspace-clean stop, deleted-branch recovery, timeout post-verify, correct browse URL, and verified manifest/marker writes.

## Artifacts written

| Artifact | Location | Modes | Purpose |
|---|---|---|---|
| `docs/inner-loop/.git-integration-manifest.json` | `docs/inner-loop/` (auto-gitignored) | setup, switch, rebind, disconnect | Load-bearing current binding manifest; single local-only copy. |
| Manifest `clone` block | `docs/inner-loop/.git-integration-manifest.json` | setup, switch, rebind, disconnect | Records the chosen local clone directory for reuse by `git-sync`; managed through `clone-record.js`. |
| Local working clone | `<cloneDir>/repo` with scratch at `<cloneDir>/.pp-merge` | setup, switch, rebind | User-openable working repo reused by `git-sync`; token is never persisted. |
| `last-git-configure.json` | `gitConfigurePath(root, 'lastGitConfigure')` | mutating modes | Skill-run marker for validator and routing. |
| `.git-configure-plan-data.json` | `gitConfigurePath(root, 'gitConfigurePlanData')` | all modes except early prereq fail | Audit copy of the approved plan. |

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Detect mode | Detecting mode | Call `detectGitConfigureMode` with binding + args. |
| Discover context | Discovering context | Detect code site, solution, env URL, PAC target, and binding. |
| Run preflight | Running preflight | Auth, Managed Env, sys-admin, BYOK/CMK, license, same-tenant, ADO perms, repo-init. |
| Explain binding strategy | Explaining binding strategy | Setup mode only; show two-layer explainer and choose env vs solution. |
| Gather ADO coordinates | Gathering ADO coordinates | Choice-centric org/project/repo/branch/folder pickers fetched live (Add new + Cancel); no auto-select. |
| Verify workspace clean | Verifying workspace clean | Switch/rebind/disconnect only; block on Changes/Updates/Conflicts. |
| Render plan + consent | Rendering plan and getting consent | Write plan data and fire ONE mode-appropriate consent gate (setup/switch, disconnect, or rebind). |
| Execute configuration | Executing configuration | Dispatch to connect, switch, rebind, or disconnect helper (no gates). |
| Verify and write markers | Verifying configuration | Re-query binding, update manifest, write marker. |
| Run follow-up | Running follow-up | Enable/commit loops, local clone gate, sync suggestion, commit suggestion, or disconnect clone choice. |
| Final route | Finalising | Final gate and skill tracking. |

## Key decision points

1. Phase 1: confirm/switch target environment (`git-configure:1.env-confirm`).
2. Phase 1: prereq fail or impossible mode (`git-configure:1.prereq-fail`).
3. Phase 1: explicit env URL differs from PAC target (`git-configure:1.envurl-mismatch`).
4. Phase 2: Managed Env warning (`git-configure:2.managed-env-warn`).
5. Phase 2: BYOK/CMK warning (`git-configure:2.byok-cmk-warn`).
6. Phase 2: license warning (`git-configure:2.license-warn`).
7. Phase 2: ADO permissions failure (`git-configure:2.ado-perms-fail`).
8. Phase 2: empty repo initialization (`git-configure:2.repo-init`).
9. Phase 3: two-layer explainer and binding choice (`git-configure:3.two-layer-explainer`, `git-configure:3.binding-type`).
10. Phase 4: create project/repo/branch, folder co-existence, folder occupancy, shared-object overlap.
11. Phase 5: workspace dirty hard stop.
12. Phase 6: single mode-appropriate consent — `git-configure:6.consent-setup` (setup/switch) OR `git-configure:6.consent-disconnect` OR `git-configure:6.consent-rebind`. Plan-render is rolled into the same prompt; Phase 7 has no gates.
13. Phase 7: pure execution and partial-failure reporting (no gates).
14. Phase 9: env-bind solution enable and initial commit loops; local working clone (`git-configure:9.clone-location`).
15. Phase 10: final routing.

**Begin with Phase 0: Mode Detection.**
