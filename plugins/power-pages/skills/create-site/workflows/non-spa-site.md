# Create a Non-SPA Power Pages Site

Follow this workflow only after `create-site` routes the request to an Enhanced data model
non-SPA site. The platform creates the baseline from a documented first-party template;
the skill downloads that baseline rather than generating Power Pages metadata.
Use the selected template for data-model/domain context and requirements interpretation only,
not as a constraint on visual design, page composition, layout, branding, or modern presentation.
Custom design and layout are required on the customization path, not an optional enhancement.
Reuse needed native forms, lists, content snippets and other components inside that custom
composition; do not deliver the starter layout with only different content, imagery or colors.
Unneeded starter sections and component placements may be removed for the fresh composition;
preserve required functionality and explicit user exceptions, not everything the template contains.
Then coordinate a polished, image-rich design through the existing customization and styling
owners, unless the user explicitly chooses to keep the bare template.
Use approved direct HTTPS image URLs for image additions, not downloaded/imported Web Files.
Existing template images may be reused without creating new files.

## Preview disclosure

Read `${PLUGIN_ROOT}/references/non-spa-preview.md`. Before prerequisite checks, task creation,
environment discovery, or the first non-SPA question, present the **Creation notice** from
that reference. This is informational, not an additional approval gate. After presenting it,
carry `previewNoticeShown: true` through this workflow and every covered-skill handoff.

## Invariants

- New non-SPA site creation supports only **Enhanced with Bootstrap 5**. After confirmation, set
  `MODEL_VERSION=Enhanced` and `BOOTSTRAP_VERSION=5`; never offer or create a Standard baseline.
- An explicit Standard/SDM creation request is not consent to create Enhanced. Explain the
  creation limitation and let the user choose Enhanced non-SPA creation, the SPA route, or cancel.
