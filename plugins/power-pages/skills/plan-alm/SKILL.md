---
name: plan-alm
description: >-
  Creates an ALM (Application Lifecycle Management) plan for deploying a Power Pages
  site across environments. Gathers your promotion strategy, target environments, and
  approval requirements upfront, then generates a visual HTML plan document for your
  review and approval. **plan-alm does not deploy anything itself** — it is a planner.
  After you approve the plan, run the individual ALM skills (setup-solution,
  setup-pipeline, deploy-pipeline, or export-solution/import-solution); each detects the
  approved plan and executes the right step in order, keeping the plan updated as it runs.
  Use when asked to: "plan my alm", "set up alm", "create deployment plan",
  "plan my deployments", "help me deploy to multiple environments",
  "set up promotion strategy", "create cicd plan", "plan site promotion",
  "help me go to production", "set up pipeline for my site".
user-invocable: true
argument-hint: "Optional: 'pipelines' or 'manual' to skip strategy selection"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# plan-alm

A 4-phase **planner** that gathers ALM strategy from the user, generates an HTML deployment plan, and gets approval. **It does not execute anything** — execution is delegated to the individual ALM skills, which the user runs afterward.

## Overview

This skill detects the current project state (existing solution, pipeline), asks targeted questions about the desired promotion strategy (Power Platform Pipelines or Manual export/import), generates a visual `docs/alm-plan.html`, and gets user approval. The four phases are: **Phase 1 — Detect**, **Phase 2 — Gather strategy**, **Phase 3 — Generate plan**, **Phase 4 — Approve & save**.

**plan-alm never deploys.** The plan's `steps[]` array records the **recommended execution sequence**. After approval, the user invokes the individual skills — `setup-solution`, `setup-pipeline` (or `export-solution`), and `deploy-pipeline` (or `import-solution`) — in that order. Each of those skills detects the approved plan via its Phase 0 gate, proceeds without re-nagging, and refreshes the plan on completion. This separation is deliberate: it keeps `plan-alm` safe to run unattended (e.g. under autopilot) because no single answer can trigger an irreversible deployment.

**Do NOT create tasks at the start** — strategy is unknown until Phase 2 completes. Create both tasks in Phase 3 once the strategy is determined.

---

## Phase 1 — Detect Project State

**Do NOT create tasks yet.** Use natural language progress reporting only during this phase.

Steps:

