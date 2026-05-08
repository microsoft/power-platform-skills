---
name: plan-alm
description: >-
  Creates an ALM (Application Lifecycle Management) plan for deploying a Power Pages
  site across environments. Gathers your promotion strategy, target environments, and
  approval requirements upfront, generates a visual HTML plan document for review, then
  — after your approval — executes the plan by calling setup-solution, setup-pipeline,
  export-solution, and deploy-pipeline (or import-solution) in sequence.
  Use when asked to: "plan my alm", "set up alm", "create deployment plan",
  "plan my deployments", "help me deploy to multiple environments",
  "set up promotion strategy", "create cicd plan", "plan site promotion",
  "help me go to production", "set up pipeline for my site".
user-invocable: true
argument-hint: "Optional: 'pipelines' or 'manual' to skip strategy selection"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

# plan-alm

An 8-phase orchestrator that gathers ALM strategy from the user, generates an HTML deployment plan, gets approval, then executes the plan by calling existing skills in sequence.

## Overview

This skill detects the current project state (existing solution, pipeline), asks targeted questions about the desired promotion strategy (Power Platform Pipelines or Manual export/import), generates a visual `docs/alm-plan.html`, gets user approval, and then invokes `setup-solution`, `setup-pipeline` (or `export-solution`), and `deploy-pipeline` (or `import-solution`) in the correct order.

**Do NOT create tasks at the start** — strategy is unknown until Phase 2 completes. Create all tasks in Phase 3 once the strategy is determined.

---

## Phase 1 — Detect Project State

**Do NOT create tasks yet.** Use natural language progress reporting only during this phase.

Steps:

0. **Detect prior ALM deferral for this project.** Before any discovery work, check whether the project root contains a `.alm-deferred` marker file. The marker is written by users who explicitly opted ALM-skill validators out of "missing artifacts" warnings (e.g. *"this site is handled separately"* or *"ni-dev — no ALM"*). If a user is now invoking `plan-alm`, we should surface that the marker is present and ask what to do, rather than silently proceeding (which would build a plan the user previously decided not to maintain) or silently removing the marker (which would re-enable nags on every other ALM skill).

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/check-alm-plan.js" --projectRoot "."
   ```

   The helper returns `{ deferred, deferral, ... }`. If `deferred === true`, read the deferral reason (`deferral.reason` or the raw marker text) and ask via `AskUserQuestion`:

   > "This project has an `.alm-deferred` marker — `{reason}`. ALM was previously deferred here, so the other ALM skills (`setup-solution`, `setup-pipeline`, `deploy-pipeline`, …) skip their plan-completeness checks for this project. How would you like to proceed?"

   | Question | Header | Options |
   |---|---|---|
   | How would you like to proceed? | ALM deferral marker | Continue planning and remove the marker (Recommended), Continue planning but keep the marker (record deferral context in plan), Cancel |

   - **Continue and remove marker (Recommended)** → delete `.alm-deferred` (the user is re-engaging with ALM). Set `DEFERRAL_CLEARED = true` and proceed to step 1.
   - **Continue and keep marker** → set `DEFERRAL_PRESERVED = true` and `DEFERRAL_REASON = {reason}`. Proceed to step 1. Surface a one-line note in the Phase 1 step 9 user report (e.g. *"Note: `.alm-deferred` is preserved — other ALM skills will continue to skip plan-completeness checks for this project."*) so the user remembers the marker remains in effect after planning.
   - **Cancel** → exit cleanly (don't touch the marker).

   If `deferred === false`, skip this step silently and proceed to step 1.

1. **Resolve the site identity from the local project.** ALM skills are normally invoked from a site-root directory where `pac pages download-code-site` (or a create-site scaffold followed by a deploy) has written `.powerpages-site/website.yml`. That YAML file is the source of truth for `websiteRecordId` and `siteName`.

   **Resolution order** (first match wins):
   1. **`.powerpages-site/website.yml`** (preferred, present for every deployed site) — read with the `Read` tool and extract:
      - `id` field → `websiteRecordId`
      - `name` field → `siteName` (the file uses short keys; it is `name:`, not `adx_name:`)
   2. **`powerpages.config.json`** (fallback, used during plugin development from this repo root or for sites scaffolded but not yet deployed) — read `siteName` and `websiteRecordId`.

   If neither is found, stop with:
   > "No Power Pages site found in the current directory. Run this skill from your site project root (where `.powerpages-site/` exists after `pac pages download-code-site`). If you haven't created the site yet, run `/power-pages:create-site` first."

   `environmentUrl` is always re-confirmed from `pac env who` in step 4 — it does not need to come from either source.

2. Check for `.solution-manifest.json` in the project root:
   - Store `SOLUTION_DONE = true` if found, `false` otherwise
   - If found, read `solution.uniqueName` and store as `SOLUTION_UNIQUE_NAME`

3. Check for `.last-pipeline.json` in the project root:
   - Store `PIPELINE_DONE = true` if found, `false` otherwise
   - If found, read `pipelineName` and `stages[]` for later use

4. Run silently:
   ```bash
   pac env who
   ```
   Capture the `Environment URL` and display name. Store as `DEV_ENV_URL` and `DEV_ENV_NAME`.

5. Run silently:
   ```bash
   pac env list --output json 2>/dev/null
   ```
   Store output as `ENV_LIST` for pre-filling environment URLs in Phase 2.

6. Acquire dev environment token (silently):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-alm-prerequisites.js" --envUrl "{DEV_ENV_URL}"
   ```
   Store `.token` as `DEV_TOKEN` and `.userId` as `userId`. If this fails (auth error), set `DEV_TOKEN = null` and continue — contents discovery will be skipped gracefully.

7. Discover and classify site settings (if `DEV_TOKEN` is available and `websiteRecordId` is known):

   Use Node.js `https` module to query:
   ```
   GET {DEV_ENV_URL}/api/data/v9.2/mspp_sitesettings?$filter=_mspp_websiteid_value eq '{websiteRecordId}'&$select=mspp_name,mspp_value&$top=500
   Authorization: Bearer {DEV_TOKEN}
   ```

   Classify each returned setting using this three-tier logic:

   **Tier 1 — Credential-style (needs per-credential decision in setup-solution):**
   Name matches `/ConsumerKey|ConsumerSecret|ClientId|ClientSecret|AppSecret|AppKey|ApiKey|Password/i`
   These are OAuth/identity credential fields. Setup-solution will ask, per credential, whether to: (a) promote to a Secret-typed environment variable (Key Vault-backed, value set per stage), (b) promote to a String-typed environment variable (plain text per stage — for values that vary per environment but aren't secret-grade), or (c) skip (don't add to solution; user manages out-of-band).
   → **`credentialNeedsDecision`**: capture the name + dev value so setup-solution can present the per-credential choice.

   **Tier 2 — Auth config (per-environment auth settings):**
   Name matches `Authentication/` or `AzureAD/` (but NOT in Tier 1).
   These are authentication feature flags and configuration that may differ per environment.
   - If `mspp_value` is non-empty → **`promoteToEnvVar`**: recommend promoting to an environment variable during `setup-solution` so staging/production can use different values
   - If `mspp_value` is null or empty → **`authNoValue`**: include in solution as-is (no secret to protect), but show a note that this is an auth setting with no dev value and the user should verify the correct value is set in each target environment after deployment

   **Tier 3 — Regular settings (all others):**
   Everything else — Search, Bootstrap, WebApi field lists, feature flags, site tracking, etc.
   → **`keepAsIs`**: include in solution as-is regardless of whether a value is set. These settings do not need per-environment variation and no special treatment is required.

   Store as:
   ```js
   SITE_SETTINGS_DATA = {
     keepAsIs: [{name}],                          // regular settings (Tier 3)
     authNoValue: [{name}],                       // auth config with no dev value (Tier 2, no value)
     promoteToEnvVar: [{name, value}],            // auth config with dev value (Tier 2, has value)
     credentialNeedsDecision: [{name, value}]     // credential-style — setup-solution prompts per credential (Tier 1)
   }
   ```
   If the query fails, set `SITE_SETTINGS_DATA = null` and continue.

8. Build `SOLUTION_CONTENTS_DATA`:
   ```js
   {
     tables: solutionManifest?.components?.tables || [],     // from .solution-manifest.json if SOLUTION_DONE
     botComponents: solutionManifest?.botComponents || [],   // from manifest if available
     siteSettings: SITE_SETTINGS_DATA                        // from step 7, or null
   }
   ```
   If `SOLUTION_DONE = false` and manifest is absent, `tables` and `botComponents` will be empty arrays — the plan will show a note that they will be discovered during setup-solution.

9. Report to user:
   ```
   Found: **{siteName}** on `{devEnvUrl}`.
   Solution: {✓ already set up ({solutionUniqueName}) / ✗ not yet}.
   Pipeline: {✓ already set up ({pipelineName}) / ✗ not yet}.
   Site settings: {N total — K regular (keep as-is), P auth settings to review for env var, A auth settings (no dev value), C credential-style settings (setup-solution will prompt per credential) / unable to query}.
   ```