- Bootstrap 5 creation requires Enhanced and a documented supported template. Follow
  [Microsoft's Bootstrap 5 creation guidance](https://learn.microsoft.com/power-pages/configure/bootstrap-version-5).
  Verify the actual downloaded Bootstrap assets before version-specific authoring.
- The environment EDM toggle has no documented public read or write API.
- An environment administrator must verify **Switch to enhanced data model** is enabled. The
  skill never automates that shared environment change.
- Non-SPA template discovery uses the release-pinned
  `microsoft/power-pages-samples` manifest. It is not presented as an environment-specific
  catalog because no public API reports which templates are enabled in a specific environment.
- Resolve the samples release to one immutable commit SHA per run. Fail clearly when the catalog
  is unavailable or malformed; never substitute a bundled or stale non-SPA catalog.
- Do not submit `websiteRecordId` for a new non-SPA site. The platform creates the Dataverse website
  record and returns or exposes its ID after provisioning.
- Never retry a Create Website POST after `202 Accepted`. Poll or resume the accepted operation.
- Verify PAC reports `MODEL_VERSION`, then download with `--modelVersion "<MODEL_VERSION>"`
  explicitly.
- Pass `--modelVersion "<MODEL_VERSION>"` to every status-page render.
- Do not invoke `activate-site` or show a deploy-now prompt after creation. The Create Website API
  already provisions the cloud site.
- No dev server, live preview, generated styling mockup, or browser inspection is required.
  The existing provisioning-status and customization-approval HTML documents are not live previews.

## Progress Tracking

Create all eight tasks before starting:

| Task subject | Active form | Description |
|---|---|---|
| Verify non-SPA site prerequisites | Verifying non-SPA site prerequisites | Select the model and verify tools, authentication, environment identity, and administrator confirmation |
| Select a non-SPA template | Selecting a non-SPA template | Load the supported templates and select one |
| Configure the non-SPA site | Configuring the non-SPA site | Gather name, language, subdomain, and destination |
| Approve non-SPA site provisioning | Reviewing non-SPA site provisioning | Present the complete cloud and local plan for final consent |
| Provision the non-SPA site | Provisioning the non-SPA site | Create the website and poll the accepted operation |
| Download the non-SPA site | Downloading the non-SPA site | Verify and download explicitly with the selected model |
| Validate the non-SPA baseline | Validating the non-SPA baseline | Validate downloaded artifacts and initialize Git |
| Complete non-SPA site setup | Completing non-SPA site setup | Present the baseline and continue into approved image-rich design unless the user opts out |

## Phase 1: Confirm the Model and Verify Prerequisites

1. Always confirm the Enhanced-only creation model before continuing. If the request explicitly
   asks for Standard/SDM, first explain that new non-SPA creation does not support Standard; do
   not silently reinterpret the request as Enhanced.

   <!-- gate: create-site:non-spa-1-select-model | category=plan | cancel-leaves=nothing -->

   > 🚦 **Gate (plan · create-site:non-spa-1-select-model):** Confirm the supported Enhanced data
   > model and Bootstrap 5 creation path.
   >
   > **Trigger:** The request selected non-SPA creation.
   > **Why we ask:** New non-SPA creation is Enhanced-only, and the Create Website request relies
   > on an environment-level toggle rather than carrying a model field.
   > **Cancel leaves:** Nothing — no cloud resource or local project exists.

   | Question | Header | Options |
   |---|---|---|
   | New non-SPA site creation uses the Enhanced data model with Bootstrap 5. Continue? | Data model | Continue with Enhanced (Recommended), Create an SPA site instead, Cancel |

   On **Continue with Enhanced**, set `MODEL_VERSION=Enhanced` and `BOOTSTRAP_VERSION=5`. On
   **Create an SPA site instead**, return to the parent SPA workflow before creating any non-SPA
   task or resource. Explain the Bootstrap 5 prerequisites. An explicit Standard request is not
   consent to migrate, change the environment toggle, or create an Enhanced site.

2. Run the plugin version check from the parent skill.
3. Verify:

   ```bash
   pac help
   pac pages help
   az account show
   ```

4. Resolve the current environment:

   ```bash
   node "${PLUGIN_ROOT}/skills/create-site/scripts/resolve-non-spa-context.js"
   ```

   The helper returns only non-secret context: environment URL, environment ID, Dataverse
   organization ID, organization base-language LCID and display metadata, and cloud. Store
   `organizationBaseLanguageLcid` as `BASE_LANGUAGE_LCID`, plus
   `organizationBaseLanguage.name` as `BASE_LANGUAGE_NAME` and
   `organizationBaseLanguage.code` as `BASE_LANGUAGE_CODE`. The helper reads the authoritative
   Dataverse organization language and its active LanguageLocale row, and fails explicitly rather
   than assuming English or displaying a raw LCID. If authentication is missing, guide the user
   through `pac auth create` or `az login`, then retry.

<!-- gate: create-site:non-spa-1-confirm-environment | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · create-site:non-spa-1-confirm-environment):** Confirm the exact environment
> before template selection and provisioning.
>
> **Trigger:** Non-SPA creation context resolved.
> **Why we ask:** Creating in the wrong environment leaves a real shared cloud resource.
> **Cancel leaves:** Nothing — no site or local project exists.

5. Show the environment URL and ID, then ask whether to use this environment. If the user chooses
   another environment, select/authenticate it and rerun the context helper before asking again.

6. Run:

   ```bash
   node "${PLUGIN_ROOT}/skills/create-site/scripts/list-site-templates.js" \
     --modelVersion "<MODEL_VERSION>" --bootstrapVersion "<BOOTSTRAP_VERSION>"
   ```

   The expected capability status is `indeterminate` because no documented API reads the toggle.

<!-- gate: create-site:non-spa-1-confirm-capability | category=progress | cancel-leaves=nothing -->

> 🚦 **Gate (progress · create-site:non-spa-1-confirm-capability):** Require administrator
> confirmation that **Switch to enhanced data model** is enabled.
>
> **Trigger:** Public API capability result is `indeterminate`.
> **Why we ask:** Existing sites and Dataverse tables do not prove the environment toggle state
> that controls which model a newly created site will use.
> **Cancel leaves:** Nothing — no site or local project exists.

7. Explain how to verify the toggle in Power Platform admin center. Open the direct environment
   URL below. Open the direct settings URL and ask the administrator to check whether **Switch to Enhanced Data Model** is on:

   `https://admin.powerplatform.microsoft.com/manage/environments/<org-id>/<env-name>/portals?geo=<env-geo>`

   Replace the placeholders with the resolved environment organization ID, name, and geo.

   | Question | Header | Options |
   |---|---|---|
   | Has an environment administrator verified that **Switch to Enhanced Data Model** is on for this environment? | EDM availability | Yes, it is enabled, Open the direct environment settings, Choose another environment, Cancel |

