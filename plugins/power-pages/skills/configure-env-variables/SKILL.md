---
name: configure-env-variables
description: >-
  Configures environment variables for Power Pages site settings to support ALM across environments.
  Creates environment variable definitions in Dataverse, guides the user through linking site settings
  to those variables via the Power Pages Management app, adds the variables to the solution, and
  generates a deployment-settings.json file with per-stage override values.
  Use when asked to: "configure environment variables", "add env vars", "set up deployment variables",
  "make site settings environment-specific", "configure ALM variables", "set up env-specific settings",
  "add deployment settings", "configure per-environment settings".
user-invocable: true
argument-hint: "Optional: site setting name or env var schema name to pre-select"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# configure-env-variables

Creates and links Dataverse environment variables to Power Pages site settings, enabling different configuration values per deployment environment (dev vs staging vs prod). Generates `deployment-settings.json` for use by `deploy-pipeline`.

## Background

Power Pages site settings can be backed by environment variables (GA March 2025, enhanced data model only). When linked:
- The site setting's `mspp_source` changes from `0` (static) to `1` (environment variable)
- The runtime reads the env var value for the current environment instead of the static `mspp_value`
- During pipeline deployment, target-environment values are injected via `deploymentsettingsjson`

**API note**: The site setting → env var link is set via a HAR-confirmed OData PATCH pattern (v9.0, `EnvironmentValue` nav property, `if-match: *` and `clienthost: Browser` headers required). This is handled by `scripts/lib/link-site-setting-to-env-var.js`. All steps are fully automated.

## Prerequisites

- PAC CLI authenticated: `pac auth who`
- Azure CLI token available: `az account get-access-token`
- `.solution-manifest.json` exists in the project root (run `setup-solution` first)
- Power Pages site deployed to dev environment (`.powerpages-site/` folder exists)

## Phase 0 — ALM plan gate

> **`plan-alm` is the front door.** When the user expresses an ALM intent (*promote / ship / deploy / set up CI-CD / move to staging / push to prod*), the orchestrator (`/power-pages:plan-alm`) should run first. This Phase 0 enforces that and is meant to fail closed when there's no plan, not to be a one-time check the user can dismiss forever.

**Skip rule.** If this skill was invoked *as part of an active `plan-alm` orchestration*, skip Phase 0 entirely and proceed to Phase 1. The gate helper exposes this via its `inExecution` block — pass through silently to Phase 1 when:

```
inExecution.status === "active"
```

The helper computes this from `docs/.alm-plan-data.json` — `PLAN_STATUS === "In Execution"` AND `LAST_INVOCATION_AT` within the last 60 minutes. `check-alm-plan.js` refreshes `LAST_INVOCATION_AT` automatically on every invocation that finds the plan in execution, so each in-chain skill keeps the chain alive for the next one — even multi-hour deploys (deploy-pipeline alone can take 60 min per stage) survive the window without the chain incorrectly de-classifying. Stalled chains (no heartbeat for > 60 min) reclassify as `stale-heartbeat` and Phase 0 gates fire normally so an abandoned plan doesn't silently bypass user confirmation.

When `inExecution.status` is anything other than `"active"` (`"not-running"`, `"stale-heartbeat"`, `"no-plan"`), run the Phase 0 gate flow below. Branch on the remaining helper fields:

**Step 1 — Run the gate helper.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/check-alm-plan.js" --projectRoot "."
```

The helper returns JSON with `{ exists, deferred, stale, staleness: { reason, detail }, generatedAt, planStatus, ... }`. Pass `--envUrl`, `--token`, `--solutionId` once Phase 1 has acquired them if you also want a freshness check; otherwise the helper does an existence-only check, which is sufficient for the gate decision below.

**Step 2 — Branch on the result.**

| Result | Behavior |
|---|---|
| `deferred: true` | The user has explicitly deferred ALM for this project (`.alm-deferred` marker present). Pass through silently to Phase 1 — do not nag. |
| `exists: false` | The user hasn't run `plan-alm` yet. See Step 3. |
| `exists: true, stale: false` | Plan is current. Pass through silently to Phase 1. |
| `exists: true, stale: true` (reason: `solution-modified`) | The solution changed after the plan was generated. See Step 4. |

**Step 3 — No plan.** Tell the user:

> "No ALM plan exists for this project. `/power-pages:plan-alm` builds one — it detects the project state, asks about your promotion strategy (PP Pipelines vs Manual export/import), classifies which site settings should become environment variables, and orchestrates the right skills (including this one) in the right order. Want me to run plan-alm now?"

<!-- gate: configure-env-variables:0.no-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · configure-env-variables:0.no-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `exists:false`. Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Run `/power-pages:plan-alm` first? | ALM plan gate | Yes — run /power-pages:plan-alm now (Recommended), Continue without a plan (advanced — I know what I'm doing), Cancel |

- **Yes (Recommended)** → invoke `/power-pages:plan-alm`. It builds the plan and returns — `plan-alm` is a planner and does not deploy. This skill then re-runs the Phase 0 check (now `exists:true`) and proceeds to Phase 1, picking up the pre-classified `siteSettings` from `docs/alm/alm-plan-context.json`.
- **Continue without a plan** → set `BYPASSED_PLAN_GATE = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Step 4 — Stale plan.** Tell the user:

> "ALM plan exists from `{generatedAt}` but the source solution has been modified since (at `{solution.modifiedon}`). Components may have changed. Re-running `plan-alm` will refresh the analysis and the rendered HTML."

<!-- gate: configure-env-variables:0.stale-plan | category=intent | cancel-leaves=nothing -->
> 🚦 **Gate (intent · configure-env-variables:0.stale-plan):** Fail-closed entry gate when `check-alm-plan.js` returns `stale:true` (solution-modified-since-plan). Helper-script-backed.

`AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Refresh the plan first? | ALM plan freshness | Refresh — re-run /power-pages:plan-alm (Recommended), Continue with the existing plan, Cancel |

- **Refresh (Recommended)** → invoke `/power-pages:plan-alm`. After completion, re-run the Phase 0 helper once to confirm freshness; if still stale, surface the detail and proceed to Phase 1 anyway (don't infinite-loop).
- **Continue** → set `STALE_PLAN_ACK = true` and proceed to Phase 1.
- **Cancel** → exit cleanly.

**Why this gate exists.** Direct invocation of `configure-env-variables` creates env var definitions and a `deployment-settings.json` without the orchestrator's per-stage value gathering, site-setting classification (`keepAsIs` / `promoteToEnvVar` / `authNoValue` / `excluded`), and pipeline-strategy alignment. Users running this skill standalone often pick env var schema names that don't align with the plan's solution split, miss `authNoValue` settings that the plan classified for inclusion, or generate stage names that don't match the pipeline configured later by `setup-pipeline`. The gate ensures `plan-alm` either ran (so env var decisions are coherent with the rest of the deployment plan) or the user explicitly chose to bypass it.

## Phase 1 — Discover Existing State

Read project context and query Dataverse to understand what's already configured.

**1.1 Read project files:**
```bash
cat .solution-manifest.json          # get solutionUniqueName, environmentUrl, publisher.prefix
cat docs/alm/last-pipeline.json              # get hostEnvUrl, stages[].name
ls .powerpages-site/site-settings/   # list all site setting YAML files
```

**1.2 Acquire token and verify prerequisites:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-alm-prerequisites.js" \
  --envUrl "{devEnvUrl}" \
  --require-manifest
```
Capture output as JSON; extract `.envUrl` (store as `devEnvUrl`) and `.token` (store as `TOKEN`).

**1.3 Query existing env vars in the environment:**
```
GET {devEnvUrl}/api/data/v9.2/environmentvariabledefinitions?$select=schemaname,displayname,type,defaultvalue,environmentvariabledefinitionid&$orderby=schemaname
```