10. **Estimate solution size and evaluate the split decision tree.** Run the estimate helper to classify the site across size, component count, schema heaviness, web file aggregate, and env var count. Use the tmp-file write pattern — if the estimator fails, a prior good `.alm-size-estimate.json` is preserved instead of being overwritten with an empty/partial file:
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/estimate-solution-size.js" \
      --envUrl "{DEV_ENV_URL}" --websiteRecordId "{websiteRecordId}" \
      --publisherPrefix "{publisherPrefix}" --siteName "{siteName}" \
      --datamodelManifest "./.datamodel-manifest.json" > ./.alm-size-estimate.json.tmp \
      && mv ./.alm-size-estimate.json.tmp ./.alm-size-estimate.json
    ```
    Then run the decision tree (same tmp-file pattern):
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/compute-split-plan.js" \
      --estimate ./.alm-size-estimate.json \
      --projectRoot "." \
      --siteName "{siteName}" \
      --publisherPrefix "{publisherPrefix}" > ./.alm-split-plan.json.tmp \
      && mv ./.alm-split-plan.json.tmp ./.alm-split-plan.json
    ```
    If either command exits non-zero, stop and report the stderr message to the user. Do not proceed to Q1b in Phase 2 without a valid split plan.
    Store the output as `SPLIT_PLAN`. Fields to read: `splitStrategy`, `proposedSolutions[]`, `appliedStrategies[]`, `assetAdvisory`, `sizeAnalysis`, `recommendations[]`.

    If `SPLIT_PLAN.proposedSolutions.length > 1`, set `RECOMMEND_SPLIT = true`. Otherwise `false`.

    Report to the user:
    ```
    Estimated size: {totalSizeMB} MB — components: {count} — tier: {overall tier}.
    Decision tree result: {splitStrategy} → {N} solutions recommended.
    Asset advisory: {K} files flagged for Azure Blob externalization.
    ```

10b. **Enumerate environment variable definitions** (runs whenever `DEV_TOKEN` is available — the size estimator gives a count but not per-variable metadata).

    The renderer's Env Variables tab needs schema name, type, default value, and bound site setting per definition. Without this step, the tab can only show a count-summary note while the size signal and the warning quote a number — three views that don't fully agree. Running this query produces the row-level data so the table renders properly.

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/discover-env-var-definitions.js" \
      --envUrl "{DEV_ENV_URL}" --token "{DEV_TOKEN}" \
      --publisherPrefix "{publisherPrefix}" \
      --websiteRecordId "{websiteRecordId}" > ./.alm-env-vars.json.tmp \
      && mv ./.alm-env-vars.json.tmp ./.alm-env-vars.json
    ```

    Read the JSON: `{ envVars: [{ schemaName, type, defaultValue, siteSetting }], count }`. Store the array as `ENV_VARS_DETAILS` for use when building `planData.envVars` in Phase 3 (see line ~659 — pass through `ENV_VARS_DETAILS` unchanged).

    The helper degrades gracefully (returns `{ envVars: [], count: 0 }`) when the publisher prefix is unknown, the token has expired, or the query errors. In those cases the renderer falls back to the size estimator's count via `sizeAnalysis.envVarCount.value` (commit `8cbc39a`) — `ENV_VARS_DETAILS = []` is acceptable.

    **Skip rule**: if `DEV_TOKEN` is null (auth was unavailable in step 6), skip this step and set `ENV_VARS_DETAILS = []`. The renderer's count-summary fallback covers this case.

11. **Pre-plan completeness check** (only runs when `SOLUTION_DONE = true`).

    Before the user approves a plan, verify the existing solution already covers everything on the live site. Components created after the last `/power-pages:setup-solution` run (server logic from `add-server-logic`, flows from `add-cloud-flow`, env vars from `configure-env-variables` or `setup-auth`) are silently excluded from any plan built on top of a stale solution.

    Run the shared discovery helper against the source environment:

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/discover-site-components.js" \
      --envUrl "{envUrl}" --token "{token}" \
      --siteId "{websiteRecordId from powerpages.config.json}" \
      --publisherPrefix "{solutionManifest.publisher.prefix}" \
      --solutionId "{solutionManifest.solution.solutionId}"
    ```

    Parse stdout and evaluate `missing.*`:

    - **All `missing.*` arrays empty** → report "Solution contents match the site — proceeding with fresh plan inputs." Continue to Phase 2.
    - **Any non-empty `missing.*` array** → report a compact summary:
      > "Your solution is **missing {N} component(s)** that exist on the site:
      >
      > - **{X}** site components (e.g. {first 3 names})
      > - **{L}** site languages (powerpagesitelanguage — required; without these the target site silently fails to render post-auth)
      > - **{Y}** cloud flows
      > - **{Z}** environment variable definitions
      > - **{W}** custom tables
      >
      > A plan built now will ignore these components. How would you like to proceed?"

      Always render the **site languages** line when `missing.siteLanguages.length > 0`, even when other categories are zero — this gap was a recurring silent-failure mode before discover-site-components started enumerating `powerpagesitelanguages`. See `references/solution-api-patterns.md` for the 3-entity model.

      Ask via `AskUserQuestion`:

      | Question | Header | Options |
      |---|---|---|
      | Run `/power-pages:setup-solution` in sync mode to adopt the missing components before planning? | Completeness Check | Yes — sync first (Recommended), No — plan with current solution contents, Cancel |

      - **Yes, sync first (Recommended)**: invoke `/power-pages:setup-solution` (auto-detects the existing manifest and enters sync mode). After it completes, re-run the discovery helper; if `missing.*` is now empty proceed to Phase 2, otherwise repeat the prompt.
      - **No, plan with current contents**: store the gap summary as `KNOWN_GAPS` so Phase 3 can surface it in the plan HTML's Risks section, then continue.
      - **Cancel**: stop the skill so the user can investigate.

    > **Why this exists**: the same check runs at export (`export-solution` Phase 2.5) and deploy (`deploy-pipeline` Phase 3.5). Adding it here catches gaps at the earliest possible gate — before the user invests time reviewing a plan built on stale inputs. See AGENTS.md → ALM-aware by default.

    > **Skip when `SOLUTION_DONE = false`**: if there is no manifest yet, there is nothing to be stale against — Phase 2 Q1 will handle first-time solution setup.

