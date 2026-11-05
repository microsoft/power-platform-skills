## Phase 4: Review and Approve Provisioning

Show:

```text
Site type: Non-SPA Power Pages site
Data model: <MODEL_VERSION>
Bootstrap target: <BOOTSTRAP_VERSION> (verified after download)
Toggle confirmation: Switch to enhanced data model is enabled
Environment URL: <environmentUrl>
Environment ID: <environmentId>
Template: <template display name> (<templateName>)
Template requirements: <requirements, or "None listed">
Template role: Data/domain and requirements reference; final visual design is customizable
Template catalog revision: <owner/repo>@<commitSha> (<releaseName or resolvedRef>)
Site name: <siteName>
Base language: <SELECTED_BASE_LANGUAGE_SOURCE> (LCID <SELECTED_BASE_LANGUAGE>)
Subdomain: <subdomain>
Website record ID: Assigned by Power Pages during provisioning
Download destination: <resolved path>
```

<!-- gate: create-site:non-spa-4-provision | category=final | cancel-leaves=nothing -->

> 🚦 **Gate (final · create-site:non-spa-4-provision):** Final consent immediately before the Create
> Website API call.
>
> **Trigger:** All cloud and local parameters have been validated.
> **Why we ask:** The next action creates a real Power Pages resource in the confirmed environment.
> **Cancel leaves:** Nothing — no API call has been made.

Ask the user:

**Create this site and download it?** Options: **Create site**, **Change settings**, **Cancel**.

## Phase 5: Provision the Site

Before submitting the request, generate the browser status page:

```bash
node "${PLUGIN_ROOT}/skills/create-site/scripts/render-non-spa-status.js" --templateName "<templateName>" --catalogOwner "<CATALOG_OWNER>" --catalogRepo "<CATALOG_REPO>" --catalogSha "<CATALOG_SHA>" --modelVersion "<MODEL_VERSION>" --status "provisioning" --siteName "<siteName>" --subdomain "<subdomain>" --cloud "<cloud>" --language "<SELECTED_BASE_LANGUAGE>" --languageName "<BASE_LANGUAGE_NAME>" --languageCode "<BASE_LANGUAGE_CODE>"
```

Store the returned `output` as `STATUS_PAGE_PATH` and `url` as `STATUS_PAGE_URL`. The renderer
uses a stable OS temporary path derived from the validated subdomain, reloads the selected template
from the exact catalog SHA, securely caches and embeds its responsive preview images, and overwrites
the same file as the workflow advances. Catalog or preview failures are explicit; do not fall back
to plugin-owned template metadata or images.

Open `STATUS_PAGE_PATH` in the user's default browser using the OS-native launcher pattern from
`plan-alm`: `Start-Process` on Windows, `open` on macOS, or `xdg-open` on Linux. Print
`STATUS_PAGE_URL` before launching so the user has a direct fallback. Do not block provisioning if
the browser launcher fails.

### Status-page activity transitions

After the status page exists, keep its activity state aligned with the agent:

- Normal processing uses the lifecycle `--status` alone; nonterminal phases default to the
  animated `working` state.
- Every rewrite includes the original `--catalogOwner`, `--catalogRepo`, and `--catalogSha`, plus
  the resolved `--cloud`, `--language`, `--languageName`, and `--languageCode`. Never replace the
  pinned SHA with a release name, branch, or `latest-release`. The cloud value ensures the
  pre-registration URL uses the correct sovereign-cloud site domain.
- Immediately before any user question, rewrite the same page with the current lifecycle
  status plus `--activityState "awaiting-input"`, `--requiredAction "<specific action>"`, and
  `--responseLocation "Return to the site creation conversation and provide your response."`
  The page continues its silent reload so it can notice the next rewrite, but the current step
  must not animate or look like background work continues.
- Immediately after the user responds, rewrite the same lifecycle status without
  `--activityState`; this clears the notification and restores normal processing. Do this before
  starting the next command.