**1.4 Query site settings that already have env vars linked (`mspp_source = 1`):**
```
GET {devEnvUrl}/api/data/v9.2/mspp_sitesettings?$filter=mspp_source eq 1 and _mspp_websiteid_value eq {WEBSITE_ID}&$select=mspp_name,mspp_source,_mspp_environmentvariable_value,mspp_envvar_schema
```

Get `WEBSITE_ID` from `.powerpages-site/website.yml` → `id` field.

**1.5 Parse site setting YAML files** to list all settings and their current source:
- Files with `source: 1` are already env-var-backed
- Files with `source: 0` or no source field are static

Present a summary table to the user:
```
Current site settings (static):   48
Already env-var-backed:             3
Existing env var definitions:       2
```

## Phase 2 — Select Site Settings and Plan Env Vars

Ask the user which site settings should be backed by environment variables. Present the list of static site settings as candidates. Recommend settings that are likely to vary per environment:

**Common candidates:**
- `Authentication/OpenIdConnect/AzureAD/ClientId` — Entra ID app registration differs per env
- `Authentication/OpenAuth/Microsoft/ClientId` — OAuth app ID
- `Authentication/OpenAuth/Microsoft/ClientSecret` — OAuth secret (use Secret type)
- `Authentication/Registration/LocalLoginEnabled` — may differ in dev vs prod
- Any `Authentication/Registration/OpenRegistrationEnabled` — open sign-up policy
- Custom site settings the user has added

<!-- gate: configure-env-variables:2.selection | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · configure-env-variables:2.selection):** User picks which site settings get promoted to env vars. Multi-select. Cancel exits before any env var definitions are created.

Ask via `AskUserQuestion`:
> "Which site settings should be backed by environment variables? I'll create an env var for each and guide you through linking them.
>
> Here are the candidates (enter numbers, comma-separated):
> 1. Authentication/Registration/LocalLoginEnabled (currently: true)
> 2. Authentication/OpenIdConnect/AzureAD/ClientId (currently: empty)
> 3. [other settings...]
> N. I'll type my own setting names"

For each selected setting, ask for:
1. **Env var schema name** — generate via `${CLAUDE_PLUGIN_ROOT}/scripts/lib/generate-env-var-schema-name.js` (single source of truth shared with `setup-solution`):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/generate-env-var-schema-name.js" \
     --publisherPrefix "{publisherPrefix}" --settingName "{settingName}"
   ```
   Output: `{ schemaName, sanitized }`. The canonical rule is `{prefix}_{settingName.replace(/[^A-Za-z0-9]+/g,'_').toLowerCase()}` — e.g. `Authentication/Registration/LocalLoginEnabled` becomes `ids_authentication_registration_localloginenabled`. Do NOT inline a custom rule here: setup-solution emits schema names from this helper, and configure-env-variables MUST match what setup-solution already created (otherwise the link to the existing site setting fails). The user can override the suggestion if they have a reason, but the default must come from the helper.
2. **Display name** (human-readable)
3. **Type**: String (default), Boolean, Number, Secret
4. **Dev/source value** (default = current `mspp_value` from YAML)
5. **Per-stage values** — for each stage in `docs/alm/last-pipeline.json`, what should the value be?

Example:
```
Setting: Authentication/Registration/LocalLoginEnabled
  Schema name: ids_authentication_registration_localloginenabled
  Display name: IdeaSphere Local Login Enabled
  Type: String (site settings always resolve as strings)
  Dev value: true
  Staging value: false
  Production value: false