12. **Run host resolution** (PP Pipelines path only — runs after the completeness check).

    **Skip rule:** if `PIPELINE_DONE = true`, skip this step entirely — the host info comes from `.last-pipeline.json`. Only fresh-pipeline projects need resolution.

    Acquire a BAP-audience access token (the BAP API uses a different audience than Dataverse):
    ```bash
    az account get-access-token --resource "https://service.powerapps.com/" --query accessToken -o tsv
    ```
    Capture the output as `BAP_TOKEN`. If acquisition fails, set `HOST_RESOLUTION = { status: 'DetectionFailed', error: '<stderr>' }` and skip the detect call.

    Run the detect-only wrapper. Use the same tmp-file-then-mv pattern as Phase 1 step 10 so a prior good `.alm-host-resolution.json` is preserved if the script fails mid-write. Pass `--skus Production,Sandbox,Trial` so trial-license and developer tenants see their eligible envs in the env-first menu (the helper's default is `Production,Sandbox`; we widen to include Trial here because plan-alm's NoHost branch always offers an existing-env install path that Trial envs can take, even though Trial envs cannot use the create-new fast-path):
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ensure-pipelines-host-detect.js" \
      --envUrl "{DEV_ENV_URL}" --token "{DEV_TOKEN}" --userId "{userId}" \
      --bapToken "{BAP_TOKEN}" \
      --projectRoot "." \
      --cacheMaxAgeHours 24 \
      --skus Production,Sandbox,Trial > ./.alm-host-resolution.json.tmp \
      && mv ./.alm-host-resolution.json.tmp ./.alm-host-resolution.json
    ```

    > **Note**: `ensure-pipelines-host-detect.js` is a **detection-only wrapper** the `ensure-pipelines-host` skill exposes for orchestrators. It runs Phases 1.0 (cache fast-path) + 2 (resolution order including tenant-wide enumeration) + 5 (verify if a host is found) of that workflow, but never enters Phase 3 (decision tree) or Phase 4 (provisioning). Output matches the `.last-host-check.json` schemaVersion 2 with `actionTaken: "none"` always.

    **Failure handling:** if the detection script exits non-zero, set `HOST_RESOLUTION = { status: 'DetectionFailed', error: '<stderr>' }` and continue. Phase 2 Q4 falls back to today's "enter URL manually" branch.

    On success, parse `.alm-host-resolution.json` and store as `HOST_RESOLUTION` (mapping the wrapper's field names into the plan-alm shape):
    ```js
    HOST_RESOLUTION = {
      status: parsed.resolutionStatus,                  // one of: AvailableUsingCustomHost | AvailableUsingCustomHostByAdminDefault | AvailableUsingPlatformHost | AvailableUnboundCustomHost | MultipleUnboundCustomHosts | PlatformHostExistsUnbound | CannotRedirect | NoHost | OrgSettingStale | PermissionDenied
      finalHostEnvUrl: parsed.finalHostEnvUrl,          // string | null
      finalHostEnvId: parsed.finalHostEnvId,            // string | null
      hostType: parsed.isPlatformHost ? 'platform' : (parsed.finalHostEnvUrl ? 'custom' : null),
      pipelinesSolutionVersion: parsed.pipelinesSolutionVersion,  // string | null
      candidates: parsed.candidates                     // { existingCustomHosts[], existingPlatformHost, eligibleForAppInstall[], inaccessibleEnvs[] }
    }
    ```

    Report a single line:
    ```
    Pipeline host: {finalHostEnvUrl} ({status})
    ```
    or, when no URL is set yet:
    ```
    Pipeline host: will be ensured during setup-pipeline ({status})
    ```

---

## Phase 2 — Gather ALM Strategy

Ask questions in sequence. **Solution is always Q1** — it is the prerequisite for all other steps. Branch after Q2 based on promotion strategy selection.

### Q1 — Solution Setup (always asked first)

**If `SOLUTION_DONE = true`** (manifest found in Phase 1):

Ask via `AskUserQuestion`:
> "A Dataverse solution is already configured for this site: **{SOLUTION_UNIQUE_NAME}**. Use this existing solution?"

Options:
1. **Yes, use the existing solution** — `setup-solution` will be skipped in the plan
2. **No, create a new solution** — set `SOLUTION_DONE = false`; `setup-solution` will run

**If `SOLUTION_DONE = false`** (no manifest found):

Tell the user (not via `AskUserQuestion` — informational only):
> "No Dataverse solution is set up for this site yet. **`setup-solution` will be the first step in your plan.** The publisher prefix you choose during setup is irreversible — choose carefully."

Ask via `AskUserQuestion`:
> "Ready to include solution setup in the plan?"

Options:
1. **Yes, include solution setup** — continue
2. **I already have a solution (enter name)** — accept free-text solution unique name, set `SOLUTION_DONE = true`, `SOLUTION_UNIQUE_NAME = user input`

---

### Q1b — Split Recommendation (only if `RECOMMEND_SPLIT = true`)

The decision tree from Phase 1 Step 10 recommended splitting into multiple solutions. Ask via `AskUserQuestion`:

> "Based on the site size and component analysis, the recommended approach is **{splitStrategy}** — {N} solutions instead of one. Do you want to follow this recommendation?"

Options:
1. **Use the recommended split** — proceed with `proposedSolutions[]` from the decision tree. `setup-solution` will create all N solutions.
2. **Keep as a single solution anyway** — override to single. Record override reason; `setup-solution` creates one solution with all components.
3. **Accept Asset Advisory first** (only offered if `assetAdvisory.candidates.length > 0`) — user commits to externalizing the flagged assets. Recompute size excluding those files, re-run the decision tree, present the new recommendation.
4. **Show me migration guidance** (only offered if an existing `.solution-manifest.json` is found and does not match the recommendation) — produce `docs/alm-migration-plan.md` and exit. Do not execute.

**If option 1:** continue with `proposedSolutions`.
**If option 2:** override `SPLIT_PLAN.proposedSolutions` to the single-solution structure for rendering; record `overrideReason` in the plan.
**If option 3:** subtract advisory candidate sizes from the estimate, re-run `compute-split-plan.js`, re-present.
**If option 4:** write `docs/alm-migration-plan.md` (see the spec doc `solution-splitting-logic.md` §7), commit it, mark plan as Deferred, exit.

---

### Q2 — Strategy Selection (always asked)

Ask via `AskUserQuestion`:

> "How do you want to promote your solution between environments?"

Options:
1. **Power Platform Pipelines** — Microsoft's native CI/CD, managed deployments, approval gates
2. **Manual export/import** — export a zip from dev and import directly to each target environment
3. **I already have a pipeline set up** — run a deployment now
4. **Help me decide** — show a quick comparison

**If option 4 selected:** Explain:
> "Power Platform Pipelines is recommended for teams and multiple environments — it provides automated promotion, approval gates, and deployment history in one place. Manual export/import is simpler for one-off migrations or when you only need to deploy once. For ongoing CI/CD, choose Power Platform Pipelines."

Then re-ask Q2 with only options 1–3.

**If option 3 selected:** Read `.last-pipeline.json`, confirm pipeline name and stages, then skip to Phase 3 (generate plan) with `strategy = pp-pipelines`, `PIPELINE_DONE = true`.

---

### PP Pipelines Path — Q3 through Q7

**Q3:** Ask via `AskUserQuestion`:
> "How many deployment stages do you want in this pipeline?"

Options:
1. **Staging only** — Dev → Staging (I'll add Production later)
2. **Staging + Production** — Dev → Staging → Production (full promotion chain)
3. **Production directly** — Dev → Production only (bypass staging)
4. **Custom** — I'll describe my own stage layout

If option 4: accept free-text description (via "Other") and build a stage list from the response.

Store stages as `PP_STAGES` (array of `{ label, envUrl, envName, type }`). Dev is always the source.

For each stage, populate `envName` from `ENV_LIST` (gathered in Phase 1 Step 5 via `pac env list --output json`). Match by URL origin (lowercase, trailing slash stripped, path/query ignored) and copy the entry's `DisplayName` (or `displayName`) into `envName`. When no match is found — usually because the user pasted a custom URL via "Other" — leave `envName` unset; the renderer falls back to showing the URL alone in the stage card. The renderer puts `envName` between the stage label and the URL (e.g. *Staging / **Supplier Portal Staging** / https://orgd6a9894f.crm5.dynamics.com/*) so reviewers recognize the env at a glance and the URL stays available as a one-click jump-to-env. Set `type: "source"` for the dev/source stage and `type: "target"` for every downstream stage so the renderer applies the active-stage styling correctly.

**Q4 (host environment — branches on `HOST_RESOLUTION.status` from Phase 1 step 12):**

This question consumes `HOST_RESOLUTION` populated by the new detect-only wrapper run in Phase 1 step 12. Each branch sets `HOST_ENV_URL` (which feeds the rest of plan-alm) and may also set the auxiliary flags `CHOSEN_ENV_URL`, `WILL_PROVISION_PLATFORM`, `WILL_PROVISION_CUSTOM`, `WILL_USE_PPAC`, `WILL_ENSURE_HOST`, and `USER_CHOSE_DEFER_TO_SETUP_PIPELINE`. Defaults: `HOST_ENV_URL = HOST_RESOLUTION.finalHostEnvUrl`, all flags `false` / null.

**Why the NoHost branch presents the env-first menu here instead of deferring to ensure-pipelines-host Phase 3.C:** the original design asked a yes/no "we'll provision new — continue?" question in plan-alm and let 3.C surface the env-first choice at execution time. In practice the agent treated the plan-alm yes-confirmation as authorization to skip 3.C entirely (or to skip 4.A's pre-call gate), and users hit 4.A → 409 trial-license errors when an existing env install (4.B) would have been a clean path. Surfacing the env-first menu **here** — once, at planning time, when the user has full context — eliminates the ambiguity. ensure-pipelines-host then trusts `CHOSEN_ENV_URL` and skips its own 3.C menu (see ensure-pipelines-host Phase 3 skip rule).

| `status` | Q4 prompt | Result |
|---|---|---|
| `AvailableUsingCustomHost`, `AvailableUsingCustomHostByAdminDefault`, `AvailableUsingPlatformHost` | "Detected host `{finalHostEnvUrl}` (Pipelines v`{pipelinesSolutionVersion}`). Use this host?" Options: 1. Yes, use this / 2. Use a different host environment (Other) | Y → `HOST_ENV_URL = HOST_RESOLUTION.finalHostEnvUrl`. N → fall back to today's "enter different URL" branch (free-text via Other). |
| `AvailableUnboundCustomHost` | "Existing Custom Host `{displayName}` (`{finalHostEnvUrl}`) found in tenant — not yet bound to dev env. setup-pipeline will reuse it (recommended; avoids duplicates). Use this host?" Options: 1. Yes, use this / 2. Use a different host environment (Other) | Y → `HOST_ENV_URL = HOST_RESOLUTION.finalHostEnvUrl`, `WILL_ENSURE_HOST = true`. N → fall back to "enter different URL". |
| `MultipleUnboundCustomHosts` | "{N} Custom Hosts found in tenant. Which one should setup-pipeline use?" Options: enumerate `HOST_RESOLUTION.candidates.existingCustomHosts[]` (up to 3) by display name + URL, plus "Other" for a custom URL, plus "Decide later — setup-pipeline will ask". | Picked candidate → `HOST_ENV_URL = candidate.instanceApiUrl`, `WILL_ENSURE_HOST = true`. Decide-later → `HOST_ENV_URL = null`, `WILL_ENSURE_HOST = true`, `USER_CHOSE_DEFER_TO_SETUP_PIPELINE = true`. |
| `PlatformHostExistsUnbound` | "Tenant Platform Host `{finalHostEnvUrl}` exists. Use it (no admin role required) or create a new Custom Host?" Options: 1. Use Platform Host / 2. Create new Custom Host / 3. Cancel | 1 → `HOST_ENV_URL = HOST_RESOLUTION.finalHostEnvUrl`, `WILL_ENSURE_HOST = true`. 2 → `HOST_ENV_URL = null`, `WILL_PROVISION_CUSTOM = true`, `WILL_ENSURE_HOST = true`. 3 → exit. |
| `NoHost` | **Host-type prompt** — same shape as `ensure-pipelines-host` Phase 3.C so the user makes the host choice once, here, instead of being asked again at execution time. Present: *"No Pipelines host bound to `{devEnvUrl}`. Which environment should host Pipelines? Pipelines lives in one env per tenant; pipelines, stages, and run history are stored there. Source envs deploy through it."* Top-level options: **1.** "Provision a Platform Host (recommended) — Microsoft-managed Dataverse env auto-provisioned in your tenant home geo. Pipelines app pre-installed. Idempotent. ~3–5 min." **2.** "Set up a Custom Host — Pipelines lives in a Dataverse env you control. We'll ask whether to use an existing env or create a brand-new dedicated one." **3.** "Open PPAC and create one manually (admin fallback)." **4.** "Switch to Manual export/import strategy." **5.** "Cancel." When the user picks Option 2, surface the **Custom-Host sub-prompt**: build the eligible-env list from `HOST_RESOLUTION.candidates.eligibleForAppInstall[]` with role labels (`dev env`, `source env`, `staging env`, `production env`) per origin match; cap the visible list at 5 envs with role-aware ranking (see "Eligible-env presentation cap" below). Sub-options: **a.** Each visible env (display name + URL + role labels) labeled "*Install Pipelines app on this env*" — sandbox-sku envs add a "(Sandbox — confirmation gate)" suffix; append "Other (paste URL)" as the last per-env entry. **b.** "Create a brand-new dedicated env (D365_ProjectHost template, ~5–10 min, requires Power Platform admin)." **c.** "Back — return to host-type menu." When the eligible list is empty, drop sub-option `a` and present only `b` / `c`. | Option 1 (Platform Host) → `HOST_ENV_URL = null`, `WILL_PROVISION_PLATFORM = true`, `WILL_ENSURE_HOST = true`. Option 2 → sub-prompt; sub-option `a` picked env → `HOST_ENV_URL = picked.instanceApiUrl`, `CHOSEN_ENV_URL = picked.instanceApiUrl`, `WILL_ENSURE_HOST = true` (Sandbox confirmation gate, if applicable, must be passed before this resolution stands; "Other (paste URL)" → ask for the env URL via free-text, then proceed as a picked eligible env); sub-option `b` → `HOST_ENV_URL = null`, `WILL_PROVISION_CUSTOM = true`, `WILL_ENSURE_HOST = true`; sub-option `c` → re-show top-level menu. Option 3 (PPAC) → `HOST_ENV_URL = null`, `WILL_USE_PPAC = true`, `WILL_ENSURE_HOST = true`. Option 4 (Manual strategy) → restart Phase 2 with `STRATEGY = manual`. Option 5 → exit. |
| `CannotRedirect` | **Block.** Show the org-setting vs tenant-default mismatch error from `HOST_RESOLUTION.candidates`/`warnings` and stop the skill — only a Power Platform admin can resolve. | Exit with the specific error. |
| `OrgSettingStale`, `PermissionDenied`, `DetectionFailed` | Surface the error; ask the user to enter the host URL manually with `pac env list` pre-fill (today's fallback). Pre-fill options from `ENV_LIST` (up to 3 known environment URLs) plus "Other" for a custom URL; pre-fill first option from `.last-pipeline.json` if present. | `HOST_ENV_URL = user-supplied`. |

Store the resulting `HOST_ENV_URL` for use by the rest of plan-alm. The auxiliary flags `CHOSEN_ENV_URL`, `WILL_PROVISION_PLATFORM`, `WILL_PROVISION_CUSTOM`, `WILL_USE_PPAC`, `WILL_ENSURE_HOST`, and `USER_CHOSE_DEFER_TO_SETUP_PIPELINE` feed the planData `hostResolution` block in Phase 3 and the inline summary in Phase 4. ensure-pipelines-host reads `chosenEnvUrl`, `willProvisionPlatform`, `willProvisionCustom`, and `willUsePpac` from that block to bypass its own Phase 3.C menu when the user has already made the choice here.

**Eligible-env presentation cap** (used by the `NoHost` row above and by `MultipleUnboundCustomHosts`). When the eligible list runs long, build the visible options as follows so the prompt stays scannable:

1. **Always-visible role-labeled envs first.** Include any eligible env carrying a `dev env`, `source env`, `staging env`, or `production env` label (matched by URL origin against `devEnvUrl` and against `PP_STAGES[].envUrl`). These are the project's own envs and are nearly always the right pick. Dedupe by origin.
2. **Fill remaining slots up to 5** from the rest of the eligible list, in the order returned by `list-tenant-envs.js` (name-hint pattern `pipeline|deploy|host|alm|cicd|govern` → admin-perms → recency).
3. **Append "Other (paste URL)"** as the last per-env entry inside option 1's nested list — escape hatch for envs that didn't make the cap.
4. When `eligible.length > 5`, suffix option 1's headline with: ` Showing top 5 of {N}; the remaining {N-5} eligible env(s) can be reached via the "Other (paste URL)" entry.` When `eligible.length <= 5`, no suffix (all envs visible inline).
5. When the user picks "Other (paste URL)", pre-fill the URL input with `ENV_LIST` (the `pac env list --output json` output gathered in Phase 1) so they can paste-or-pick from the full inventory rather than typing a URL by hand.

The same cap policy applies to `ensure-pipelines-host` Phase 3.C — see that skill's Step 3a for the same rules. Keep the two implementations consistent so users see the same prompt shape regardless of whether they enter via plan-alm or directly via setup-pipeline → ensure-pipelines-host.

**Q5:** Ask via `AskUserQuestion`:
> "Should deployments require approval before each stage?"

Options:
1. Required before each stage (Recommended for production)
2. Staging auto-approve, production requires approval
3. No approval gates — deploy automatically

Store as `PP_APPROVAL_MODE`.

**Note:** PP Pipelines always exports as a **managed** solution to target environments. Set `EXPORT_TYPE = "managed"` automatically — no question needed.

**Q6 (auto-detect, no question):** Resolve `HAS_ENV_VARS` in this order:

1. If `ENV_VARS_DETAILS.length > 0` (Phase 1 Step 10b returned per-variable rows): `HAS_ENV_VARS = true`. This is the most accurate signal — we've enumerated the definitions directly.
2. Else if `SPLIT_PLAN.sizeAnalysis.envVarCount.value > 0` (the size estimator counted definitions but the enumerator didn't return rows — usually because the publisher prefix or token was missing): `HAS_ENV_VARS = true`. The plan's count-summary fallback will explain to the user that per-variable details will be enumerated later.
3. Else if `SOLUTION_DONE = true` and `.solution-manifest.json` lists components with `componenttype 380`: `HAS_ENV_VARS = true`. (Stale-manifest fallback — should rarely fire now that 10b is in place.)
4. Otherwise: `HAS_ENV_VARS = false`. Variables will be discovered during setup-solution.

When `HAS_ENV_VARS = true`, the plan notes that `deploy-pipeline` will prompt for per-stage env var values (see Phase 3 risks population).

**Q7:** Ask via `AskUserQuestion`:
> "Is this project's code tracked in Git source control?"
> *(Informational only — this determines whether the plan includes a source control recommendation. No automation is applied.)*

Options:
1. Yes — we use Git (changes tracked before each deployment)
2. No — not using source control (plan will recommend enabling it before production)
3. Not yet set up (plan will include source control guidance)

Store as `GIT_STATUS`.

---

### Manual Path — Q3 through Q8

**Q3:** Ask via `AskUserQuestion`:
> "How many target environments do you need to deploy to?"

Options:
1. One target (e.g. Production)
2. Two targets (e.g. Staging then Production)
3. Dev only — not deploying yet

Store as `MANUAL_TARGET_COUNT`.

If option 3: set `MANUAL_TARGET_COUNT = 0`. Proceed to Q5.

**Q4 (one per stage):** For each target environment needed, ask via `AskUserQuestion`:

> "What is the URL for target environment {N}?"

Pre-fill from `ENV_LIST`: show up to 3 known environment URLs from `pac env list` as options, plus "Enter a different URL" as the last option.

Store target URLs as `MANUAL_TARGETS` (array).

**Q5:** Ask via `AskUserQuestion`:
> "How should the solution be exported?"

Options:
1. Managed — for staging/production (cannot edit in target)
2. Unmanaged — for dev-to-dev (editable in target)

Store as `EXPORT_TYPE`.

**Q6:** Ask via `AskUserQuestion`:
> "Do you want a checkpoint pause between export and import for review?"

Options:
1. Yes — pause after export so I can review the zip before importing
2. No — proceed automatically

Store as `MANUAL_CHECKPOINT` (`true` or `false`).

**Q6 (auto-detect, no question):** Same as PP Pipelines Q6 — check for env var definitions.

**Q7:** Same as PP Pipelines Q7 — Git source control status.

---

## Phase 3 — Generate HTML Plan

**Now create all tasks** — strategy is known.

### Task creation

**For PP Pipelines path**, create these tasks (in order):

| # | Subject | activeForm | Description |
|---|---------|-----------|-------------|
| 1 | Generate ALM plan | Generating ALM plan | Build planData, render docs/alm-plan.html |
| 2 | Approve ALM plan | Awaiting plan approval | Present inline summary, get user confirmation |
| 3 | Setup solution | Setting up solution | Invoke setup-solution skill (conditional) |
| 4 | Setup pipeline | Setting up pipeline | Invoke setup-pipeline skill (conditional) |
| 5..N | Deploy to {stageName} | Deploying to {stageName} | Invoke deploy-pipeline skill for this stage — one task per target stage |
| 5..N+1 | Activate site in {stageName} | Activating site in {stageName} | Check activation status + invoke activate-site if not yet provisioned — one task per target stage |
| 5..N+2 | Test site in {stageName} | Testing site in {stageName} | Invoke /power-pages:test-site against the activated URL; capture pass/fail counts; non-blocking — one task per target stage |
| N+3 | Finalize | Finalizing | Update HTML status, commit, run skill tracking |

Create one **Deploy to {stageName}** + **Activate site in {stageName}** + **Test site in {stageName}** task triplet for each target stage in `PP_STAGES` (e.g. Staging, Production).

**For Manual path**, create:

| # | Subject | activeForm | Description |
|---|---------|-----------|-------------|
| 1 | Generate ALM plan | Generating ALM plan | Build planData, render docs/alm-plan.html |
| 2 | Approve ALM plan | Awaiting plan approval | Present inline summary, get user confirmation |
| 3 | Setup solution | Setting up solution | Invoke setup-solution skill (conditional) |
| 4 | Export solution | Exporting solution | Invoke export-solution skill |
| 5..N | Import to {targetLabel} | Importing solution | Switch PAC CLI context, invoke import-solution (one task per target) |
| N+1 | Activate site in {targetLabel} | Activating site | Check activation status, invoke activate-site if not yet provisioned (one task per target, optional) |
| N+2 | Finalize | Finalizing | Update HTML status, commit, run skill tracking |

If `SOLUTION_DONE = true`, add `(will skip — already set up)` to the setup-solution task description.
If `PIPELINE_DONE = true` (PP path), add `(will skip — already set up)` to the setup-pipeline task description.

**Activation steps (PP path):** Create a separate **"Activate site in {stageName}"** task for every target stage. After each `deploy-pipeline` invocation succeeds, the activation task for that stage runs immediately — do not wait until all stages are deployed. The planData `steps` array must include one `"Deploy to {stageName}"` + one `"Activate site in {stageName}"` + one `"Test site in {stageName}"` triplet per target stage. Activation and testing happen after every stage deployment — not just Production.

**Test steps (PP path):** Create a separate **"Test site in {stageName}"** task for every target stage. After each activation completes (or is skipped), the test task runs immediately and is **non-blocking** — `test-site` writes `.last-test-site.json`, plan-alm ingests it into `validationRuns[stageName]`, and the rendered HTML's **Validation** tab gets a per-stage sub-tab with categorized findings. Failures do not abort the plan.

**Activation steps (Manual path):** For the Manual path, create one "Activate site in {targetLabel}" task per target environment. These run after the corresponding import completes. The Manual path does not include automatic test-site invocations — site testing is left to the user after manual deployment.

Mark task 1 ("Generate ALM plan") as `in_progress`.

### Build planData

Build a `planData` object with all gathered strategy inputs:

```json
{
  "SITE_NAME": "{siteName}",
  "GENERATED_AT": "{ISO timestamp}",
  "STRATEGY": "pp-pipelines | manual",
  "EXPORT_TYPE": "managed | unmanaged",   // PP Pipelines path: always "managed"
  "APPROVAL_MODE": "{approvalMode description}",
  "GIT_STATUS": "yes | no | not-yet",
  "HAS_ENV_VARS": true | false,
  "SOLUTION_DONE": true | false,
  "PIPELINE_DONE": true | false,
  "PLAN_STATUS": "Draft",
  "APPROVED_BY": "",
  "APPROVAL_DATE": "",
  "stages": [
    { "label": "Dev", "envUrl": "{devEnvUrl}", "type": "source" },
    { "label": "Staging", "envUrl": "{stagingUrl}", "type": "target" },
    { "label": "Production", "envUrl": "{prodUrl}", "type": "target" }
  ],
  "steps": [
    { "name": "Setup solution", "status": "pending", "skip": false },
    { "name": "Setup pipeline", "status": "pending", "skip": false },
    { "name": "Deploy via pipeline to Staging", "status": "pending", "skip": false },
    { "name": "Activate site in Staging", "status": "pending", "skip": false },
    { "name": "Test site in Staging", "status": "pending", "skip": false },
    { "name": "Deploy via pipeline to Production", "status": "pending", "skip": false },
    { "name": "Activate site in Production", "status": "pending", "skip": false },
    { "name": "Test site in Production", "status": "pending", "skip": false }
  ],
  "validationRuns": {
    "Staging": null,
    "Production": null
  },
  "pipelineMeta": null,                   // populated when .last-pipeline.json exists — see "pipelineMeta block" below
  "risks": [
    { "type": "info", "message": "..." }
  ],
  "solutionContents": {
    "tables": ["{table1}", "{table2}"],
    "botComponents": [{ "name": "..." }],
    "siteSettings": {
      "keepAsIs": [{ "name": "..." }],
      "promoteToEnvVar": [{ "name": "...", "value": "..." }],
      "credentialNeedsDecision": [{ "name": "..." }]
    }
  },

  // --- v2 fields from the split decision tree (Phase 1 Step 10) ---
  "sizeAnalysis": { /* tier-classified signals from SPLIT_PLAN.sizeAnalysis */ },
  "assetAdvisory": { /* candidates + recommendation from SPLIT_PLAN.assetAdvisory */ },
  "splitStrategy": "single | strategy-1-layer | strategy-2-change-frequency | strategy-3-schema-segmentation | strategy-4-config-isolation",
  "appliedStrategies": ["strategy-1-layer"],
  "proposedSolutions": [ /* from SPLIT_PLAN.proposedSolutions — ALWAYS at least 1 entry */ ],
  "recommendations": [ /* from SPLIT_PLAN.recommendations */ ],
  "envVars": [ /* from ENV_VARS_DETAILS (Phase 1 Step 10b) — { schemaName, type, defaultValue, siteSetting } per definition; empty array when DEV_TOKEN unavailable */ ],
  "plannedEnvVarCount": 0,                // sum of SITE_SETTINGS_DATA.promoteToEnvVar.length + credentialNeedsDecision.length — env vars setup-solution will offer to create. Renderer shows this as "N planned" alongside the existing-count stat so a fresh project (envVars: []) doesn't look like nothing is happening when the risks list says auth settings will be promoted. Reset to 0 by refresh-alm-plan-data setup-solution phase.
  "breakdown": { /* bytes-per-category from the estimate */ },
  "estimationMethod": "metadata-based",
  "estimationAccuracyPct": 15,

  // --- v3 fields from the host resolution (Phase 1 Step 12) — PP Pipelines path only ---
  "hostResolution": {
    "status": "AvailableUsingCustomHost | AvailableUsingCustomHostByAdminDefault | AvailableUsingPlatformHost | AvailableUnboundCustomHost | MultipleUnboundCustomHosts | PlatformHostExistsUnbound | CannotRedirect | NoHost | OrgSettingStale | PermissionDenied | DetectionFailed",
    "hostEnvUrl": "https://pascalepipelineshost.crm.dynamics.com" | null,
    "hostEnvId": "0817fd3d-a664-e99a-a758-dd9dc03ceb01" | null,
    "hostType": "custom | platform | null",
    "pipelinesSolutionVersion": "9.x.y.z" | null,
    "candidatesCount": 0,
    "willEnsureDuringExecution": true | false,
    "willProvisionPlatform": true | false,
    "willProvisionCustom": true | false,
    "willUsePpac": true | false,
    "chosenEnvUrl": "https://orgc4f78248.crm5.dynamics.com/" | null,
    "userChoseDeferToSetupPipeline": false
  }
}
```

`solutionContents` is populated from `SOLUTION_CONTENTS_DATA` built in Phase 1. If discovery was unavailable, pass `null` — the renderer will show a fallback note.

`plannedEnvVarCount` is computed from `SITE_SETTINGS_DATA` (Phase 1 Step 7): `(SITE_SETTINGS_DATA.promoteToEnvVar?.length || 0) + (SITE_SETTINGS_DATA.credentialNeedsDecision?.length || 0)`. When `SITE_SETTINGS_DATA` is null (Step 7 query failed), set `plannedEnvVarCount = 0`. The renderer reads this alongside `envVars.length` (existing) and `sizeAnalysis.envVarCount.value` (size-estimator's count) to produce a "N today / +M planned" display in the Overview stat card and Size Analysis signal.

**`validationRuns` block** (PP Pipelines path only — initialize one entry per target stage with value `null`; populated during Phase 7 Step C by ingesting `.last-test-site.json` after each stage's test run). The full categorized test report drives the new **Validation** tab in the rendered HTML. Shape per stage:

```json
{
  "validationRuns": {
    "Staging": {
      "url": "https://example.powerappsportals.com",
      "runAt": "2026-04-27T15:00:00.000Z",
      "durationSec": 120,
      "runOutcome": "passed | passed-with-warnings | failed",
      "summary": {
        "critical": 0, "high": 1, "medium": 0, "low": 2,
        "total": 3, "automated": 2, "manual": 1,
        "passed": 2, "failed": 1, "skipped": 0
      },
      "categories": [
        {
          "id": "site-load",
          "name": "Site Load",
          "icon": "📦",
          "tests": [
            {
              "id": "t01",
              "name": "Homepage returns 200 OK",
              "severity": "critical",
              "type": "automated",
              "status": "passed",
              "description": "...",
              "steps": ["GET /", "Expect 200"],
              "expected": "200 OK",
              "actual": "200 OK",
              "validates": "Site activation"
            }
          ]
        }
      ]
    },
    "Production": null
  }
}
```

The shape is identical to `.last-test-site.json` written by `test-site` Phase 6.7a — `plan-alm` reads that file verbatim and assigns it to `validationRuns[stageName]`. The renderer maps `runOutcome` to green / yellow / red Outcome badges and produces a sub-tab per stage on the Validation tab. For the Manual path, omit `validationRuns` from planData.

**`pipelineMeta` block** (PP Pipelines path only — read from `.last-pipeline.json` and `.last-deploy.json` at planData-build time. `null` on fresh plans where no pipeline is configured yet; populated after `setup-pipeline` and refreshed after each `deploy-pipeline` run via the post-deploy re-render in Phase 7). Highlights the pipeline that is actually moving configurations for this project. Shape:

```json
{
  "pipelineMeta": {
    "isActive": true,
    "pipelineId": "2b8b5de8-8f43-f111-bec7-6045bd569497",
    "pipelineName": "BYOC Supplier Portal Pipeline",
    "reusedByWiring": null,
    "lastDeploy": {
      "status": "Succeeded",
      "stageName": "Deploy to Staging",
      "deployedAt": "2026-04-29T08:42:00.000Z",
      "artifactVersion": "1.0.0.2",
      "componentCount": 118
    }
  }
}
```

- `isActive`: `true` whenever the project has a configured pipeline (`.last-pipeline.json` exists). Drives the **ACTIVE** chip on the Pipelines tab.
- `pipelineName`: from `.last-pipeline.json`. The renderer falls back to `${SITE_NAME}-Pipeline` when `pipelineMeta` is absent.
- `reusedByWiring`: `null` when the pipeline was created fresh; an object `{ originalName, requestedName }` when `create-deployment-pipeline.js` matched an existing pipeline by source+target wiring and reused it under its existing name. The renderer surfaces this with an explanatory note so reviewers understand why the plan and the live pipeline names may differ.
- `lastDeploy`: derived from `.last-deploy.json`. Omit (set to `null`) before the first deploy.

**How to populate.** During Phase 3 planData build, read both files (Node.js inline) and inject:
```bash
node -e "
const fs = require('fs');
const meta = { isActive: false, pipelineId: null, pipelineName: null, reusedByWiring: null, lastDeploy: null };
try {
  const lp = JSON.parse(fs.readFileSync('.last-pipeline.json','utf8'));
  meta.isActive = true;
  meta.pipelineId = lp.pipelineId || null;
  meta.pipelineName = lp.pipelineName || null;
  meta.reusedByWiring = lp.reusedByWiring || null;
} catch {}
try {
  const ld = JSON.parse(fs.readFileSync('.last-deploy.json','utf8'));
  meta.lastDeploy = {
    status: ld.status, stageName: ld.stageName, deployedAt: ld.deployedAt,
    artifactVersion: ld.artifactVersion, componentCount: ld.componentCount,
  };
} catch {}
process.stdout.write(JSON.stringify(meta));
"
```
Embed the result as `planData.pipelineMeta`.

**v2 fields** (`sizeAnalysis`, `assetAdvisory`, `splitStrategy`, `proposedSolutions`, `recommendations`, `breakdown`) come straight from `SPLIT_PLAN` computed in Phase 1 Step 10, mutated by Q1b user choices. Pass them through unchanged to the renderer. **`envVars`** comes from `ENV_VARS_DETAILS` populated in Phase 1 Step 10b — pass it through unchanged. When the array is empty, the renderer's count-aware fallback uses `sizeAnalysis.envVarCount.value` so the Env Variables tab still shows a count-summary note.

> **`proposedSolutions[]` is never empty.** Even when `splitStrategy === "single"` and the decision tree recommends one solution, `compute-split-plan.js` returns one entry describing the base solution (uniqueName, displayName, sizeMB, componentCount, componentTypes). Pass that through. The renderer drives the Solutions tab off this array — leaving it empty produces an unhelpful "structure will be determined" placeholder. If you find yourself with `proposedSolutions = []` because compute-split-plan wasn't run, synthesize a single base entry from `solutionContents.solution` / `data.SITE_NAME` / `componentCount` / `totalSizeMB` rather than passing through an empty array. The renderer has a safety-net synthesizer for this case but the right fix is upstream — populate it explicitly.

**`hostResolution` block** (PP Pipelines path only — omit for Manual path). Built from `HOST_RESOLUTION` (Phase 1 step 12) plus the auxiliary flags set by Phase 2 Q4:

- `status` ← `HOST_RESOLUTION.status`
- `hostEnvUrl` ← `HOST_ENV_URL` (from Q4) — may be `null` when the user deferred or chose to provision new
- `hostEnvId` ← `HOST_RESOLUTION.finalHostEnvId`
- `hostType` ← `HOST_RESOLUTION.hostType`
- `pipelinesSolutionVersion` ← `HOST_RESOLUTION.pipelinesSolutionVersion`
- `candidatesCount` ← `HOST_RESOLUTION.candidates.existingCustomHosts.length`
- `willEnsureDuringExecution` ← `WILL_ENSURE_HOST` flag from Q4 (true whenever setup-pipeline will need to consult ensure-pipelines-host at execution time — i.e. status is `NoHost`, any `*Unbound*`, or the user deferred)
- `willProvisionPlatform` ← `WILL_PROVISION_PLATFORM` flag from Q4 (set when the user picks Option 1 "Provision a Platform Host" in the NoHost host-type menu; ensure-pipelines-host treats this as a directive to go straight to Phase 4.0)
- `willProvisionCustom` ← `WILL_PROVISION_CUSTOM` flag from Q4
- `willUsePpac` ← `WILL_USE_PPAC` flag from Q4 (set when the user picks "Open PPAC and create one manually" in the NoHost host-type menu; ensure-pipelines-host treats this as a directive to go straight to Phase 4.C)
- `chosenEnvUrl` ← `CHOSEN_ENV_URL` flag from Q4 (set when the user picks Option 2 → sub-option `a` in the NoHost host-type menu; ensure-pipelines-host treats this as a directive to skip its Phase 3.C menu and go straight to Phase 4.B with this env)
- `userChoseDeferToSetupPipeline` ← `USER_CHOSE_DEFER_TO_SETUP_PIPELINE` flag from Q4 (only set in the `MultipleUnboundCustomHosts` "Decide later" branch)

Populate `risks` based on gathered data:
- If `HAS_ENV_VARS = true`: `{ type: "warning", message: "This solution has environment variables ({N} detected) — you will be prompted for per-stage values during deployment." }`. Substitute `{N}` from `ENV_VARS_DETAILS.length` if it's > 0, otherwise from `SPLIT_PLAN.sizeAnalysis.envVarCount.value` (the count the size estimator reported). When neither source has a positive count, drop the parenthetical (`"This solution has environment variables — you will be prompted..."`).
- If `SITE_SETTINGS_DATA.promoteToEnvVar.length > 0`: `{ type: "info", message: "{N} auth-related site settings (Authentication/* and AzureAD/*) detected with values. setup-solution will ask which to back with environment variables so each stage can use different values (e.g., different OAuth callback URLs). Skip any you don't need to vary per stage." }`. Substitute `{N}` from `SITE_SETTINGS_DATA.promoteToEnvVar.length`. (Replaces older "will be promoted" wording — that implied automatic action; in reality the user picks per setting.)
- If `SITE_SETTINGS_DATA.credentialNeedsDecision.length > 0`: `{ type: "info", message: "{N} credential-style site settings (ConsumerKey / ClientId / ClientSecret / etc.) detected. setup-solution will run a single bulk prompt to handle all of them — auto-classify by name (recommended; *Secret/Password/ApiKey/AppKey become Secret env vars, *Id/ConsumerKey become String env vars), all-as-Secret, all-as-String, skip-all, or fall through to a per-credential picker for granular control." }`. Substitute `{N}` from `SITE_SETTINGS_DATA.credentialNeedsDecision.length`. Do NOT emit any "excluded from solution / configure manually" wording — that was the pre-IronItOut behavior and it's gone.
- If `GIT_STATUS = "no"`: `{ type: "info", message: "Consider enabling source control to track changes before deploying to production." }`
- If `EXPORT_TYPE = "unmanaged"` and strategy includes a production target: `{ type: "warning", message: "Unmanaged solutions can be edited in the target environment — consider using Managed for production." }`
- If `SOLUTION_DONE = false`: `{ type: "info", message: "A Dataverse solution will be created first — publisher prefix is irreversible once chosen." }`
- **Always** (when planning a PP Pipelines path with `SOLUTION_DONE` becoming true after Phase 4): `{ type: "info", message: "When you add new components later (server logic, cloud flows, env vars, custom tables), re-run /power-pages:setup-solution in sync mode to bring them into this solution. The completeness check in this skill (Phase 1 Step 11) will flag any drift between the live site and the solution before the next plan-alm run." }`. Skip when `SOLUTION_DONE` is already true at plan-alm start (sync mode is already self-evident at that point).
- If `KNOWN_GAPS` is set (the pre-plan completeness check in Phase 1 Step 11 found gaps and the user chose to continue): `{ type: "warning", message: "{X} site components, {Y} cloud flows, {Z} env vars, and {W} custom tables exist on the site but are not in the current solution. This plan will not promote them — run /power-pages:setup-solution sync mode before deploying, or re-run plan-alm after syncing." }`. Substitute the counts from `KNOWN_GAPS.missing.*.length`.
- If `HOST_RESOLUTION.status === "NoHost"` AND `WILL_PROVISION_PLATFORM === true`: `{ type: "info", message: "No Pipelines host detected. setup-pipeline will provision a new Platform Host (idempotent, ~3–5 min). Plan execution will pause for a tenant-identity confirmation gate before the call." }`. Do NOT include any wording about admin-role requirements or API names — those are implementation details.
- If `HOST_RESOLUTION.status === "NoHost"` AND `WILL_PROVISION_CUSTOM === true`: `{ type: "info", message: "No Pipelines host detected. setup-pipeline will create a new Custom Host. Plan execution will pause for admin-role attestation and a pre-call confirmation." }`
- If `HOST_RESOLUTION.status === "NoHost"` AND none of the provisioning flags are set (user picked an existing env via Option 2 → sub-option `a`, or chose PPAC manual, or deferred): emit a status-appropriate info entry derived from `CHOSEN_ENV_URL` / `WILL_USE_PPAC`.
- If `HOST_RESOLUTION.status === "AvailableUnboundCustomHost"`: `{ type: "info", message: "An existing Custom Host (" + HOST_RESOLUTION.finalHostEnvUrl + ") will be reused. Source env will be bound to it automatically." }`
- If `HOST_RESOLUTION.status === "MultipleUnboundCustomHosts"`: `{ type: "info", message: HOST_RESOLUTION.candidates.existingCustomHosts.length + " existing Custom Hosts found in tenant. setup-pipeline will prompt for selection." }`
- If `HOST_RESOLUTION.status === "PlatformHostExistsUnbound"`: `{ type: "info", message: "Tenant has a Platform Host. Reusing it is the lowest-friction option; creating a Custom Host instead provides better governance for separate-tenant or governed scenarios." }`
- If `HOST_RESOLUTION.status === "CannotRedirect"`: `{ type: "warning", message: "CannotRedirect: source env ProjectHostEnvironmentId points at PE but tenant default custom host is set elsewhere. Resolution requires Power Platform admin." }` (Note: Phase 2 Q4 normally blocks plan generation in this state; this is a defensive entry in case the plan is somehow generated.)

Write `planData` to `docs/.alm-plan-data.json` (create `docs/` if it doesn't exist).

### Render the HTML plan

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/plan-alm/scripts/render-alm-plan.js" \
  --output "<projectRoot>/docs/alm-plan.html" \
  --data "<projectRoot>/docs/.alm-plan-data.json"
```