0. **Detect prior ALM deferral for this project.** Before any discovery work, check whether the project root contains a `.alm-deferred` marker file. The marker is written by users who explicitly opted ALM-skill validators out of "missing artifacts" warnings (e.g. *"this site is handled separately"* or *"ni-dev — no ALM"*). If a user is now invoking `plan-alm`, we should surface that the marker is present and ask what to do, rather than silently proceeding (which would build a plan the user previously decided not to maintain) or silently removing the marker (which would re-enable nags on every other ALM skill).

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/check-alm-plan.js" --projectRoot "."
   ```

   <!-- gate: plan-alm:1.deferral | category=progress | cancel-leaves=deferral-marker -->
   > 🚦 **Gate (progress · plan-alm:1.deferral):** `.alm-deferred` marker present — continue and remove, continue and keep marker, or cancel. Determines whether downstream ALM skills resume gate enforcement.

   The helper returns `{ deferred, deferral, ... }`. If `deferred === true`, read the deferral reason (`deferral.reason` or the raw marker text) and ask via `AskUserQuestion`:

   > "This project has an `.alm-deferred` marker — `{reason}`. ALM was previously deferred here, so the other ALM skills (`setup-solution`, `setup-pipeline`, `deploy-pipeline`, …) skip their plan-completeness checks for this project. How would you like to proceed?"

   | Question | Header | Options |
   |---|---|---|
   | How would you like to proceed? | ALM deferral marker | Continue planning and remove the marker (Recommended), Continue planning but keep the marker (record deferral context in plan), Cancel |

   - **Continue and remove marker (Recommended)** → delete `.alm-deferred` (the user is re-engaging with ALM). Set `DEFERRAL_CLEARED = true` and proceed to step 1.
   - **Continue and keep marker** → set `DEFERRAL_PRESERVED = true` and `DEFERRAL_REASON = {reason}`. Proceed to step 1. Surface a one-line note in the Phase 1 step 9 user report (e.g. *"Note: `.alm-deferred` is preserved — other ALM skills will continue to skip plan-completeness checks for this project."*) so the user remembers the marker remains in effect after planning.
   - **Cancel** → exit cleanly (don't touch the marker).

   If `deferred === false`, skip this step silently and proceed to step 1.

1. **Resolve the site identity from the local project.** `.powerpages-site/website.yml` is the source of truth for `websiteRecordId` and `siteName`, and it is present for **both** Power Pages site types:
   - **Code / SPA sites** — scaffolded by `/power-pages:create-site` and downloaded with `pac pages download-code-site`. These also have a `powerpages.config.json` and SPA source (`src/`, build output in `dist/`/`build/`).
   - **Data-model sites (standard and enhanced data model / "EDM")** — downloaded with `pac pages download --modelVersion 1|2`. These have **no** `powerpages.config.json`; instead `.powerpages-site/` holds the config tree (`web-pages/`, `web-templates/`, `content-snippets/`, …) plus a `.powerpages-site/.portalconfig/` manifest pair. There is no local build output.

   **Resolution order** (first match wins):
   1. **`.powerpages-site/website.yml`** (preferred, present for every downloaded/deployed site) — read with the `Read` tool and extract:
      - `id` field → `websiteRecordId`
      - `name` field → `siteName` (the file uses short keys; it is `name:`, not `adx_name:`)
   2. **`powerpages.config.json`** (fallback — code/SPA sites only; used during plugin development from this repo root or for sites scaffolded but not yet deployed) — read `siteName` and `websiteRecordId`.

   **Determine `SITE_TYPE`** (recorded in planData as `siteType`, surfaced in the plan, and used to skip SPA-only assumptions below):
   - `data-model` when `.powerpages-site/.portalconfig/` exists, **or** `.powerpages-site/website.yml` resolved while no `powerpages.config.json` is present.
   - `code` when `powerpages.config.json` is present.

   If neither marker is found, stop with:
   > "No Power Pages site found in the current directory. Run this skill from your site project root — that's where `.powerpages-site/` lives after `pac pages download-code-site` (code/SPA site) or `pac pages download --modelVersion 2` (enhanced data-model site). If you haven't created the site yet, run `/power-pages:create-site` first."

   `environmentUrl` is always re-confirmed from `pac env who` in step 4 — it does not need to come from either source.

2. Check for `.solution-manifest.json` in the project root:
   - Store `SOLUTION_DONE = true` if found, `false` otherwise
   - If found, read `solution.uniqueName` and store as `SOLUTION_UNIQUE_NAME`

3. Check for `docs/alm/last-pipeline.json` in the project root:
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
   Store `.token` as `DEV_TOKEN` and `.userId` as `userId`.

   **Track plan quality.** Initialize a `PLAN_QUALITY` accumulator to `"complete"` at the start of Phase 1. If this token acquisition fails (auth error), set `DEV_TOKEN = null`, set `PLAN_QUALITY = "degraded"`, and record the cause (e.g. *"dev-environment auth failed — contents/size/host discovery skipped"*) — then continue. Contents discovery is skipped gracefully, but the resulting plan is built on partial inputs; Phase 3 surfaces this as a prominent risk so the user reviews before executing. (There is no execute path to block here — `plan-alm` only plans — but a degraded plan must be visibly flagged.)

7. Discover and classify site settings (if `DEV_TOKEN` is available and `websiteRecordId` is known):

   Use Node.js `https` module to query. **Paginate via `@odata.nextLink`** — sites with > 500 settings would otherwise silently truncate, dropping tier classifications and underreporting `plannedEnvVarCount`. Send `Prefer: odata.maxpagesize=5000` so Dataverse emits the continuation link, then loop until exhausted:
   ```
   GET {DEV_ENV_URL}/api/data/v9.2/mspp_sitesettings?$filter=_mspp_websiteid_value eq '{websiteRecordId}'&$select=mspp_name,mspp_value&$top=5000
   Authorization: Bearer {DEV_TOKEN}
   Prefer: odata.maxpagesize=5000
   OData-MaxVersion: 4.0
   OData-Version: 4.0
   Accept: application/json
   ```
   On each response, append `value[]` to the running array. If `@odata.nextLink` is present, GET that URL with the same headers (no need to re-add the filter — the nextLink already encodes the query). Stop when the response has no `@odata.nextLink`. Cap at 100 iterations for safety.

   Classify the returned settings using `${CLAUDE_PLUGIN_ROOT}/scripts/lib/classify-site-settings.js` — the single source of truth for the credential regex and tier mapping shared with `setup-solution` Phase 5. Either pipe the JSON array of `{name, value}` rows into the script's stdin (CLI mode) or `require()` it inline:

   ```bash
   echo '<JSON array of {name,value}>' \
     | node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/classify-site-settings.js"
   ```

   Output (the four-bucket shape that downstream phases + `setup-solution` consume directly):

   ```js
   SITE_SETTINGS_DATA = {
     keepAsIs: [{name}],                          // regular settings (Tier 3 — Search/Bootstrap/WebApi/feature flags)
     authNoValue: [{name}],                       // Authentication/* or AzureAD/* with empty value (Tier 2b — added as-is, set in target env)
     promoteToEnvVar: [{name, value}],            // Authentication/* or AzureAD/* with value (Tier 2a — setup-solution offers env-var promotion)
     credentialNeedsDecision: [{name, value}]     // ConsumerKey/ConsumerSecret/ClientId/ClientSecret/AppSecret/AppKey/ApiKey/Password (Tier 1 — bulk-with-override prompt in setup-solution Phase 5.4.C)
   }
   ```

   Tier semantics in plain English (so reviewers reading the plan know what each bucket implies):
   - **Tier 1 (`credentialNeedsDecision`)** — credential-style names. Setup-solution Phase 5.4.C runs a single bulk prompt: auto-classify by name (Secret-typed env var for `*Secret`/`*Password`/`*ApiKey`/`*AppKey`; String-typed for `*Id`/`*ConsumerKey`), all-as-Secret, all-as-String, skip-all, or pick-per-credential.
   - **Tier 2a (`promoteToEnvVar`)** — auth config with a dev value. Setup-solution Phase 5.4.A asks which to back with env vars so each stage can use different values.
   - **Tier 2b (`authNoValue`)** — auth config with no dev value yet. Added to the solution as-is; user sets the value in each target env after deployment.
   - **Tier 3 (`keepAsIs`)** — everything else. Added unchanged.

   If the OData query fails or the helper errors out, set `SITE_SETTINGS_DATA = null` and continue — the plan still renders, it just can't break down site settings by tier.

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

10. **Estimate solution size and evaluate the split decision tree.** First ensure the ALM artifacts directory exists (all `.alm-*` and `last-*` artifacts live under `docs/alm/` to keep the project root uncluttered):
    ```bash
    node -e "require('fs').mkdirSync('docs/alm',{recursive:true})"
    ```
    Run the estimate helper to classify the site across size, component count, schema heaviness, web file aggregate, and env var count. Use the tmp-file write pattern — if the estimator fails, a prior good `docs/alm/alm-size-estimate.json` is preserved instead of being overwritten with an empty/partial file. When `SOLUTION_DONE = true` (a `.solution-manifest.json` exists), pass `--solutionId {solutionId}` so the env var count is scoped to the target solution — without it, the estimator falls back to a publisher-prefix tenant-wide query and overcounts whenever the prefix is shared across projects (the common `new_` / `cr5fe_` regression):
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/estimate-solution-size.js" \
      --envUrl "{DEV_ENV_URL}" --websiteRecordId "{websiteRecordId}" \
      --publisherPrefix "{publisherPrefix}" --siteName "{siteName}" \
      {if SOLUTION_DONE: --solutionId "{solutionManifest.solution.solutionId}"} \
      --projectRoot "." \
      --datamodelManifest "./.datamodel-manifest.json" > ./docs/alm/alm-size-estimate.json.tmp \
      && mv ./docs/alm/alm-size-estimate.json.tmp ./docs/alm/alm-size-estimate.json
    ```
    When `SOLUTION_DONE = false`, omit `--solutionId`; the estimator's output will include `envVarCountScope: "publisher-prefix"` to signal the wider scope, and the renderer surfaces this caveat in the Env Variables tab so reviewers know the number reflects the tenant view, not a specific solution. `--projectRoot "."` enables the disk cross-check — the estimator walks the local build output (`dist/`, `public-output/`, `build/`, `.output/`) and surfaces `webFilesDiskMeasuredMB`. When that number is much larger than the Dataverse-measured `webFilesAggregateMB`, the estimator flips `truncationSuspected: true` with a warning — file-typed columns whose bytes aren't returned by `$select=content` are the usual cause and the plan should trust the disk number.