```

## Phase 3 — Create Environment Variable Definitions

For each planned env var, branch on `typeCode`:

> **`{displayName}` substitution rule — pick a human-readable label, not the schema name.** The Dataverse `displayname` column on `environmentvariabledefinition` is what shows up in PPAC, in the rendered ALM plan's Env Variables tab, and in `last-env-vars.json`. If you substitute the schema name (e.g. `c311_api_secret`) into `--displayName`, the plan and PPAC both read like raw tokens. Pick the friendly label from the source site setting (e.g. `API Secret` from `c311/api_secret`'s `Description` or its human-readable title in the planData). When no friendly label exists, derive one from the schema name by title-casing the prefix-stripped tail (e.g. `c311_api_secret` → `Api Secret` → manually clean up to `API Secret`). Keep `displayName` and `schemaName` deliberately different — they have different audiences.

### 3.A — String env vars (`typeCode = 100000000`)

Definition-only flow — per-stage values come later from `deployment-settings.json` via `deploymentsettingsjson` PATCH at deploy time.

**3.A.1 Check and create if needed** using `create-env-var-definition.js` (the script checks for an existing definition by `schemaName` before posting):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/create-env-var-definition.js" \
  --envUrl "{devEnvUrl}" \
  --token "{TOKEN}" \
  --schemaName "{schemaName}" \
  --displayName "{displayName}" \
  --type 100000000 \
  --defaultValue "{devValue}"
```

Capture output as JSON; extract `.definitionId` (store as `envVarDefId`) and check `.created` (true = newly created, false = already existed). If already existed, confirm the existing definition matches expectations before proceeding.

**3.A.2 Create the current-environment value** (the live dev value, separate from defaultvalue):
```
POST {devEnvUrl}/api/data/v9.2/environmentvariablevalues
Content-Type: application/json

{
  "EnvironmentVariableDefinitionId@odata.bind": "/environmentvariabledefinitions({envVarDefId})",
  "value": "true"
}
```

Response: **HTTP 204**.

### 3.B — Secret env vars (`typeCode = 100000005`) when a Key Vault Secret URI is available

#### Acceptable Secret reference formats

Dataverse / the Power Platform Pipelines handler accept exactly three formats for a Secret-type env var value. Anything else is rejected at import time with *"ImportAsHolding failed: The value provided as a secret reference does not match a valid secret reference format"* — and the rejection can come hours after the deploy queues, since the host serializes imports. The pre-deploy validator (`deploy-pipeline` Phase 5.1b, helper at `scripts/lib/validate-deployment-settings.js`) catches these formats upfront, but they're documented here so SKILL.md authors writing to `deployment-settings.json` use the right shape from the start.

**Accepted:**

1. **Key Vault Secret Identifier URI** — what `store-keyvault-secret.js` emits in its `secretUri` output:
   ```
   https://<vault>.vault.azure.net/secrets/<name>
   https://<vault>.vault.azure.net/secrets/<name>/<32-char-hex-version>
   ```
   Vault name must be 3–24 chars, lowercase alphanumeric + hyphens, start with a letter, end with a letter or digit. This is the canonical form and the one `add-server-logic` Phase 7.2a hands back via the user-visible "share the secretUri output" step.

2. **Azure resource ID** — the full ARM-style path, when the maker doesn't have the URI form handy:
   ```
   /subscriptions/<subscriptionId>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault>/secrets/<name>
   ```
   Both `resourceGroups` and `resourcegroups` casings are accepted by Dataverse.

3. **Empty string `""`** — legitimate when the env var has a sensible default-value baked into the definition. Per-stage `Value: ""` in `deployment-settings.json` means *"use the definition default in this stage."*

**Rejected (validator flags these):**

- `@KeyVault(vaultName=<vault>;secretName=<name>)` — a templating-style placeholder. **NOT recognized by Dataverse.** Real-world failure case from a live session: this exact pattern caused a 4h41m queue wait + ImportAsHolding failure. Replace with form (1) or (2).
- `<TODO>`, `<KEY_VAULT_URI>`, `<PLACEHOLDER>`, `${ENV_VAR}` — any angle-bracketed or shell-style placeholder. Same story; these are maker conventions Dataverse does not parse.
- Plain-text secret values — both insecure (the file is committed to git) AND rejected by Dataverse when the env var type is Secret. If the maker intended plain text, the env var type should be String (`100000000`), not Secret (`100000005`).
- HTTPS URLs that look like Key Vault URIs but miss the canonical shape (`.com` host suffix instead of `.net`, missing `/secrets/` segment, short version suffix). The validator flags these specifically as `invalid-uri` so the maker can fix the typo rather than re-coining the value.