**Keep `docs/.alm-plan-data.json` on disk.** Phases 5 / 6 / 7 / 8 read this file to refresh `hostResolution`, `pipelineMeta`, `validationRuns`, `risks`, and the plan footer after each run step, then re-render `docs/alm-plan.html` so the rendered tabs reflect actual run state (not the pre-run plan). The file is also what `check-alm-plan.js` reads for the Phase 0 ALM-plan gate in `setup-pipeline` / `deploy-pipeline` / `setup-solution` / `export-solution` / `import-solution` / `configure-env-variables` — deleting it makes every downstream skill think no plan exists. Earlier guidance to delete this file after the initial render was incorrect and caused the Pipelines tab + risks list to stay frozen at pre-run state for the lifetime of the plan.

Write `.alm-plan-context.json` to the project root (persists so `setup-solution` can read it):
```json
{
  "generatedAt": "{ISO timestamp}",
  "siteName": "{siteName}",
  "siteSettings": {
    "keepAsIs": [{name}],
    "authNoValue": [{name}],
    "promoteToEnvVar": [{name, value}],
    "excluded": [{name}]
  }
}
```
This file is intentionally NOT deleted — `setup-solution` and other skills read it to skip re-discovery.

### Open the HTML plan in the user's default browser

The inline Markdown summary presented in Phase 4 is intentionally compact — reviewers need to see the full rendered plan (size gauge, signal cards, per-solution breakdown, asset advisory, pipeline stages) before giving informed approval. Launch `docs/alm-plan.html` in the default browser **before** the approval prompt so the user can scan the full plan while reading the CLI summary.