8. On **Open the direct environment settings**, open the URL above, wait for the user to verify or
   change the setting, and ask again. On **Choose another environment**, return to step 5.
   Never toggle the setting through browser automation.
9. After confirmation, rerun:

   ```bash
   node "${PLUGIN_ROOT}/skills/create-site/scripts/list-site-templates.js" \
     --modelVersion "<MODEL_VERSION>" --bootstrapVersion "<BOOTSTRAP_VERSION>" --administratorConfirmed
   ```

## Phase 2: Select a Documented Template

Present the returned templates with the disclosure:

> These templates come from the published Power Pages samples catalog. Microsoft does not publish
> an environment-specific template-catalog API, so this may not include every template shown in
> Power Pages design studio.

Explain that selection determines the provisioned baseline and informs the site's domain/data
requirements, not its final appearance. Template previews and starter layouts are references,
not a visual commitment. Carry forward genuinely requested capabilities and content; customization
may recompose supported native sections and establish a new identity without changing the data
model or weakening platform contracts. Honor explicit user preservation preferences.

<!-- gate: create-site:non-spa-2-select-template | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:non-spa-2-select-template):** Select the exact supported template
> identifier submitted to Create Website.
>
> **Trigger:** Documented template list loaded.
> **Why we ask:** Display names must never be guessed or converted into API identifiers.
> **Cancel leaves:** Nothing — no site or local project exists.

Build `AskUserQuestion` choices from the helper's filtered `catalog.templates`, plus Cancel. Show
the `catalog.bootstrapCompatibility` disclosure when present, including the source and omitted
template names. Do not
offer the unfiltered catalog on the Bootstrap 5 path: not every template supports Bootstrap 5
creation (for example, Event Portal is not on the documented supported list). Never infer
compatibility from a display name or substitute another template automatically.

Keep the exact `name` from the helper result as `TEMPLATE_NAME`. This is the samples manifest's
`provisioning.templateName`, not a value inferred from its display name or catalog ID. Retain the
returned catalog `owner`, `repo`, release/ref, and commit SHA as `CATALOG_OWNER`, `CATALOG_REPO`,
and `CATALOG_SHA` in the provisioning review and status reporting. Every status-renderer call must
use those same values; never resolve `latest-release` again after template selection.
Show the selected template's description, capabilities, requirements, and warning from the helper
result. Do not rewrite or duplicate this metadata in the workflow.

### Record the selected template

Keep the selected entry's catalog `id` as `TEMPLATE_ID`, separately from API `TEMPLATE_NAME`.
After the user selects a valid template, record the selection through the existing telemetry
transport:

```bash
node "${PLUGIN_ROOT}/scripts/emit-non-spa-creation-telemetry.js" --eventName template_used --templateId "<TEMPLATE_ID>" --catalogSha "<CATALOG_SHA>"
```

Retain the returned `correlationId` as `CREATION_CORRELATION_ID` in the conversation's creation
resume context. On repeated selection calls for the **same unfinished creation**, append
`--correlationId "<CREATION_CORRELATION_ID>"`; do not generate another ID. The helper validates
membership in the already-cached non-SPA catalog, saves a private receipt outside the site
tree, and reuses context without additional PAC calls at completion. If audience is already known
to be `internal` or `external`, append `--audience "<audience>"`; otherwise omit it. Do not ask
another question or infer audience from the catalog's maker personas. Pass `--sessionId` only
when the host conversation ID is already available, never a site identifier.

Keep the same correlation across polling, authentication repair, download retries, parameter
correction and resume of this unfinished creation. A different selected template/catalog revision
or an intentional new attempt after a **recorded terminal outcome** needs a new selection ID.
Retain any accepted provisioning operation separately: a new telemetry ID never authorizes a
second POST. Never put these receipts in the downloaded project, Git baseline, or status HTML.

Treat telemetry as best-effort: `{ "ok": false }`, a skipped result, or a command failure does not
block, restart, or otherwise change creation. If no correlation was returned, omit later creation
events rather than invent a result-only ID. Do not re-fetch the catalog or retry telemetry to fix
a recording failure. Existing default skill telemetry is unchanged.

## Phase 3: Gather Site and Destination Configuration

<!-- not-a-gate: creation parameters are data gathering; Phase 4 is the final cloud-mutation gate -->

Use `AskUserQuestion` to collect:

- Site name
- Destination: current directory, a new child folder, or another directory

Use `BASE_LANGUAGE_LCID` as `SELECTED_BASE_LANGUAGE` without asking a language question during the
normal flow. It is the confirmed environment's Dataverse organization default and is already
valid for that organization. Set `SELECTED_BASE_LANGUAGE_SOURCE` to `Organization default`. Do not
silently replace it with English `1033`.

If the user explicitly requested a different base language, handle that intent before the
provisioning review. Ask for a human-readable language, not a raw LCID, and use only a language
verified as enabled in the selected Dataverse organization. Store its LCID as
`SELECTED_BASE_LANGUAGE` and set `SELECTED_BASE_LANGUAGE_SOURCE` to `User selected`. If the
requested language cannot be verified, explain the problem and do not continue to the provisioning
review until the user accepts the organization default or selects a verified alternative. Never
guess an LCID.

Generate the same random subdomain suggestion used by the SPA activation workflow:

```bash
node "${PLUGIN_ROOT}/skills/activate-site/scripts/generate-subdomain.js"
```

Store stdout as `SUGGESTED_SUBDOMAIN`. It has the Power Pages Studio-style form
`site-<five base-36 characters>`.

Collect the subdomain as one editable text field pre-populated with the suggestion:

| Question | Header | Default value |
|---|---|---|
| Subdomain | Subdomain | `<SUGGESTED_SUBDOMAIN>` |

The field remains editable so the user can replace the suggestion before submitting it. Store the
submitted value as `SUBDOMAIN`; never append another random suffix or otherwise change it.

Validate before any cloud mutation:

- Site name is non-empty and no longer than 200 characters.
- The confirmed subdomain contains 2-63 lowercase letters, numbers, or hyphens and does not
  start/end with `-`.
- Destination resolves to a concrete path.
- Destination does not contain an unrelated Power Pages project.
- A non-empty destination requires a different directory; do not overwrite.

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

Ask: **Create this site and download it?** Options: **Create site**, **Change settings**, **Cancel**.

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
- Immediately before any `AskUserQuestion`, rewrite the same page with the current lifecycle
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
or Skill hooks as success/failure evidence, and do not count later customization/deployment errors
as creation failures. If recording fails, report the original creation error, not a telemetry error.

## Phase 6: Verify and Download

Update the status page before website identity lookup:

```bash
node "${PLUGIN_ROOT}/skills/create-site/scripts/render-non-spa-status.js" --output "<statusPagePath>" --templateName "<templateName>" --catalogOwner "<CATALOG_OWNER>" --catalogRepo "<CATALOG_REPO>" --catalogSha "<CATALOG_SHA>" --modelVersion "<MODEL_VERSION>" --status "registration" --siteName "<siteName>" --subdomain "<subdomain>" --siteUrl "<siteUrl>" --cloud "<cloud>" --language "<SELECTED_BASE_LANGUAGE>" --languageName "<BASE_LANGUAGE_NAME>" --languageCode "<BASE_LANGUAGE_CODE>"
```

1. If the terminal operation result did not include `websiteRecordId`, run this read-only lookup
   with bounded backoff:

   ```bash
   node "${PLUGIN_ROOT}/scripts/website.js" --siteName "<siteName>" --subdomain "<subdomain>"
   ```

   Store the exact match's non-empty `websiteRecordId` as `WEBSITE_RECORD_ID`.
2. If the Power Platform API still reports an empty website record ID, run `pac pages list -v`
   with bounded backoff and match by exact site name and subdomain. Capture the Website Record ID
   from that row. Never submit another creation request.
3. Before checking PAC, update the same status page with `--status "verification"` and include
   `--websiteRecordId "<websiteRecordId>"` when available. In the same `pac pages list -v` row,
   verify the site reports `MODEL_VERSION`.
4. If it reports the other model or cannot be matched, stop before download. Do not use the
   download flag as a conversion mechanism. Render the terminal status `model-mismatch`, passing
   the PAC-reported model as `--actualModelVersion`, so the browser explains why the workflow
   stopped and confirms that no duplicate site will be created.
5. Update the status page with `--status "download"`, then run:

   ```bash
   pac pages download --path "<destination>" --webSiteId "<websiteRecordId>" --environment "<environmentUrl>" --modelVersion "<MODEL_VERSION>"
   ```