> **`SITE_TYPE = "data-model"` (EDM/standard) sites have no build output**, so the disk cross-check finds no `dist/`/`build/` directory and `webFilesDiskMeasuredMB` stays `null` — this is expected, not a problem. Web files for data-model sites live as records under `.powerpages-site/web-files/` and are measured via the Dataverse query, so the size estimate is still valid; there's simply no SPA bundle on disk to cross-check against. Pass `--projectRoot "."` regardless — it's a harmless no-op for these sites.
    Then run the decision tree (same tmp-file pattern):
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/compute-split-plan.js" \
      --estimate ./docs/alm/alm-size-estimate.json \
      --projectRoot "." \
      --siteName "{siteName}" \
      --publisherPrefix "{publisherPrefix}" > ./docs/alm/alm-split-plan.json.tmp \
      && mv ./docs/alm/alm-split-plan.json.tmp ./docs/alm/alm-split-plan.json
    ```
    If either command exits non-zero, stop and report the stderr message to the user. Do not proceed to Q1b in Phase 2 without a valid split plan.
    Store the output as `SPLIT_PLAN`. Fields to read: `splitStrategy`, `proposedSolutions[]`, `appliedStrategies[]`, `assetAdvisory`, `sizeAnalysis`, `recommendations[]`.

    If `SPLIT_PLAN.proposedSolutions.length > 1`, set `RECOMMEND_SPLIT = true`. Otherwise `false`.

    Report to the user:
    ```
    Estimated size: {totalSizeMB} MB — components: {count} — tier: {overall tier}.
    Tables: {tableCount} — scoped to the site's table permissions ({tableCountScope}).
    Decision tree result: {splitStrategy} → {N} solutions recommended.
    Asset advisory: {K} files flagged for Azure Blob externalization.
    ```

    > **Table count is site-referenced, not publisher-prefix.** The estimator scopes custom tables to the tables the site actually references (its table permissions + datamodel manifest), so a shared/default publisher (`new_`) no longer inflates the count. `tableCountScope` reports how it was scoped: `site-referenced` (table permissions), `manifest-only`, or `unavailable` (no local `.powerpages-site/` signal — table count is 0, never an env-wide dump). When `unavailable`, note that the table-based split signal was skipped. The estimate command already passes `--projectRoot "."`, which supplies the local table permissions.

10b. **Enumerate environment variable definitions** (runs whenever `DEV_TOKEN` is available — the size estimator gives a count but not per-variable metadata).

    The renderer's Env Variables tab needs schema name, type, default value, and bound site setting per definition. Without this step, the tab can only show a count-summary note while the size signal and the warning quote a number — three views that don't fully agree. Running this query produces the row-level data so the table renders properly.

    Pass `--solutionId` when `SOLUTION_DONE = true` so the returned envVars[] is scoped to the target solution. The helper paginates correctly (Prefer: odata.maxpagesize + @odata.nextLink) regardless of scope — the difference is just which env vars are returned.

    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/discover-env-var-definitions.js" \
      --envUrl "{DEV_ENV_URL}" --token "{DEV_TOKEN}" \
      --publisherPrefix "{publisherPrefix}" \
      --websiteRecordId "{websiteRecordId}" \
      {if SOLUTION_DONE: --solutionId "{solutionManifest.solution.solutionId}"} > ./docs/alm/alm-env-vars.json.tmp \
      && mv ./docs/alm/alm-env-vars.json.tmp ./docs/alm/alm-env-vars.json
    ```

    Read the JSON: `{ envVars: [{ schemaName, type, defaultValue, siteSetting }], count, scope }`. The `scope` field is `'solution'` when `--solutionId` was passed and the solution had env var defs, `'publisher-prefix'` otherwise, `'none'` when the helper short-circuited (no prefix or auth lapse). Store `envVars` as `ENV_VARS_DETAILS` and `scope` as `ENV_VARS_SCOPE` for use when building `planData.envVars` in Phase 3 (pass through unchanged).

    The helper degrades gracefully (returns `{ envVars: [], count: 0, scope: 'none' }`) when the publisher prefix is unknown, the token has expired, or the query errors. In those cases the renderer falls back to the size estimator's count via `sizeAnalysis.envVarCount.value` (commit `8cbc39a`) — `ENV_VARS_DETAILS = []` is acceptable.

    > **Why scoping matters here**: without `--solutionId`, the helper filters env var defs by publisher prefix tenant-wide. For tenants with a generic prefix (`new_`, `cr5fe_`), this returns env vars from unrelated projects and inflates the count + the `envVars[]` table the renderer draws. The plan looks correct ("12 env vars detected") but is actually showing rows from someone else's project. With `--solutionId`, the helper intersects against `solutioncomponents.componenttype=380` for the target solution — only env vars actually owned by the plan's solution.

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

      <!-- gate: plan-alm:1.completeness | category=progress | cancel-leaves=nothing -->
      > 🚦 **Gate (progress · plan-alm:1.completeness):** Completeness check found gaps vs live site. Sync first, plan with gaps recorded, or cancel.

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

    **Skip rule:** if `PIPELINE_DONE = true`, skip this step entirely — the host info comes from `docs/alm/last-pipeline.json`. Only fresh-pipeline projects need resolution.

    Acquire a BAP-audience access token (the BAP API uses a different audience than Dataverse):
    ```bash
    az account get-access-token --resource "https://service.powerapps.com/" --query accessToken -o tsv
    ```
    Capture the output as `BAP_TOKEN`. If acquisition fails, set `HOST_RESOLUTION = { status: 'DetectionFailed', error: '<stderr>' }` and skip the detect call.

    Run the detect-only wrapper. Use the same tmp-file-then-mv pattern as Phase 1 step 10 so a prior good `docs/alm/alm-host-resolution.json` is preserved if the script fails mid-write. Pass `--skus Production,Sandbox,Trial` so trial-license and developer tenants see their eligible envs in the env-first menu (the helper's default is `Production,Sandbox`; we widen to include Trial here because plan-alm's NoHost branch always offers an existing-env install path that Trial envs can take, even though Trial envs cannot use the create-new fast-path):
    ```bash
    node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ensure-pipelines-host-detect.js" \
      --envUrl "{DEV_ENV_URL}" --token "{DEV_TOKEN}" --userId "{userId}" \
      --bapToken "{BAP_TOKEN}" \
      --projectRoot "." \
      --cacheMaxAgeHours 24 \
      --skus Production,Sandbox,Trial > ./docs/alm/alm-host-resolution.json.tmp \
      && mv ./docs/alm/alm-host-resolution.json.tmp ./docs/alm/alm-host-resolution.json
    ```

    > **Note**: `ensure-pipelines-host-detect.js` is a **detection-only wrapper** the `ensure-pipelines-host` skill exposes for orchestrators. It runs Phases 1.0 (cache fast-path) + 2 (resolution order including tenant-wide enumeration) + 5 (verify if a host is found) of that workflow, but never enters Phase 3 (decision tree) or Phase 4 (provisioning). Output matches the `docs/alm/last-host-check.json` schemaVersion 2 with `actionTaken: "none"` always.

    **Failure handling:** if the detection script exits non-zero, set `HOST_RESOLUTION = { status: 'DetectionFailed', error: '<stderr>' }` and continue. Phase 2 Q4 falls back to today's "enter URL manually" branch.

    On success, parse `docs/alm/alm-host-resolution.json` and store as `HOST_RESOLUTION` (mapping the wrapper's field names into the plan-alm shape):
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

**Log every major decision.** As each decision is made below (Q1 solution, Q1b split/override, Q2 strategy, Q3 stages/targets, Q4 host, Q5 approval mode, Q5 manual export type), append to a `DECISIONS_LOG` array: `{ field, value, source }` where `source = "default"` when the recommended/auto value was accepted without an active change, or `"explicit"` when the user picked a non-default option. Phase 4 renders a **"Decisions defaulted (please review)"** section from this log so a reviewer can see at a glance which choices were defaults vs. deliberate picks (closes the *"I never agreed to managed export"* gap). This adds no new prompts — it only records what the existing prompts produced.

### Q1 — Solution Setup (always asked first)

**If `SOLUTION_DONE = true`** (manifest found in Phase 1):

<!-- gate: plan-alm:2.q1-existing | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:2.q1-existing):** Existing solution found — reuse it (skip setup-solution) or create new (run setup-solution).

Ask via `AskUserQuestion`:
> "A Dataverse solution is already configured for this site: **{SOLUTION_UNIQUE_NAME}**. Use this existing solution?"

Options:
1. **Yes, use the existing solution** — `setup-solution` will be skipped in the plan
2. **No, create a new solution** — set `SOLUTION_DONE = false`; `setup-solution` will run

**If `SOLUTION_DONE = false`** (no manifest found):

Tell the user (not via `AskUserQuestion` — informational only):
> "No Dataverse solution is set up for this site yet. **`setup-solution` will be the first step in your plan.** The publisher prefix you choose during setup is irreversible — choose carefully."

<!-- gate: plan-alm:2.q1-fresh | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:2.q1-fresh):** No existing solution — include setup-solution in plan, or accept a user-supplied unique name.