> **Why no Node wrapper.** The earlier `node -e "spawn('powershell.exe', [...])"` chain hits the agent's sandbox classifier (Node spawning a process that spawns another process is the textbook pattern the classifier blocks). The agent should use the **OS-native shell tool directly** — no Node detour, no `child_process`, no detached subprocess.

**Step 1. Print the absolute `file://` URL prominently *first*.** This is the user's reliable fallback if the launcher gets blocked:

```bash
node -e "process.stdout.write('Plan URL: file:///' + require('path').resolve('docs/alm-plan.html').replace(/\\\\/g, '/') + '\n')"
```

(Single Node call, no spawn, never blocked. Output: `Plan URL: file:///C:/Projects/.../docs/alm-plan.html`.)

**Step 2. Launch the browser via the OS-native shell.** Pick the shell tool the agent has available:

- **Windows / PowerShell tool** — call `Start-Process` directly:
  ```powershell
  Start-Process "docs/alm-plan.html"
  ```

- **Windows / Bash tool (Git Bash, WSL passthrough)** — call PowerShell from Bash, but as a single direct invocation (no Node wrapper):
  ```bash
  powershell.exe -NoProfile -Command "Start-Process 'docs/alm-plan.html'"
  ```

- **macOS** — call `open` directly:
  ```bash
  open docs/alm-plan.html
  ```