6. Locate the downloaded directory containing `.powerpages-site/.portalconfig/` and use its parent
   as `PROJECT_ROOT`. If provisioning succeeded but download is not immediately available, retry
   download with bounded backoff. Never create the website again.

## Phase 7: Validate and Establish the Baseline

Update the status page with `--status "validation"` before running the validator.

Run the create-site validator against the resolved project:

```bash
node "${PLUGIN_ROOT}/skills/create-site/scripts/validate-site.js" --projectRoot "<projectRoot>" --websiteRecordId "<websiteRecordId>" --bootstrapVersion "<BOOTSTRAP_VERSION>" --skipGit true
```

The non-SPA path must verify:

- `.powerpages-site/.portalconfig/` exists.
- `.powerpages-site/website.yml` exists and is non-empty.
- `website.yml` identifies the submitted website record ID.
- The downloaded tree contains non-SPA assets in addition to identity metadata.
- Bootstrap evidence is known, unambiguous, and matches `BOOTSTRAP_VERSION`; reuse the shared
  non-SPA site inspector rather than inferring the version from the data model or template name.
- Git is initialized.

If Bootstrap is missing, conflicting, or mismatched, stop before customization and report the
created cloud site and preserved local baseline. Do not recreate it, change the environment
toggle, install another Bootstrap copy, or silently migrate it. Resolve the evidence or obtain
separate consent for the existing migration workflow.

Initialize Git only after the downloaded identity is confirmed:

Update the status page with `--status "git"` immediately before Git initialization.
This continues UI Step 06, **Local validation**, which includes saving the Git baseline;
it does not add a separate timeline row. Keep the Git operation and final validation below.

```bash
git init
git add -A
git commit -m "Initial <MODEL_VERSION> non-SPA site from <template display name> template"
```

Run the validator again after Git initialization.

```bash
node "${PLUGIN_ROOT}/skills/create-site/scripts/validate-site.js" --projectRoot "<projectRoot>" --websiteRecordId "<websiteRecordId>" --bootstrapVersion "<BOOTSTRAP_VERSION>"
```

Only after explicit-model/identity verification, download, Bootstrap/assets validation, the Git
baseline commit, and this final validator have **all succeeded**, record baseline completion:

```bash
node "${PLUGIN_ROOT}/scripts/emit-non-spa-creation-telemetry.js" --eventName non_spa_creation_success --correlationId "<CREATION_CORRELATION_ID>"
```

Use the saved selection correlation; skip this call if it is unavailable. The helper allows only
one terminal outcome per correlation. API acceptance/provisioning alone is not creation success.
Recording is nonblocking and happens before optional customization, not after it.

After the final validator succeeds, update the status page with terminal status `ready`. Include
the service-returned or independently verified HTTPS site URL through `--siteUrl` and include the
website record ID. The renderer intentionally rejects `ready` without an explicit URL so the
completion action never links to a guessed subdomain. Terminal pages stop auto-refreshing but
remain available in the OS temporary directory for the user to review while beginning
customization.

## Phase 8: Present Results

Record usage through `${PLUGIN_ROOT}/references/skill-tracking-reference.md` with skill name
`CreateSite`.

Present:

- Site name and template
- Environment
- Website record ID
- Site URL
- Local project path
- Confirmed data model: `<MODEL_VERSION>`
- Verified Bootstrap major: `<BOOTSTRAP_VERSION>`
- Validation and Git baseline result
- Creation status page URL

Explain that the local files are the validated, committed baseline of the site already created in
the environment, not yet the completed bespoke design. Do not ask to deploy the unchanged baseline.
Recommend continuing with the user's original purpose, a cohesive visual direction, and meaningful
hero/supporting imagery using the shared design-quality guidance.

<!-- gate: create-site:non-spa-8-customize | category=plan | cancel-leaves=non-spa-baseline -->

> 🚦 **Gate (plan · create-site:non-spa-8-customize):** Choose whether to continue into coordinated
> local non-SPA customization.
>
> **Trigger:** Explicit-model download, identity validation, and the untouched-template Git baseline
> succeeded.
> **Why:** Customization can create or modify several local non-SPA records, while declining
> should leave the verified Microsoft template unchanged.
> **Cancel leaves:** The created live site and verified local baseline.