Ask via `AskUserQuestion`:
> "Ready to include solution setup in the plan?"

Options:
1. **Yes, include solution setup** — continue
2. **I already have a solution (enter name)** — accept free-text solution unique name, set `SOLUTION_DONE = true`, `SOLUTION_UNIQUE_NAME = user input`

---

### Q1b — Split Recommendation (only if `RECOMMEND_SPLIT = true`)

<!-- gate: plan-alm:2.q1b-split | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:2.q1b-split):** Follow recommended split strategy, override to single, accept Asset Advisory first, or show migration guidance.

The decision tree from Phase 1 Step 10 recommended splitting into multiple solutions. Ask via `AskUserQuestion`:

> "Based on the site size and component analysis, the recommended approach is **{splitStrategy}** — {N} solutions instead of one. Do you want to follow this recommendation?"

Options:
1. **Use the recommended split** — proceed with `proposedSolutions[]` from the decision tree. `setup-solution` will create all N solutions.
2. **Keep as a single solution anyway** — override to single. Record override reason; `setup-solution` creates one solution with all components.
3. **Accept Asset Advisory first** (only offered if `assetAdvisory.candidates.length > 0`) — user commits to externalizing the flagged assets. Recompute size excluding those files, re-run the decision tree, present the new recommendation.
4. **Show me migration guidance** (only offered if an existing `.solution-manifest.json` is found and does not match the recommendation) — produce `docs/alm-migration-plan.md` and exit. Do not execute.

**If option 1:** continue with `proposedSolutions`.