- **Linux** — call `xdg-open` directly:
  ```bash
  xdg-open docs/alm-plan.html
  ```

**Step 3. Report the URL to the user.** After the launch attempt, surface the file:// URL the agent printed in Step 1, so the user always has a clickable backup:

> "Opened `docs/alm-plan.html` in your browser. If it didn't open automatically, use this link: `file:///C:/Projects/.../docs/alm-plan.html`. Review it, then answer the approval prompt below."

If the launch silently fails (sandboxed terminal, SSH session, headless environment), do not retry, do not block, do not loop. Step 1's printed URL is the contract — the user can click or paste it themselves. Continue to Phase 4 and rely on the CLI summary as backup.

Mark task 1 as `completed`.

---

## Phase 4 — Present Plan and Get Approval

Mark task 2 ("Approve ALM plan") as `in_progress`.

Present a concise inline Markdown summary:

```
## ALM Plan: {siteName}

**Strategy:** {PP Pipelines / Manual export/import}
**Stages:** {Dev} → {Staging} → {Production (if applicable)}
**Approval gates:** {description from PP_APPROVAL_MODE, or "N/A — manual path"}
**Solution export:** {Managed / Unmanaged}
**Pipeline host:** {hostEnvUrl} ({status}) — *(PP Pipelines path only; when `WILL_ENSURE_HOST = true`, render as `Will be ensured during setup-pipeline ({status})` instead)*

**Steps that will run:**
- [ ] Setup solution {(SKIP — already set up) if SOLUTION_DONE}
- [ ] Setup pipeline {(SKIP — already set up) if PIPELINE_DONE} {(PP path only)}
- [ ] Export solution {(manual path only)}
- [ ] Import to {targetLabel} × {N} {(manual path only)}
- [ ] Deploy via pipeline {(PP path only)}

Full plan written to: docs/alm-plan.html
```