#### Implementation

When the user has already stored the secret in Azure Key Vault and has a Secret Identifier URI in canonical form, use the atomic deep-insert path — the same flow `add-server-logic` Phase 7.2a uses:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-environment-variable.js" "{devEnvUrl}" \
  --schemaName "{schemaName}" \
  --displayName "{displayName}" \
  --type secret \
  --value "{secretUri}"
```

This script POSTs a single deep-insert that creates the `environmentvariabledefinition` (type 100000005) AND the `environmentvariablevalues` row with the Key Vault URI in `value` — Dataverse resolves the secret at runtime by dereferencing the URI. The script is ALM-aware and adds the new definition to the target solution via `AddSolutionComponent` (same `resolve-target-solution.js` resolution order as the rest of the family).

> **Cross-reference: see `${CLAUDE_PLUGIN_ROOT}/skills/add-server-logic/SKILL.md` Phase 7.2a** for the full Key Vault end-to-end: vault selection (`list-azure-keyvaults.js` / `create-azure-keyvault.js`), secret storage (`store-keyvault-secret.js` with stdin to keep the secret out of the conversation), and the URI handoff back to env-var creation. The implementation is identical; we re-use the same helper scripts.

### 3.C — Secret env vars without a Key Vault URI (legacy / deferred)

When the user has not chosen Key Vault yet or hasn't stored the secret, create the definition with an empty value placeholder and instruct the user to wire the value via Power Platform Admin Center after import:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/create-env-var-definition.js" \
  --envUrl "{devEnvUrl}" \
  --token "{TOKEN}" \
  --schemaName "{schemaName}" \
  --displayName "{displayName}" \
  --type 100000005
```

(omit `--defaultValue` — Dataverse stores Secret-type definitions with no default until a `environmentvariablevalues` row is added). Tell the user the value must be set per target environment via PPAC → Solutions → Environment Variables → select → set value. This path is the legacy fallback; the dedicated `configure-secrets` skill (queued for a follow-up PR) will eventually orchestrate 3.B for credential-style settings end-to-end.

### Type-code reference

- `100000000` = String — flows via path 3.A.
- `100000005` = Secret — flows via path 3.B (preferred when Key Vault URI is available) or 3.C (deferred / legacy).

Other canonical types (`100000001` Number, `100000002` Boolean, `100000003` JSON, `100000004` DataSource) follow path 3.A with the appropriate `--type` code.

Track created env var IDs: `{ schemaName, envVarDefId, siteSettingName, devValue, stageValues: { stageName: value } }`.

## Phase 4 — Link Site Settings to Env Vars

For each site setting to link, run `link-site-setting-to-env-var.js` (HAR-confirmed PATCH via v9.0 API — no UI step required):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/link-site-setting-to-env-var.js" \
  --envUrl "{devEnvUrl}" \
  --token "{TOKEN}" \
  --siteSettingId "{siteSettingId}" \
  --definitionId "{envVarDefId}" \
  --schemaName "{schemaName}"
```
Capture output as JSON; check `.ok` and `.verified` are both `true`. The script applies the PATCH with the required `if-match: *` and `clienthost: Browser` headers and then verifies `mspp_source === 1` and `_mspp_environmentvariable_value` matches the definition ID.

If `.ok` is `false` or `.verified` is `false`, report the error and ask the user:
> "Linking `{settingName}` to env var `{schemaName}` failed. How would you like to proceed?
> 1. Retry
> 2. Skip this setting — keep it as static
> 3. Cancel"

## Phase 5 — Add Env Vars to Solution

For each env var definition, add it to the solution:

```
POST {devEnvUrl}/api/data/v9.2/AddSolutionComponent
Content-Type: application/json