**If option 2 — Keep as a single solution anyway:** this overrides a data-driven recommendation that's frequently right. Before honoring the override, **re-surface the tier signals so the user is making an informed choice, not a one-click dismissal.** Read from `SPLIT_PLAN.sizeAnalysis`:

   ```
   You're about to override a {splitStrategy} recommendation. Before doing that, here's what the estimator measured:

   • Total size:           {totalSizeMB.value} MB   (tier: {totalSizeMB.tier} — threshold {thresholds.maxSolutionSizeMB} MB)
   • Component count:      {componentCount.value}   (tier: {componentCount.tier} — threshold {thresholds.maxComponentCount})
   • Schema attributes:    {schemaAttrCount.value}  (tier: {schemaAttrCount.tier} — threshold {thresholds.maxSchemaAttrs})
   • Web files aggregate:  {webFilesAggregateMB.value} MB  (tier: {webFilesAggregateMB.tier} — threshold {thresholds.maxAggregateWebFilesMB} MB)
   • Env var definitions:  {envVarCount.value}      (tier: {envVarCount.tier})

   {if SPLIT_PLAN.truncationSuspected === true:
     ⚠ The estimator flagged its inputs as possibly truncated:
       {SPLIT_PLAN.truncationWarnings.join('\n       ')}
     The numbers above could be UNDER-counted. Investigate before overriding.
   }

   Solutions exceeding the platform thresholds frequently fail to import (timeouts, OOM, partial state). A single-solution plan that lands in the red tier is the most common cause of "the deploy hung overnight" reports. Recovering means splitting after the fact, which is harder than splitting upfront.
   ```

   <!-- gate: plan-alm:2.q1b-override | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · plan-alm:2.q1b-override):** Override the data-driven split recommendation to keep as single solution. Free-text `overrideReason` follows on Yes.

   Then ask via `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Still want to keep as a single solution? | Override confirmation | No — use the recommended {splitStrategy} split (Recommended), Yes — override anyway and note the reason, Cancel — re-think the strategy |

   - **No** → re-route to Option 1 (use the recommended split).
   - **Yes** → require a free-text `overrideReason` via a follow-up `AskUserQuestion` ("Briefly: why is single-solution the right call for this site?"). Record `overrideReason` and `overrideConfirmedSignals` (the tier-classified signals shown above) in the plan. Only then override `SPLIT_PLAN.proposedSolutions` to the single-solution structure for rendering.
   - **Cancel** → return to Q1b top.

   > **Why the friction:** in field-reported sessions, "keep as single anyway" was a one-click override and turned out to be the single most common path to a wrong recommendation. The re-confirmation isn't there to talk the user out of it — it's there to make sure the override is informed and the reason gets recorded for audit. Override-with-recorded-reason is fully respected; the gate only blocks the silent click-through.

**If option 3:** subtract advisory candidate sizes from the estimate, re-run `compute-split-plan.js`, re-present.
**If option 4:** write `docs/alm-migration-plan.md` (see the spec doc `solution-splitting-logic.md` §7), commit it, mark plan as Deferred, exit.

---

### Q2 — Strategy Selection (always asked)

<!-- gate: plan-alm:2.q2-strategy | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:2.q2-strategy):** Pick promotion strategy — PP Pipelines (Recommended), manual export/import, existing pipeline, or help-me-decide. Branches the rest of the plan.

**Recommendation prelude (shown inline in the prompt body).** Before listing the options, surface the recommendation and any state that affects it, so the user sees it up front instead of having to drill into option 4:

> **Recommendation: Power Platform Pipelines for ongoing CI/CD** — automated promotion, approval gates, and deployment history in one place. Manual export/import is intended for **one-off migrations** only; repeating it for every change loses the audit trail and silently allows version-skew bugs.
>
> *(Conditional, append when `HOST_RESOLUTION.resolutionStatus` ∈ {`AvailableUsingCustomHost`, `AvailableUsingCustomHostByAdminDefault`, `AvailableUsingPlatformHost`, `AvailableUnboundCustomHost`}):*
> A pipelines host already exists in your tenant at `{HOST_RESOLUTION.finalHostEnvUrl}` (Pipelines v`{HOST_RESOLUTION.pipelinesSolutionVersion}`). PP Pipelines requires **no new infrastructure** for this project.

Ask via `AskUserQuestion`:

> "How do you want to promote your solution between environments?"

Options:
1. **Power Platform Pipelines (Recommended for ongoing CI/CD)** — Microsoft's native CI/CD, managed deployments, approval gates
2. **Manual export/import (one-off migrations only)** — export a zip from dev and import directly to each target environment
3. **I already have a pipeline set up** — run a deployment now
4. **Help me decide** — show the full comparison again

Record the pick in `DECISIONS_LOG` (`{ field: "strategy", value, source }`).

**If option 4 selected:** Re-print the recommendation prelude above, then re-ask Q2 with only options 1–3.

**If option 3 selected:** Read `docs/alm/last-pipeline.json`, confirm pipeline name and stages, then skip to Phase 3 (generate plan) with `strategy = pp-pipelines`, `PIPELINE_DONE = true`.

---

### PP Pipelines Path — Q3 through Q6

<!-- gate: plan-alm:2.q3-stages | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:2.q3-stages):** Pick how many deployment stages — Staging only / +Production / Production directly / Custom.

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

<!-- gate: plan-alm:2.q4-host | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · plan-alm:2.q4-host):** Host environment selection — branches on `HOST_RESOLUTION.status` and surfaces the right menu (use-detected / pick from list / NoHost host-type / Sandbox confirm / CannotRedirect block / manual paste). Drives `HOST_ENV_URL` and `WILL_PROVISION_*` flags for the rest of plan-alm and ensure-pipelines-host. Uses `AskUserQuestion` per branch.
>
> **Trigger:** Phase 2 Q4 entry; `HOST_RESOLUTION` populated in Phase 1 step 12.
> **Why we ask:** Auto-picking a host can provision a new Custom Host (`WILL_PROVISION_CUSTOM`) consuming an Azure capacity quota the user didn't intend; or pick the wrong env, sending pipelines through a foreign host. The downstream ensure-pipelines-host skill TRUSTS this answer and skips its own 3.C menu.
> **Cancel leaves:** Nothing — no provisioning fired yet.

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
| `OrgSettingStale`, `PermissionDenied`, `DetectionFailed` | Surface the error; ask the user to enter the host URL manually with `pac env list` pre-fill (today's fallback). Pre-fill options from `ENV_LIST` (up to 3 known environment URLs) plus "Other" for a custom URL; pre-fill first option from `docs/alm/last-pipeline.json` if present. | `HOST_ENV_URL = user-supplied`. |

Store the resulting `HOST_ENV_URL` for use by the rest of plan-alm. The auxiliary flags `CHOSEN_ENV_URL`, `WILL_PROVISION_PLATFORM`, `WILL_PROVISION_CUSTOM`, `WILL_USE_PPAC`, `WILL_ENSURE_HOST`, and `USER_CHOSE_DEFER_TO_SETUP_PIPELINE` feed the planData `hostResolution` block in Phase 3 and the inline summary in Phase 4. ensure-pipelines-host reads `chosenEnvUrl`, `willProvisionPlatform`, `willProvisionCustom`, and `willUsePpac` from that block to bypass its own Phase 3.C menu when the user has already made the choice here.

**Eligible-env presentation cap** (used by the `NoHost` row above and by `MultipleUnboundCustomHosts`). When the eligible list runs long, build the visible options as follows so the prompt stays scannable:

1. **Always-visible role-labeled envs first.** Include any eligible env carrying a `dev env`, `source env`, `staging env`, or `production env` label (matched by URL origin against `devEnvUrl` and against `PP_STAGES[].envUrl`). These are the project's own envs and are nearly always the right pick. Dedupe by origin.
2. **Fill remaining slots up to 5** from the rest of the eligible list, in the order returned by `list-tenant-envs.js` (name-hint pattern `pipeline|deploy|host|alm|cicd|govern` → admin-perms → recency).
3. **Append "Other (paste URL)"** as the last per-env entry inside option 1's nested list — escape hatch for envs that didn't make the cap.
4. When `eligible.length > 5`, suffix option 1's headline with: ` Showing top 5 of {N}; the remaining {N-5} eligible env(s) can be reached via the "Other (paste URL)" entry.` When `eligible.length <= 5`, no suffix (all envs visible inline).
5. When the user picks "Other (paste URL)", pre-fill the URL input with `ENV_LIST` (the `pac env list --output json` output gathered in Phase 1) so they can paste-or-pick from the full inventory rather than typing a URL by hand.

The same cap policy applies to `ensure-pipelines-host` Phase 3.C — see that skill's Step 3a for the same rules. Keep the two implementations consistent so users see the same prompt shape regardless of whether they enter via plan-alm or directly via setup-pipeline → ensure-pipelines-host.

<!-- gate: plan-alm:2.q5-approval | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:2.q5-approval):** Pick approval mode — required per stage / staging auto + prod required / no gates.

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

---

### Manual Path — Q3 through Q6

<!-- gate: plan-alm:2.q3-manual | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:2.q3-manual):** Pick how many target environments for manual export/import path.

**Q3:** Ask via `AskUserQuestion`:
> "How many target environments do you need to deploy to?"

Options:
1. One target (e.g. Production)
2. Two targets (e.g. Staging then Production)
3. Dev only — not deploying yet

Store as `MANUAL_TARGET_COUNT`.

If option 3: set `MANUAL_TARGET_COUNT = 0`. Proceed to Q5.

<!-- gate: plan-alm:2.q4-manual-target | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:2.q4-manual-target):** Pick the URL for each manual target env. **Fires PER TARGET in the `MANUAL_TARGET_COUNT` loop.** Two targets (Staging + Production) = two separate prompts. Each prompt pre-fills from `pac env list` and accepts a different URL. Do NOT collect all target URLs in a single multi-input prompt — each target is a distinct decision (different audiences, different env characteristics, possibly different SKUs).

**Q4 (one per stage):** For each target environment needed, ask via `AskUserQuestion`:

> "What is the URL for target environment {N}?"

Pre-fill from `ENV_LIST`: show up to 3 known environment URLs from `pac env list` as options, plus "Enter a different URL" as the last option.

Store target URLs as `MANUAL_TARGETS` (array).

<!-- gate: plan-alm:2.q5-manual-type | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · plan-alm:2.q5-manual-type):** Managed vs Unmanaged export — irreversible choice for the produced zip.

**Q5:** Ask via `AskUserQuestion`:
> "How should the solution be exported?"

Options:
1. Managed — for staging/production (cannot edit in target)
2. Unmanaged — for dev-to-dev (editable in target)

Store as `EXPORT_TYPE`, and log the decision (`{ field: "exportType", value: EXPORT_TYPE, source: "default"|"explicit" }`).

> **No checkpoint preference is collected.** `plan-alm` no longer runs the export/import itself, so the old *"pause between export and import?"* question (which only gated execution) is gone. The plan records the recommended sequence — `export-solution` then `import-solution` per target — and the user reviews the zip between those steps when they run them. A standing note to that effect is added to the plan's risks/steps in Phase 3.

**Q6 (auto-detect, no question):** Same as PP Pipelines Q6 — check for env var definitions.

---

## Phase 3 — Generate HTML Plan

**Now create the two planner tasks** — strategy is known. `plan-alm` is a planner, so it has exactly **two** tasks regardless of path:

| # | Subject | activeForm | Description |
|---|---------|-----------|-------------|
| 1 | Generate ALM plan | Generating ALM plan | Build planData, render docs/alm-plan.html |
| 2 | Approve & save ALM plan | Awaiting plan approval | Present inline summary, capture approver, save (approved or draft) |

> **Do not create Setup/Deploy/Activate/Test/Import/Finalize tasks.** Those are *execution* steps performed by the individual ALM skills the user runs after approval — they are not `plan-alm` tasks. The recommended sequence still appears in the plan: the planData `steps[]` array below lists it (all `status: "pending"`), and the rendered HTML's Execution Checklist shows it as the plan of record. Each downstream skill marks its own step complete (via `refresh-alm-plan-data.js`) when the user runs it.

Mark task 1 ("Generate ALM plan") as `in_progress`.

### Build planData

Build a `planData` object with all gathered strategy inputs:

```json
{
  "SITE_NAME": "{siteName}",
  "siteType": "code | data-model",         // from Phase 1 Step 1 — "data-model" for enhanced/standard data-model (EDM) sites (no SPA build output), "code" for SPA sites
  "GENERATED_AT": "{ISO timestamp}",
  "STRATEGY": "pp-pipelines | manual",
  "EXPORT_TYPE": "managed | unmanaged",   // PP Pipelines path: always "managed"
  "APPROVAL_MODE": "{approvalMode description}",
  "HAS_ENV_VARS": true | false,
  "SOLUTION_DONE": true | false,
  "PIPELINE_DONE": true | false,
  "PLAN_STATUS": "Draft",                 // set to "Approved" or "Draft" in Phase 4; plan-alm never sets "In Execution"/"Completed"
  "PLAN_MODE": "draft",                   // "approved" | "draft" — set in Phase 4. Tooling/downstream skills distinguish an approved plan from a draft. Never "executed" (plan-alm doesn't execute).
  "PLAN_QUALITY": "complete",             // "complete" | "degraded" — degraded when discovery was incomplete (Phase 1 auth failure or the Phase 3 completeness check failed). Surfaced as a prominent risk.
  "decisionsLog": [                       // from DECISIONS_LOG (Phase 2) — drives the Phase 4 "Decisions defaulted" section
    { "field": "strategy", "value": "pp-pipelines", "source": "explicit" }
  ],
  "LAST_INVOCATION_AT": null,
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
  // The steps[] above is the PP Pipelines path. For the MANUAL path (STRATEGY = "manual")
  // emit this shape instead — do NOT include "Setup pipeline"/"Deploy via pipeline":
  //   { "name": "Setup solution", ... },
  //   { "name": "Export solution", ... },
  //   then PER Manual target {targetLabel}:
  //     { "name": "Import to {targetLabel}", ... },
  //     { "name": "Activate site in {targetLabel}", ... },   // import-solution does NOT activate
  //     { "name": "Test site in {targetLabel}", ... }
  // These names are what refresh-alm-plan-data.js step-sync (export/import/activate/test)
  // and computeNextStep match on, so the manual checklist and next-step nudges resolve
  // to /power-pages:export-solution → /power-pages:import-solution → /power-pages:activate-site → /power-pages:test-site.
  "validationRuns": {
    "Staging": null,
    "Production": null
  },
  "pipelineMeta": null,                   // populated when docs/alm/last-pipeline.json exists — see "pipelineMeta block" below
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
  "appliedStrategies": ["strategy-1-layer"],            // may include "composite-sub-partition" when a Layer-split child still exceeded the size or count cap and was sub-divided
  "compositeSubPartitioned": false,                     // mirrors SPLIT_PLAN.compositeSubPartitioned — true when the renderer's strategy rationale should mention sub-partitioning
  "proposedSolutions": [ /* from SPLIT_PLAN.proposedSolutions — ALWAYS at least 1 entry */ ],
  "recommendations": [ /* from SPLIT_PLAN.recommendations */ ],
  "envVars": [ /* from ENV_VARS_DETAILS (Phase 1 Step 10b) — { schemaName, type, defaultValue, siteSetting } per definition; empty array when DEV_TOKEN unavailable */ ],
  "plannedEnvVarCount": 0,                // sum of SITE_SETTINGS_DATA.promoteToEnvVar.length + credentialNeedsDecision.length — env vars setup-solution will offer to create. Renderer shows this as "N planned" alongside the existing-count stat so a fresh project (envVars: []) doesn't look like nothing is happening when the risks list says auth settings will be promoted. Reset to 0 by refresh-alm-plan-data setup-solution phase.
  "breakdown": { /* bytes-per-category from the estimate */ },
  "estimationMethod": "metadata-based",
  "estimationAccuracyPct": 15,
  "truncationSuspected": false,             // true when the estimator's truncation canary fired — surfaced as a red banner on the rendered plan and gates the "keep as single solution anyway" override in Phase 2 Q1b
  "truncationWarnings": [],                 // specific category-level reasons the canary fired (e.g. "Dataverse reports 6050 powerpagecomponent rows but discovery returned 500")
  "webFilesDiskMeasuredMB": null,           // disk-measured total when `--projectRoot` was passed to estimate-solution-size.js and a build-output dir (dist/public-output/build/.output) was found; null otherwise. Renderer surfaces this under the Web Files signal when it disagrees materially with `webFilesAggregateMB` — useful when file-typed columns hold bytes that $select=content can't return.
  "webFilesDiskMeasuredPath": null,         // the build-output directory that produced webFilesDiskMeasuredMB; null when not measured.
  "webFileSampleSize": 0,                   // how many web-file rows the stratified sampler actually read for size measurement. Compared with webFileCount this tells reviewers how aggressively the aggregate was extrapolated.

  // --- Raw discovery snapshot — embedded verbatim for diagnosability ---
  // The mapped fields above (sizeAnalysis, splitStrategy, hostResolution, …)
  // are derived from these. When a rendered plan looks wrong, this block is
  // what a reviewer (or another agent) needs to diagnose without re-running
  // discovery. Never reference these fields from the renderer's display
  // paths — keep them as a sealed diagnostic envelope.
  "rawDiscovery": {
    "estimate": { /* full output of estimate-solution-size.js, verbatim */ },
    "splitPlan": { /* full output of compute-split-plan.js, verbatim */ },
    "hostResolution": { /* full output of ensure-pipelines-host-detect.js (PP path only) or null */ }
  },

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

**`validationRuns` block** (PP Pipelines path only — initialize one entry per target stage with value `null`). plan-alm leaves these `null` at plan time; they are populated later by **`test-site`'s own final-phase refresh** (`refresh-alm-plan-data.js --phase test-site --stageName {stage}`) when the user runs `test-site` for each stage. The full categorized test report drives the **Validation** tab in the rendered HTML. Shape per stage:

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

The shape is identical to `docs/alm/last-test-site.json` written by `test-site` Phase 6.7a — the refresh helper reads that file verbatim and assigns it to `validationRuns[stageName]` when `test-site` runs. The renderer maps `runOutcome` to green / yellow / red Outcome badges and produces a sub-tab per stage on the Validation tab. For the Manual path, omit `validationRuns` from planData.

**`pipelineMeta` block** (PP Pipelines path only — read from `docs/alm/last-pipeline.json` and `docs/alm/last-deploy.json` at planData-build time. `null` on fresh plans where no pipeline is configured yet. Later refreshed by `setup-pipeline`'s and `deploy-pipeline`'s own final-phase refresh when the user runs them). Highlights the pipeline that is actually moving configurations for this project. Shape:

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

- `isActive`: `true` whenever the project has a configured pipeline (`docs/alm/last-pipeline.json` exists). Drives the **ACTIVE** chip on the Pipelines tab.
- `pipelineName`: from `docs/alm/last-pipeline.json`. The renderer falls back to `${SITE_NAME}-Pipeline` when `pipelineMeta` is absent.
- `reusedByWiring`: `null` when the pipeline was created fresh; an object `{ originalName, requestedName }` when `create-deployment-pipeline.js` matched an existing pipeline by source+target wiring and reused it under its existing name. The renderer surfaces this with an explanatory note so reviewers understand why the plan and the live pipeline names may differ.
- `lastDeploy`: derived from `docs/alm/last-deploy.json`. Omit (set to `null`) before the first deploy.

**How to populate.** During Phase 3 planData build, read both files (Node.js inline) and inject:
```bash
node -e "
const fs = require('fs');
const meta = { isActive: false, pipelineId: null, pipelineName: null, reusedByWiring: null, lastDeploy: null };
try {
  const lp = JSON.parse(fs.readFileSync('docs/alm/last-pipeline.json','utf8'));
  meta.isActive = true;
  meta.pipelineId = lp.pipelineId || null;
  meta.pipelineName = lp.pipelineName || null;
  meta.reusedByWiring = lp.reusedByWiring || null;
} catch {}
try {
  const ld = JSON.parse(fs.readFileSync('docs/alm/last-deploy.json','utf8'));
  meta.lastDeploy = {
    status: ld.status, stageName: ld.stageName, deployedAt: ld.deployedAt,
    artifactVersion: ld.artifactVersion, componentCount: ld.componentCount,
  };
} catch {}
process.stdout.write(JSON.stringify(meta));
"
```
Embed the result as `planData.pipelineMeta`.

**v2 fields** (`sizeAnalysis`, `assetAdvisory`, `splitStrategy`, `appliedStrategies`, `compositeSubPartitioned`, `proposedSolutions`, `recommendations`, `breakdown`) come straight from `SPLIT_PLAN` computed in Phase 1 Step 10, mutated by Q1b user choices. Pass them through unchanged to the renderer. **`envVars`** comes from `ENV_VARS_DETAILS` populated in Phase 1 Step 10b — pass it through unchanged. When the array is empty, the renderer's count-aware fallback uses `sizeAnalysis.envVarCount.value` so the Env Variables tab still shows a count-summary note.

**Disk-measurement cross-check** (`webFilesDiskMeasuredMB`, `webFilesDiskMeasuredPath`, `webFileSampleSize`) — hoist these from the estimator output (`rawDiscovery.estimate.webFilesDiskMeasuredMB`, etc.) onto the top level of `planData`. They're only populated when `--projectRoot "."` was passed to `estimate-solution-size.js` AND a build-output directory was detected. The renderer surfaces `webFilesDiskMeasuredMB` next to the Dataverse-measured Web Files signal when the two numbers disagree materially (the same condition that flips `truncationSuspected`), so reviewers can see at a glance which number to trust. Pass `null` for all three when the estimator didn't measure disk.

**Truncation canary** (`truncationSuspected`, `truncationWarnings`) — pass through verbatim from `SPLIT_PLAN.truncationSuspected` / `SPLIT_PLAN.truncationWarnings` (which `compute-split-plan.js` itself reads from the estimate). When `truncationSuspected === true`, the rendered plan shows a red banner above the size analysis, and the Phase 2 Q1b "keep as single anyway" override is gated by an extra confirmation step (see Phase 2 Q1b). Common causes: Dataverse pagination regression in `estimate-solution-size.js` OR a web-file undercount (file-typed columns whose bytes aren't returned via `$select=content`) — the disk cross-check (when enabled) flags the latter explicitly.

**`rawDiscovery` block** — embed the full estimator + split-plan + host-resolution outputs verbatim, before any field mapping. This is a diagnostic envelope: in general, the renderer must not reference its contents from display paths. **Narrow exception**: the renderer's `webFilesDiskMeasured*` / `webFileSampleSize` read paths fall back to `rawDiscovery.estimate.*` if the top-level hoist is missing, so older plan files (written before the hoist was specified) still render the disk-compare note. The right fix when you see that fallback fire is to re-build planData with the hoist populated, not to keep the fallback path active. Otherwise the principle stands: `rawDiscovery` exists so a reviewer (or a future agent debugging a wrong plan) can read `docs/.alm-plan-data.json` and see what the discovery scripts actually produced, side-by-side with the mapped fields the renderer used. Read each source file once and assign:

```js
planData.rawDiscovery = {
  estimate: readJson('./docs/alm/alm-size-estimate.json'),
  splitPlan: readJson('./docs/alm/alm-split-plan.json'),
  hostResolution: PIPELINE_DONE
    ? null                                       // host info comes from .last-pipeline.json in that path
    : readJson('./docs/alm/alm-host-resolution.json'),  // PP path with detection; null for Manual path
};
```

Use `null` for any source that was skipped (Manual path doesn't run host resolution; pre-pipeline projects don't have a manifest). Do not redact or summarize — the value of the snapshot is that it's the raw input.

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
- **Manual path** (always, when `STRATEGY = "manual"`): `{ type: "info", message: "Recommended sequence: run /power-pages:export-solution, review the produced zip, then run /power-pages:import-solution for each target. plan-alm does not perform the export/import itself." }`
- **Raw-discovery gaps (#9)** — for each of `rawDiscovery.estimate`, `rawDiscovery.splitPlan`, and (PP path) `rawDiscovery.hostResolution` that is `null` at planData-build time: `{ type: "warning", message: "Discovery for {X} did not run; the related size/split/host decisions in this plan are unverified." }` (substitute `{X}` = "solution size estimate" / "split analysis" / "pipeline host resolution").

**Plan completeness check (#10).** Before writing planData, verify the plan rests on real discovery:
- `sizeAnalysis.totalSizeMB` is non-null,
- `stages[]` is non-empty,
- `solutionContents` is populated when a solution is configured (`SOLUTION_DONE = true`).

If any check fails, set `PLAN_QUALITY = "degraded"` and record which check failed. (This is in addition to the Phase 1 Step 6 auth-failure path that already sets degraded.)

**Degraded-plan risk (#8)** — if `PLAN_QUALITY === "degraded"` (from the auth-failure path or the completeness check), prepend to `risks`: `{ type: "warning", message: "⚠ PLAN QUALITY: DEGRADED — discovery was incomplete ({cause}). Review carefully before executing; re-run /power-pages:plan-alm after fixing the cause (commonly dev-environment auth) to regenerate a complete plan." }`. Use `type: "warning"` (the renderer styles it). Substitute `{cause}` from the recorded reason(s).

Write `planData` to `docs/.alm-plan-data.json` (create `docs/` if it doesn't exist).

### Render the HTML plan

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/plan-alm/scripts/render-alm-plan.js" \
  --output "<projectRoot>/docs/alm-plan.html" \
  --data "<projectRoot>/docs/.alm-plan-data.json"
```

**Keep `docs/.alm-plan-data.json` on disk — never delete it.** Two consumers depend on it after `plan-alm` exits: (1) the **execution skills' final-phase refresh** (`refresh-alm-plan-data.js`) reads it to update `hostResolution`, `pipelineMeta`, `validationRuns`, `risks`, `steps[]` status, and the footer as each skill runs, then re-renders `docs/alm-plan.html` so the rendered tabs reflect actual run state (not the pre-run plan); (2) `check-alm-plan.js` reads it for the Phase 0 ALM-plan gate in `setup-pipeline` / `deploy-pipeline` / `setup-solution` / `export-solution` / `import-solution` / `configure-env-variables` — deleting it makes every downstream skill think no plan exists (and fire its no-plan gate). Earlier guidance to delete this file after the initial render was incorrect and caused the Pipelines tab + risks list to stay frozen at pre-run state for the lifetime of the plan.

Write `docs/alm/alm-plan-context.json` (persists so `setup-solution` can read it):
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

## Phase 4 — Present Plan, Approve & Save

Mark task 2 ("Approve & save ALM plan") as `in_progress`.

**`plan-alm` stops here.** This phase saves the plan (approved or draft) and exits. It does **not** invoke `setup-solution`, `setup-pipeline`, `deploy-pipeline`, `export-solution`, or `import-solution`. The user runs those afterward.

Present a concise inline Markdown summary:

```
## ALM Plan: {siteName}

**Strategy:** {PP Pipelines / Manual export/import}
**Stages:** {Dev} → {Staging} → {Production (if applicable)}
**Approval gates:** {description from PP_APPROVAL_MODE, or "N/A — manual path"}
**Solution export:** {Managed / Unmanaged}
**Pipeline host:** {hostEnvUrl} ({status}) — *(PP Pipelines path only; when `WILL_ENSURE_HOST = true`, render as `Will be ensured during setup-pipeline ({status})` instead)*
**Plan quality:** {complete / ⚠ DEGRADED — <cause>}

**Decisions defaulted (please review):**
{For each DECISIONS_LOG entry, one line: "- {field}: {value} ({default} or {your pick})". Tag source:"default" as (default) and source:"explicit" as (your pick). If every decision was explicit, write "- (none — every choice was an explicit pick)".}

**Recommended execution sequence (you run these after approval):**
- [ ] /power-pages:setup-solution {(SKIP — already set up) if SOLUTION_DONE}
- [ ] /power-pages:setup-pipeline {(SKIP — already set up) if PIPELINE_DONE} {(PP path only)}
- [ ] /power-pages:export-solution {(manual path only)}
- [ ] /power-pages:deploy-pipeline — per stage {(PP path only)}
- [ ] /power-pages:import-solution — per target {(manual path only)}

Full plan written to: docs/alm-plan.html
```

<!-- gate: plan-alm:4.approve | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · plan-alm:4.approve):** The capstone — user saves the rendered HTML plan. `plan-alm` never executes; this gate only chooses whether the plan is saved **Approved** (ready for the user to run the execution skills) or **Draft**, or sends the user back to revise. No downstream skill is dispatched here.

Ask via `AskUserQuestion`:
> "How would you like to save this ALM plan?"

Options:
1. **Save plan — approved, ready to execute** (saves as Approved; you run the execution skills next)
2. **Save plan as draft** (saves as Draft; re-run plan-alm to approve later)
3. **I want to change something** — go back to questions

- **If option 3:** Re-run Phase 2 (ask which section to change, then re-gather those answers). Regenerate the plan (repeat Phase 3). Re-present for approval.
- **If option 1 (approved):** Capture the approver (see below). Stamp `<span id="approved-by">` / `<span id="approval-date">` in the HTML and set `<span class="plan-status">` text to `Approved` via `Edit`. **Update `docs/.alm-plan-data.json`**: set `PLAN_STATUS: "Approved"` and `PLAN_MODE: "approved"`. Then run the finalize steps below (skill tracking + commit), print the next-steps guidance, mark task 2 `completed`, and **exit**.
- **If option 2 (draft):** Do **not** capture an approver. Set `<span class="plan-status">` text to `Draft` via `Edit`. Update `docs/.alm-plan-data.json`: `PLAN_STATUS: "Draft"`, `PLAN_MODE: "draft"`. Run the finalize steps below (commit only — skip skill tracking or run it, your choice; commit message `"Add ALM plan for {siteName} (draft)"`), tell the user to re-run `/power-pages:plan-alm` when ready to approve, mark task 2 `completed`, and **exit**.

**Capturing the approver (option 1 only) — always interactive (#1):**

Never auto-apply a name silently. First compute a **prefill suggestion** from git / OS user:

```bash
node -e "const {execSync}=require('child_process');let n='';try{n=execSync('git config user.name',{encoding:'utf8'}).trim();}catch{};if(!n){n=process.env.USER||process.env.USERNAME||'';}process.stdout.write(n);"
```

<!-- not-a-gate: approver-name capture — data-gathering prompt with git/OS-name prefill; always fires before stamping the audit trail -->

Then **always** ask via `AskUserQuestion` (even when the suggestion is non-empty) so a human actively confirms the approver recorded in the audit trail:

> "Who is approving this plan? (recorded in the audit trail in docs/alm-plan.html)"
>
> Options: 1. *{suggested name from git/OS, if any}* · 2. Other (enter name)

If the command returned an empty string, present only option 2 (free-text). Store the confirmed result as `APPROVER`, then use `Edit` to replace the spans in `docs/alm-plan.html`:

- Find `<span id="approved-by">` (or `<span id="approved-by"></span>` / `<span id="approved-by">__APPROVED_BY__</span>`) and replace its inner text with `APPROVER`.
- Find `<span id="approval-date">` and replace its inner text with the current ISO timestamp.

Both spans are guaranteed to exist in the template — there is exactly one of each in the "Execution Checklist" tab footer.

**Finalize (both save options):**

1. **Skill tracking** (option 1; optional for draft):
   > Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/update-skill-tracking.js" \
     --projectRoot "." --skillName "PlanAlm" --authoringTool "ClaudeCode"
   ```
2. **Commit the plan** — pick the commit message for the save option the user chose:
   - **Option 1 (Approved):**
     ```bash
     git add docs/alm-plan.html && git commit -m "Add ALM plan for {siteName}"
     ```
   - **Option 2 (Draft):**
     ```bash
     git add docs/alm-plan.html && git commit -m "Add ALM plan for {siteName} (draft)"
     ```
   `docs/.alm-plan-data.json` stays on disk — it is read by `check-alm-plan.js` for every downstream skill's Phase 0 gate and refreshed by those skills as they run. **Never delete it.**

**Next-steps guidance (option 1 — print to the user, do NOT invoke):**

> "Plan approved and saved. **plan-alm doesn't deploy** — run these next, in order. Each detects this plan and proceeds without re-asking, then updates the plan as it completes:
> - **PP Pipelines path:** `/power-pages:setup-solution` → `/power-pages:setup-pipeline` → `/power-pages:deploy-pipeline` (once per target stage; the deploy flow activates the site for you — but if you defer activation, run `/power-pages:activate-site`) → `/power-pages:test-site` to validate each stage.
> - **Manual path:** `/power-pages:setup-solution` → `/power-pages:export-solution` → review the zip → `/power-pages:import-solution` (once per target).
> Skip any step marked *already set up*. You can re-open the plan any time at `docs/alm-plan.html`."

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Generate ALM plan | Generating ALM plan | Gather strategy inputs, build planData, render docs/alm-plan.html |
| Approve & save ALM plan | Awaiting plan approval | Present inline summary (incl. defaulted-decisions + plan quality), capture approver, save Approved or Draft, commit, print next-steps |

> `plan-alm` has exactly these two tasks. Setup / pipeline / deploy / export / import / activate / test are performed by the individual ALM skills the user runs **after** approval — they appear in the plan's `steps[]` (the recommended sequence) but are never `plan-alm` tasks.

---

## Key Decision Points (Wait for User)

1. **Phase 1**: `.alm-deferred` marker handling; pre-plan completeness check (if a solution exists)
2. **Phase 2, Q1**: Solution setup — confirm existing or include `setup-solution` in plan
3. **Phase 2, Q1b**: Split recommendation + override confirmation (if recommended)
4. **Phase 2, Q2**: Promotion strategy — PP Pipelines, Manual, or already set up
5. **Phase 2, Q3–Q5** (PP path): Stage count, host env, approval gates (managed auto-set)
   **Phase 2, Q3–Q5** (Manual path): Target count, target env URLs, export type
6. **Phase 4**: Save the plan — Approved, Draft, or revise. **This is the only "approval"; no execution follows.**

## Error Handling

- No `.powerpages-site/website.yml` **and** no `powerpages.config.json`: stop, advise `/power-pages:create-site` (Phase 1 resolves site identity from either marker — a data-model/EDM site has only `website.yml`, so don't hard-stop on the missing config alone)
- `pac env list` fails: skip ENV_LIST pre-filling; ask for environment URLs manually
- `render-alm-plan.js` fails (non-zero exit): report error, show planData JSON as fallback, ask user whether to proceed
- Discovery/auth failure: set `PLAN_QUALITY = "degraded"`, surface a prominent risk, still produce the plan (the user fixes auth and re-runs to regenerate)
- Plan approval = option 3 (change something): re-run Phase 2 fully, then regenerate plan — do not carry over stale answers