Use `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Would you like to customize the downloaded non-SPA template now? | Customize site | Customize now (Recommended), Keep the template unchanged |

Before this question, rewrite the `ready` status with `--activityState "awaiting-input"` and
`--requiredAction "Choose whether to customize the downloaded template now or keep it unchanged."`
Retain the same verified `--siteUrl` so the completed-site action remains available. After
receiving either answer, declining the question, or canceling it, rewrite `ready` without an
activity override, again retaining `--siteUrl`, so the notification clears and the page returns
to its completed state. Never mark the completed creation as failed or canceled because optional
customization did not start.

On **Customize now**, tell the user:

> Continuing with the preview non-SPA site customization experience.

Then invoke `/edit-site` through the `Skill` tool and provide:

- exact `PROJECT_ROOT` and non-SPA site root;
- site name and selected template as data-model/domain and requirements context, not a visual
  constraint; include genuinely requested capabilities/content and explicit preservation preferences;
- environment URL;
- `WEBSITE_RECORD_ID`;
- configured base language;
- the user's original site intent, when present;
- the requirement for a custom modern page composition, layout, branding and presentation,
  reusing needed native forms/lists/snippets rather than their surrounding starter layout.
  Allow removal of unneeded starter sections and component placements within the approved scope,
  without deleting backing records or discarding required capabilities.
  Record it in the existing `summary` and
  `newSiteDesign.composition` brief and carry it through `designContext`; do not default to retaining
  the starter arrangement or ask for separate redesign permission merely because it differs;
- any already established experience brief, brand source, primary action, and narrative intent;
  let the customizer complete only missing decisions rather than asking for them again;
- native-editing requirements: known layout recipes are defaults, not an exhaustive list.
  Explicit broader safe local geometry carries a Studio-editing-unverified warning through
  planning, authoring and verification; no automatic deployment or preview-component creation;
- `creationIntent: "new-site"` and `verifiedBootstrapMajor: 5` with the inspected evidence;
- `previewNoticeShown: true` and `invocationSource: create-site`;
- the requirement to include header branding, navigation styling and mobile treatment in the
  existing customization plan, including an explicit website-appropriate logo or wordmark
  decision. Pass any supplied approved logo and known brand requirements; replace an unsuitable
  starter logo rather than inheriting it by default, and honor explicit preservation preferences.
  Header work is part of the custom composition, not a replacement for page design;
- `imageDelivery: "external-url"`: record this as `newSiteDesign.imageDelivery` and use direct
  approved HTTPS URLs for new images. Skip image staging/downloads, `author-web-file` image
  imports, and fabricated import dependencies. Retain source/license, alt text, sizing/crop,
  external-host/privacy/CSP review, and the native image-component contract;
- the requirement for a coordinated design and meaningful images, unless the user explicitly
  declines imagery. The customizer records these decisions in `newSiteDesign`, not an existing-site
  preservation-only plan.

The customization plan must include actual composition work for Home and the primary visitor
journey, not only extra pages or CSS over the starter. Reuse the existing layout-planning reference
to resolve component placements and native owner operations before plan approval. Explicitly
preserved regions remain exceptions within their stated scope; they do not freeze the rest of the site.

The customization skill owns its own plan approval, authoring-skill coordination, local
verification, commits, and deployment handoff. Do not duplicate those phases here.

On **Keep the template unchanged**, do not require customization before evaluating downstream
needs.

After the customization skill returns, or immediately after **Keep the template unchanged**,
evaluate the same downstream recommendations from the verified baseline plus any returned
customization result. Customization success is not a prerequisite:

- Suggest `/setup-datamodel` only when a known site requirement needs a specific table, column, or
  relationship that is absent from the downloaded evidence and authoritative Dataverse metadata.
  Name the exact missing schema; do not recommend a generic data-model pass.
- Never suggest `/add-sample-data` for a non-SPA site. Sample records can affect shared live
  Dataverse data and are not a creation default.
- Suggest `/create-webroles` only when a known audience or access requirement needs a role that is
  absent from the normalized aggregate/per-record role inventory.
- Suggest `/integrate-webapi` only when a known interaction requires native data access or custom
  client behavior and the returned customization did not already satisfy it through a Form,
  Advanced Form, List, Liquid, settings, permissions, or existing Web API caller.
- Suppress recommendations already completed by the customization result or disproved by current
  evidence. Do not invent roles, tables, CRUD needs, or API integration merely because the
  corresponding skill exists.

Finish after presenting only the evidence-backed recommendations whose non-SPA support has
been verified.