{
  "ComponentId": "{envVarDefId}",
  "ComponentType": 380,
  "SolutionUniqueName": "IdeaSphereSolution",
  "AddRequiredComponents": false,
  "DoNotIncludeSubcomponents": false
}
```

Response: **HTTP 200** with `{ "id": "..." }`.

> **Note**: Do NOT add `environmentvariablevalues` records to the solution — those are environment-specific and must stay local to each environment. Only the definition (type 380) goes in the solution.

Verify the env var appears in solution components:
```
GET {devEnvUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq {solutionId} and componenttype eq 380&$select=objectid
```

## Phase 6 — Generate deployment-settings.json

Write `deployment-settings.json` to the project root. This file stores per-stage environment variable override values and is read by `deploy-pipeline`.

```json
{
  "$schema": "https://schemas.microsoft.com/power-platform/deployment-settings/2024",
  "description": "Per-stage environment variable values for IdeaSphereSolution pipeline deployments. Commit this file. Do not store secrets here — use Secret type env vars backed by Key Vault instead.",
  "stages": {
    "Deploy to Staging": {
      "EnvironmentVariables": [
        {
          "SchemaName": "ids_LocalLoginEnabled",
          "Value": "false"
        }
      ],
      "ConnectionReferences": []
    }
  }
}
```

Stage names must match exactly the `stages[].name` values in `docs/alm/last-pipeline.json`.

For Secret-type env vars: write `"Value": ""` and add a comment instructing the user to populate via Azure Key Vault or pipeline secrets — never store raw secrets in this file.

### Phase 6.1 — Pre-write validation (REQUIRED, do not skip)

Before persisting `deployment-settings.json` to disk, validate every entry against the canonical Secret-reference formats. The Power Platform Pipelines handler validates the `deploymentsettingsjson` PATCH at import time — after the stage run has been queued for potentially hours behind serialized imports. A bad value here (e.g. the templating-style `@KeyVault(vaultName=...;secretName=...)` placeholder, raw secret content, malformed URI) fails the import with *"ImportAsHolding failed: The value provided as a secret reference does not match a valid secret reference format"* — and the user only finds out hours later. Live evidence (2026-05-21 Citizens portal deploy): a `@KeyVault(...)` placeholder in `deployment-settings.json` shipped to the host, queued behind other imports, then rejected after a 4h41m wait.

Catching invalid values **at write time** is the difference between a sub-second hard stop and a hours-long blind alley.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/validate-deployment-settings.js" \
  --settingsFile "./deployment-settings.json" \
  --envUrl "{devEnvUrl}" \
  --token "{token}"
```

The helper reads the file you just wrote, classifies each `EnvironmentVariables[]` entry by `valueFormat` (`kv-uri` / `kv-resource-id` / `kv-placeholder` / `empty` / `plain-text` / `invalid-uri`), cross-checks Secret-type entries against the Dataverse type lookup when `--envUrl` is provided, and emits `{ summary: { valid, invalid, "unknown-type", skipped }, findings[] }`. Branch on `summary.invalid`:

- **`summary.invalid === 0`** → proceed to Phase 7.
- **`summary.invalid > 0`** → STOP. Surface each invalid `findings[]` entry to the user with its `schemaName`, `valueFormat`, `value`, and `message`. Common offenders:
  - `@KeyVault(vaultName=...;secretName=...)` → `kv-placeholder` (a templating-style format never recognized by Dataverse). Fix: replace with the Key Vault Secret Identifier URI `https://<vault>.vault.azure.net/secrets/<name>[/<version>]` or the full Azure resource ID `/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.KeyVault/vaults/<vault>/secrets/<name>`, or use an empty string to fall back to the env var definition's default.
  - Raw secret content (any plain string that doesn't match a URI or resource-ID pattern) → `plain-text`. Fix: never commit raw secrets — switch to a Key Vault URI/resource ID, or use empty string + populate per-stage via pipeline secrets.
  - Malformed URI → `invalid-uri`. Fix: re-check the format against the canonical patterns above.

Re-run validation after the user supplies corrected values. Only proceed to Phase 7 when `summary.invalid === 0`.

<!-- gate: configure-env-variables:6.1.invalid-secret-values | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · configure-env-variables:6.1.invalid-secret-values):** Pre-write validation found Secret references in invalid formats. Refuse to ship the file with these values — fix or abort. Caller cannot bypass: every recorded invalid value would fail import.

> **Why this gate is hard-stop, not "proceed anyway"**: there's no value to "force-write" a known-bad Secret reference. The Pipelines handler will reject it deterministically at import time. Writing it anyway only wastes the queue wait. If the user genuinely doesn't have a canonical Key Vault URI yet, the correct path is to leave `Value: ""` (definition default) and circle back when the secret reference is ready.

## Phase 7 — Verify and Commit

**7.1 Sync site settings YAML** — run `pac pages upload-code-site` to push the updated site settings (with `source: 1` now visible in Dataverse) back to the YAML:
```bash
pac pages upload-code-site --rootPath "." --environment {devEnvUrl}
```

After upload, check the updated YAML file — it should now contain `source: 1` and reference the env var schema name.

**7.2 Verify solution contains env var:**
```
GET {devEnvUrl}/api/data/v9.2/solutioncomponents?$filter=_solutionid_value eq {solutionId} and componenttype eq 380
```

**7.2b Verify values landed on dev env.** After creating the definitions + values, query the dev env to confirm each `environmentvariablevalues` row exists. The shared helper `scripts/lib/verify-env-var-values.js` does this read-only check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/verify-env-var-values.js" \
  --envUrl "{devEnvUrl}" \
  --schemaNames "{comma-separated schema names just created}"
```

Capture stdout as JSON. If `summary.landed === summary.total`, the local definition+value chain is healthy and `deploy-pipeline` Phase 5.2's `deploymentsettingsjson` PATCH will have what it needs. If `summary.missing > 0`, log a one-line warning and recommend re-running configure-env-variables — most likely cause is a transient OData write failure that left a definition without its paired value. The same helper runs at deploy time (deploy-pipeline Phase 7.6.5) against the target env; centralizing the check keeps the diagnostic shape consistent across the dev-side write and the target-side landing.

**7.2b.bump Bump source solution version + manifest sync.** Creating new env var definitions and adding them to the solution via `AddSolutionComponent` modifies `solutions.modifiedon`. Bump the patch segment so downstream skills see a strictly-increasing version label AND the local `.solution-manifest.json` tracks the change:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/bump-solution-version.js" \
  --envUrl "{devEnvUrl}" \
  --token "{token}" \
  --uniqueName "{solutionUniqueName}" \
  --projectRoot "."
```

The helper returns `{ previous, next, bumped: true, manifestUpdated, manifestUpdateReason }`. `--projectRoot "."` makes it update `.solution-manifest.json`'s `solution.version` (or matching `solutions[].version` in multi-solution mode) atomically. Without this bump, `.solution-manifest.json` drifts behind Dataverse — validated against a real Citizens portal run where the manifest sat at 1.0.0.2 while Dataverse had reached 1.0.0.4 after configure-env-variables and deploy-pipeline had each touched the source.

**7.2c Refresh the post-config env var snapshot.** Re-run the discovery helper to write `docs/alm/last-env-vars.json` with the freshly-created definitions. Without this, the rendered ALM plan's Env Variables tab stays at whatever setup-solution last wrote — newly-created definitions don't appear until plan-alm runs again. The refresh helper invoked at the end of this phase ingests this sidecar into `planData.envVars[]` AND mirrors it over to `docs/alm/alm-env-vars.json` so both snapshots stay current:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/discover-env-var-definitions.js" \
  --envUrl "{devEnvUrl}" \
  --publisherPrefix "{publisherPrefix}" \
  --websiteRecordId "{websiteRecordId}" \
  --token "{token}" \
  --solutionId "{solutionId}" > docs/alm/last-env-vars.json.tmp \
  && mv docs/alm/last-env-vars.json.tmp docs/alm/last-env-vars.json
```

The tmp-file write pattern preserves a prior good snapshot if discovery fails transiently. Pass `--solutionId` so the result is scoped to the target solution — without it, a generic publisher prefix would return env vars from unrelated projects in the same tenant.

**7.3 Commit:**
```bash
git add .powerpages-site/site-settings/ deployment-settings.json
git commit -m "Configure env vars: {list of schema names} — link {setting names} to env vars for ALM"
```

**7.4 Present summary:**

```
✅ Environment variables configured

Env vars created/confirmed:
  ids_LocalLoginEnabled → Authentication/Registration/LocalLoginEnabled
    Dev value: true
    Staging: false

Added to solution: IdeaSphereSolution (1 env var component)

deployment-settings.json written with:
  Stage "Deploy to Staging": ids_LocalLoginEnabled = false

Next steps:
  1. Run /power-pages:export-solution to export the updated solution
  2. Run /power-pages:deploy-pipeline — it will automatically read deployment-settings.json
     and inject the env var values during deployment
  3. After deployment, verify in staging: the Sign In button should be hidden
     (Authentication/Registration/LocalLoginEnabled = false)
```

**7.5 Record skill usage:**

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "ConfigureEnvVariables"`.

**7.5b Refresh the ALM plan (if one exists):**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/refresh-alm-plan-data.js" \
  --projectRoot "." \
  --phase configure-env-variables \
  --render
```

The helper re-reads `docs/alm/last-env-vars.json` so newly-created definitions appear in `planData.envVars[]`, backfills per-stage values from `deployment-settings.json` into the "Values by Environment" matrix, zeroes `plannedEnvVarCount`, stamps `LAST_SYNC_AT`, and re-renders `docs/alm-plan.html`. When `docs/.alm-plan-data.json` is absent (standalone invocation, not part of an ALM plan), the helper returns `ok:false` as a soft no-op — safe to run unconditionally.

**Point the user at the next step (user-driven sequencing).** The helper's stdout JSON includes `nextStep: { name, skill: string | null } | null`. When non-null, branch on `skill`: when `skill` is non-null, tell the user *"Plan updated. Next in your plan: **{nextStep.name}** → run `{nextStep.skill}` when you're ready."*; when `skill` is `null` (an internal step such as Finalize, no user command), name the step only — *"Plan updated. Next in your plan: **{nextStep.name}**."* — and never print `run null`. When `null` or the helper returned `ok:false`, say nothing about a next step. **Never auto-invoke the next skill** — the user drives execution.

## Key Decision Points (Wait for User)

| Phase | Decision | Options |
|---|---|---|
| Phase 2 | Which site settings to back with env vars | Select from list |
| Phase 2 | Env var schema names, types, per-stage values | Enter for each |
| Phase 4 | Retry / skip / cancel on link failure | Retry / Skip / Cancel |
| Phase 7 | Review commit and next steps | Proceed / Adjust |

## Task Progress Table

| Task subject | activeForm | Description |
|---|---|---|
| Discover existing state | Discovering existing state | Read manifests, query Dataverse for existing env vars and already-linked site settings, list candidates |
| Plan environment variables | Planning environment variables | Ask user which site settings to back, collect schema names, types, dev and per-stage values |
| Create env var definitions | Creating env var definitions | POST environmentvariabledefinitions + environmentvariablevalues for each planned env var |
| Link site settings to env vars | Linking site settings | Run link-site-setting-to-env-var.js for each setting; verify .ok and .verified from output |
| Add env vars to solution | Adding env vars to solution | AddSolutionComponent (type 380) for each env var definition |
| Generate deployment-settings.json | Generating deployment settings | Write deployment-settings.json with per-stage env var values |
| Verify and commit | Verifying and committing | Sync YAML, verify solution components, commit, present summary |