Ask via `AskUserQuestion`:
> "Does this ALM plan look correct?"

Options:
1. **Approve and execute the plan**
2. **Save plan but execute manually later**
3. **I want to change something** — go back to questions

- **If option 3:** Re-run Phase 2 (ask which section to change, then re-gather those answers). Regenerate the plan (repeat Phase 3). Re-present for approval.
- **If option 2:** Capture the approver (see below), stamp `<span id="approved-by">` and `<span id="approval-date">` in the HTML, then update HTML plan footer `plan-status` span to "Approved — Deferred" via `Edit` tool. Commit `docs/alm-plan.html` with message `"Add ALM plan for {siteName} (deferred)"`. Show next steps for manual execution. Mark task 2 as `completed`. Exit the skill.
- **If option 1:** Capture the approver (see below), stamp the HTML, then update `<span class="plan-status">` to "In Execution" via `Edit` tool. Mark task 2 as `completed`.

**Capturing the approver (both options 1 and 2):**

Capture the name silently using git, falling back to the OS user:

```bash
node -e "const {execSync}=require('child_process');let n='';try{n=execSync('git config user.name',{encoding:'utf8'}).trim();}catch{};if(!n){n=process.env.USER||process.env.USERNAME||'';}process.stdout.write(n);"
```

Store the output as `APPROVER`. If `APPROVER` is empty (no git config, no USER env var), ask via `AskUserQuestion`:

> "Who is approving this plan? (needed for the audit trail in docs/alm-plan.html)"
>
> Options: 1. *{current system user from `whoami`}* · 2. Other (enter name)

Once `APPROVER` is known, use `Edit` to replace the empty/placeholder value in `docs/alm-plan.html`:

- Find `<span id="approved-by">` (or `<span id="approved-by"></span>` / `<span id="approved-by">__APPROVED_BY__</span>`) and replace its inner text with `APPROVER`.
- Find `<span id="approval-date">` and replace its inner text with the current ISO timestamp.

Both spans are guaranteed to exist in the template — there is exactly one of each in the "Execution Checklist" tab footer.

---

## Phase 5 — Execute: setup-solution (conditional)

**If `SOLUTION_DONE = true`:**
Mark the "Setup solution" task as `completed` with description "Skipped — solution already configured". Update the HTML checklist step for "Setup solution" to `status-skipped` via `Edit` tool. Skip to Phase 6.

**If `SOLUTION_DONE = false`:**
Mark the "Setup solution" task as `in_progress`. Update the HTML checklist step to `status-in-progress` via `Edit` tool.

Invoke the skill:
```
/power-pages:setup-solution
```

After completion: mark the task as `completed`. Update the HTML checklist step to `status-completed` via `Edit` tool.

---

## Phase 6 — Execute: setup-pipeline OR export-solution

### PP Pipelines path

**If `PIPELINE_DONE = true`:**
Mark the "Setup pipeline" task as `completed` with description "Skipped — pipeline already configured". Update HTML checklist step to `status-skipped`. Skip to Phase 7.

**If `PIPELINE_DONE = false`:**
Mark the "Setup pipeline" task as `in_progress`. Update HTML checklist step to `status-in-progress`.

Invoke the skill:
```
/power-pages:setup-pipeline
```

After completion: mark task as `completed`. Update HTML checklist step to `status-completed`. Then run the post-run plan refresh — this is **not optional**; without it the Pipelines tab stays at "Will be ensured during setup-pipeline" and the risks list keeps surfacing the pre-run NoHost warning even though the host now exists:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-alm-plan-data.js" \
  --projectRoot "." \
  --phase setup-pipeline \
  --render
```

This (a) reads `.last-host-check.json` and rewrites `planData.hostResolution` to the post-run state (status flips from `NoHost` to `AvailableUsingCustomHost`, all the `willEnsure*` / `willProvision*` / `chosenEnvUrl` flags clear), (b) reads `.last-pipeline.json` and populates `planData.pipelineMeta` with the actual pipeline name + ID + host URL + stages (no `lastDeploy` yet — that fills in after Phase 7 Step A), (c) drops resolved entries from `planData.risks` (NoHost / *Unbound* / Platform-Host warnings), then (d) re-renders `docs/alm-plan.html`. If the helper exits with `ok:false`, surface the reason — the most likely cause is that `docs/.alm-plan-data.json` is missing (Phase 3 must have written it; the file should never be deleted between phases).

### Manual path

Mark the "Export solution" task as `in_progress`. Update HTML checklist step to `status-in-progress`.

Invoke the skill:
```
/power-pages:export-solution
```

After completion: mark task as `completed`. Update HTML checklist step to `status-completed`.

**If `MANUAL_CHECKPOINT = true`:** Ask via `AskUserQuestion`:
> "Export complete. Review the solution zip at `{zipPath}` before importing. Ready to proceed with import?"

Options:
1. Yes, proceed with import
2. Stop here — I'll import manually later

If option 2: update HTML plan footer to "Approved — Deferred (paused after export)". Commit `docs/alm-plan.html`. Exit.

---

## Phase 7 — Execute: Deploy

### PP Pipelines path

**For each target stage in `PP_STAGES` (e.g. Staging, then Production), run this loop:**

**Step A — Deploy:**
Mark the "Deploy to {stageName}" task as `in_progress`. Update HTML checklist step to `status-in-progress`.

Invoke the skill:
```
/power-pages:deploy-pipeline
```

After completion: mark deploy task as `completed`. Update HTML checklist step to `status-completed`.

**Refresh the plan after each stage's deploy.** Run the helper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-alm-plan-data.js" \
  --projectRoot "." \
  --phase deploy-pipeline \
  --render
```