- If the user cancels after the page exists, rewrite the current lifecycle status with
  `--activityState "canceled"`, `--terminalReason "<safe plain-text explanation>"`, and
  `--nextAction "<specific recovery or preservation guidance>"`. The exception is `ready`: site
  creation is already complete, so declining or canceling optional customization must rewrite
  `ready` without an activity override.
- If creation cannot continue, rewrite the current lifecycle status with
  `--activityState "failed"`, `--terminalReason "<safe plain-text failure summary>"`, and
  `--nextAction "<specific recovery guidance>"` unless a more specific terminal status such as
  `model-mismatch` applies. Summarize the reason for the user; do not pass tokens, raw command
  output, environment identifiers, local paths, or other sensitive details.

Queued steps remain `Waiting`; only the current blocked step is labeled `Your input needed`.
Never show percentages, estimated completion times, or a working indicator while awaiting input.

Run the shared provisioner:

```bash
node "${PLUGIN_ROOT}/skills/activate-site/scripts/activate-site.js" --siteName "<siteName>" --subdomain "<subdomain>" --organizationId "<organizationId>" --environmentId "<environmentId>" --cloud "<cloud>" --templateName "<templateName>" --selectedBaseLanguage "<SELECTED_BASE_LANGUAGE>"
```

The documented Create Website request has no model or Bootstrap-version field. `MODEL_VERSION` is enforced by the
administrator-confirmed environment toggle and the mandatory PAC verification before download,
not by adding an undocumented request property. See:
https://learn.microsoft.com/rest/api/power-platform/powerpages/websites/create-website

Use a command timeout of at least six minutes.

- `Succeeded`: store the service-assigned `websiteRecordId` as `WEBSITE_RECORD_ID`, then continue.
- `Running`: preserve `operationLocation` and all submitted parameters. Do not
  POST again. Resume with the same command and append:

  ```bash
  --operationLocation "<saved operationLocation>"
  ```
- `Failed` before acceptance: render the current step with `--activityState "failed"`, show the
  service error, and allow parameter correction where relevant. If asking whether to correct and
  retry, first use the awaiting-input transition above; restore `working` before the retry.
- `401`/`403`: repair authentication or permissions, then retry only when the response proves the
  request was not accepted. Render awaiting-input before asking the user to complete an
  authentication or permission action.
- Template unavailable: return to Phase 2; never substitute a template automatically.

If status-page rendering fails before submission, repair it before the POST. If an update fails
after the request was accepted, report the status-page error but continue polling the accepted
operation; a presentation failure must never cause a second creation POST.

### Record only an observed terminal creation failure

For any phase after template selection **before baseline success**, emit the following once only when an
observed error ends this creation attempt, after applicable retries/repair have ended:

```bash
node "${PLUGIN_ROOT}/scripts/emit-non-spa-creation-telemetry.js" --eventName non_spa_creation_failure --correlationId "<CREATION_CORRELATION_ID>" --errorClass "<errorClass>"
```

Use only these fixed classes: `Configuration` (invalid creation settings), `Authentication`
(unresolved authentication/permission rejection), `TemplateCatalog` (selected template unavailable),
`Provisioning` (terminal API failure), `ModelVerification` (identity/model cannot be verified),
`Download` (download exhausted), `Validation` (downloaded identity/assets/Bootstrap or final
validator fails), `GitBaseline` (Git initialization/commit fails), or `Unknown` (other observed
terminal creation error). Never pass error messages, CLI output, names, URLs, paths, or IDs.

Do **not** emit failure for Cancel, awaiting input, `Running`/accepted operations, a polling timeout
with an unresolved operation, recoverable retries, an interrupted session, or a status-page-only
error while creation continues. An unknown result stays unknown. Do not use status-renderer calls
or host hooks as success/failure evidence, and do not count later customization/deployment errors
as creation failures. If recording fails, report the original creation error, not a telemetry error.