The helper reads `.last-deploy.json`, populates `planData.pipelineMeta.lastDeploy` (status, stageName, deployedAt, artifactVersion, componentCount, activationStatus, siteUrl), and re-renders `docs/alm-plan.html`. The Pipelines tab now shows the actual pipeline name + ACTIVE chip + last-run footer (Succeeded / Failed status + version + component count + stage label). Cheap; runs once per stage in the deploy loop.

**Step B — Activate (immediately after deploy for this stage):**
Mark the "Activate site in {stageName}" task as `in_progress`. Update HTML checklist step to `status-in-progress`.

Read `.last-deploy.json` to check whether activation already happened inside `deploy-pipeline`:
```bash
node -e "const d=require('./.last-deploy.json'); process.stdout.write(JSON.stringify({activationStatus: d.activationStatus, siteUrl: d.siteUrl}))"
```

- `activationStatus === "Activated"`: site is live. Mark task `completed`. Update checklist step to `status-completed`. Show site URL.
- `activationStatus === "Pending"` or `null`: activation was deferred or didn't run. Switch PAC CLI to the target environment and ask via `AskUserQuestion`:

  > "**{siteName}** was deployed to **{stageName}** successfully. The site is not yet activated (not publicly accessible). Activate it now?"

  Options:
  1. **Yes, activate now** — invoke `/power-pages:activate-site`. After it completes, mark task `completed`, update checklist step to `status-completed`.
  2. **No, skip for now** — mark task `skipped`, update checklist step to `status-skipped`.

**Step C — Test site (immediately after activate for this stage):**
Mark the "Test site in {stageName}" task as `in_progress`. Update HTML checklist step to `status-in-progress`.

Determine the URL to test:
- Prefer `siteUrl` from `.last-deploy.json` (written by `deploy-pipeline`).
- If absent or empty, fall back to the URL returned by the most recent `activate-site` invocation for this stage.
- If both are unavailable (activation was skipped, no URL captured), mark the task `skipped` and set `validationRuns[stageName] = null`. Update checklist step to `status-skipped`.

If a URL is available, invoke the skill (forwarding the URL as the argument):
```
/power-pages:test-site --siteUrl {activatedUrl}
```

When `test-site` completes, ingest its `.last-test-site.json` marker into `validationRuns[stageName]` and re-render via the same refresh helper used by other phases:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-alm-plan-data.js" \
  --projectRoot "." \
  --phase test-site \
  --stageName "{stageName}" \
  --render
```

The helper reads `.last-test-site.json`, populates `planData.validationRuns[{stageName}]` with the test outcome (runOutcome, summary counts, categories), and re-renders `docs/alm-plan.html` so the Validation tab updates immediately.

`runOutcome` is set by `test-site` itself (see Phase 6.7a in the test-site skill): `"failed"` when any critical/high failure exists, `"passed-with-warnings"` for any non-critical failure or console errors, `"passed"` otherwise. Trust the value as written — do not re-compute.

**Decision rule (non-blocking):** Regardless of `runOutcome`, mark the task `completed` and continue to the next stage. Failures are diagnostic, not gating — the plan does not abort.

Update the HTML checklist step:
- `runOutcome === "failed"` → `status-warning` (NEW status — yellow).
- otherwise → `status-completed`.

**Checklist substep rendering** (the renderer handles this automatically once `validationRuns` is populated and the planData re-rendered): every `Test site in {stageName}` step gets an inline substep showing the test-result badge (`PASSED` / `WARNINGS` / `FAILED`), the tested URL, the `pass / fail / skip` summary line, and a "View details &rarr;" link that jumps to the Validation tab. Every `Deploy via pipeline to {stageName}` and `Activate site in {stageName}` step also gets a `Target: <envUrl>` substep so reviewers see the target env without leaving the Execution tab. The renderer derives env URLs from `data.stages[].envUrl` (matched by trailing stage label) — keep stage labels consistent across `data.stages` and `data.steps`.

After handling activation and testing, switch PAC CLI back to the dev environment:
```bash
pac env select --environment "{devEnvUrl}"
```

**Then repeat Step A + B + C for the next stage** (if any).

### Manual path (one import per target environment)

For each entry in `MANUAL_TARGETS`:

1. Mark the "Import to {targetLabel}" task as `in_progress`. Update the corresponding HTML checklist step to `status-in-progress`.

2. Switch the PAC CLI context to the target environment:
   ```bash
   pac env select --environment "{targetEnvUrl}"
   ```

3. Invoke the skill:
   ```
   /power-pages:import-solution
   ```

4. After completion: mark the task as `completed`. Update the HTML checklist step to `status-completed`.

5. **Activate site in {targetLabel}** (optional) — mark the "Activate site in {targetLabel}" task as `in_progress`. Update HTML checklist step to `status-in-progress`.

   PAC CLI is already pointing to the target environment from step 2. Run the activation check:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/check-activation-status.js" --projectRoot "."
   ```

   - **`activated: true`**: Site is already live. Mark task as `completed`. Update checklist step to `status-completed`.
   - **`activated: false`**: Invoke `/power-pages:activate-site`. After completion, mark task as `completed`. Update checklist step to `status-completed`.
   - **`error`**: Mark task as `skipped`. Note error in summary.

After all imports: switch PAC CLI back to the dev environment:
```bash
pac env select --environment "{devEnvUrl}"
```

---

## Phase 8 — Finalize

Mark the "Finalize" task as `in_progress`.

### 8.1 Update HTML plan status

Run the post-run plan refresh in `finalize` mode and re-render. This sets `planData.PLAN_STATUS = "Completed"` and produces the final HTML with all post-run state (latest hostResolution, pipelineMeta + lastDeploy, validationRuns, status footer) consistent across every tab:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-alm-plan-data.js" \
  --projectRoot "." \
  --phase finalize \
  --render
```

If you also need to surface a timestamp in the footer (e.g. plan completion time), apply that via `Edit` tool **after** the re-render — the renderer doesn't currently emit a completion timestamp.

### 8.2 Run skill tracking

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-skill-tracking.js" \
  --projectRoot "." \
  --skillName "PlanAlm" \
  --authoringTool "ClaudeCode"
```

### 8.3 Commit

```bash
git add docs/alm-plan.html && git commit -m "Add ALM plan for {siteName}"
```

### 8.4 Present final summary

Display a summary:

```
## ALM Complete: {siteName}

**Strategy used:** {PP Pipelines / Manual export/import}
**Skills invoked:** {comma-separated list of skills that ran}

**Artifacts created:**
- docs/alm-plan.html — ALM plan document
- .solution-manifest.json — Solution configuration {(if newly created)}
- .last-pipeline.json — Pipeline configuration {(PP path only, if newly created)}
- .last-deploy.json — Last deployment record {(PP path only)}
- {solutionName}_{managed|unmanaged}.zip — Solution package {(manual path only)}

**Site activation:** {
  PP path: "Activation status per stage is in .last-deploy.json and each deploy history file."
  Manual path: list each target env and its activation status (Activated / Pending)
}
```

Mark the "Finalize" task as `completed`.

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Generate ALM plan | Generating ALM plan | Gather strategy inputs, build planData, render docs/alm-plan.html |
| Approve ALM plan | Awaiting plan approval | Present inline summary + HTML plan path, get user confirmation |
| Setup solution | Setting up solution | Invoke setup-solution skill (skip if .solution-manifest.json exists) |
| Setup pipeline | Setting up pipeline | Invoke setup-pipeline skill — PP Pipelines path only (skip if .last-pipeline.json exists). May delegate to ensure-pipelines-host internally to resolve or provision the host environment when `hostResolution.willEnsureDuringExecution` is true; that delegation is transparent to plan-alm and is not a separate top-level task. |
| Export solution | Exporting solution | Invoke export-solution skill — Manual path only |
| Deploy to {stageName} | Deploying to {stageName} | Invoke deploy-pipeline skill — PP Pipelines path, one task per target stage |
| Activate site in {stageName} | Activating site in {stageName} | Check activation status + invoke activate-site immediately after each stage deploys — one task per target stage |
| Test site in {stageName} | Testing site in {stageName} | Invoke /power-pages:test-site against the activated URL; capture pass/fail counts; non-blocking |
| Import to {targetEnv} | Importing solution | Switch PAC CLI context, invoke import-solution — Manual path, one task per target |
| Activate site in {targetEnv} | Activating site | Check activation status + invoke activate-site if needed — Manual path, one task per target |
| Finalize | Finalizing | Update HTML plan status, commit, run skill tracking, present summary |

---

## Key Decision Points (Wait for User)

1. **Phase 2, Q1**: Solution setup — confirm existing or include `setup-solution` in plan
2. **Phase 2, Q2**: Promotion strategy — PP Pipelines, Manual, or already set up
3. **Phase 2, Q3–Q7** (PP path): Stage count, host env, approval gates (managed auto-set), Git status
   **Phase 2, Q3–Q7** (Manual path): Target count, target env URLs, export type, checkpoint pause, Git status
4. **Phase 4**: Plan approval — execute, defer, or revise
5. **Phase 6, Manual**: Checkpoint pause after export (if Q6 = Yes)
6. **Phase 7 (delegated)**: Each invoked skill has its own approval gates

## Error Handling

- No `powerpages.config.json`: stop, advise `/power-pages:create-site`
- `pac env list` fails: skip ENV_LIST pre-filling; ask for environment URLs manually
- `render-alm-plan.js` fails (non-zero exit): report error, show planData JSON as fallback, ask user whether to proceed
- Invoked skill fails: report the failure, mark the task as blocked, ask user whether to retry or exit
- Plan approval = option 3 (change something): re-run Phase 2 fully, then regenerate plan — do not carry over stale answers
