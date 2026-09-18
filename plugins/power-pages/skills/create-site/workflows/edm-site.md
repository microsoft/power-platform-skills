# Create an Enhanced Data Model Site

Follow this workflow only after `create-site` routes the request to an Enhanced data model (EDM)
declarative site. The platform creates the baseline from a documented first-party template; the
skill downloads that baseline rather than generating Power Pages metadata.

## Invariants

- This workflow creates Enhanced sites only. It does not create Standard data model sites.
- The environment EDM toggle has no documented public read or write API.
- An environment administrator must verify **Switch to enhanced data model** in Power Platform
  admin center. The skill never automates that shared environment change.
- The template list is a plugin-owned EDM allowlist. It is not presented as an
  environment-specific catalog because no public template-catalog API is available.
- Do not submit `websiteRecordId` for a new EDM site. The platform creates the Dataverse website
  record and returns or exposes its ID after provisioning.
- Never retry a Create Website POST after `202 Accepted`. Poll or resume the accepted operation.
- Download with `--modelVersion Enhanced` explicitly.
- Do not invoke `activate-site` or show a deploy-now prompt after creation. The Create Website API
  already provisions the cloud site.

## Progress Tracking

Create all eight tasks before starting:

| Task subject | Active form | Description |
|---|---|---|
| Verify EDM prerequisites | Verifying EDM prerequisites | Verify tools, authentication, environment identity, and administrator confirmation |
| Select an EDM template | Selecting an EDM template | Load the supported EDM templates and select one |
| Configure the EDM site | Configuring the EDM site | Gather name, language, subdomain, and destination |
| Approve EDM provisioning | Reviewing EDM provisioning | Present the complete cloud and local plan for final consent |
| Provision the EDM site | Provisioning the EDM site | Create the website and poll the accepted operation |
| Download the EDM site | Downloading the EDM site | Verify the created model and download explicitly as Enhanced |
| Validate the EDM baseline | Validating the EDM baseline | Validate declarative artifacts and initialize Git |
| Complete EDM setup | Completing EDM setup | Present cloud/local results and optionally customize the downloaded template |

## Phase 1: Verify Prerequisites and EDM Availability

1. Run the plugin version check from the parent skill.
2. Verify:

   ```bash
   pac help
   pac pages help
   az account show
   ```

3. Resolve the current environment:

   ```bash
   node "${PLUGIN_ROOT}/skills/create-site/scripts/resolve-edm-context.js"
   ```

   The helper returns only non-secret context: environment URL, environment ID, Dataverse
   organization ID, and cloud. If authentication is missing, guide the user through `pac auth
   create` or `az login`, then retry.

> 🚦 **Gate (consent · create-site:edm-1-confirm-environment):** Confirm the exact environment
> before template selection and provisioning.
>
> **Trigger:** EDM context resolved.
> **Why we ask:** Creating in the wrong environment leaves a real shared cloud resource.
> **Cancel leaves:** Nothing — no site or local project exists.

4. Show the environment URL and ID, then ask whether to use this environment. If the user chooses
   another environment, select/authenticate it and rerun the context helper before asking again.

5. Run:

   ```bash
   node "${PLUGIN_ROOT}/skills/create-site/scripts/list-site-templates.js"
   ```

   The expected capability status is `indeterminate` because no documented API reads the toggle.

> 🚦 **Gate (progress · create-site:edm-1-confirm-capability):** Require administrator
> confirmation that **Switch to enhanced data model** is enabled.
>
> **Trigger:** Public API capability result is `indeterminate`.
> **Why we ask:** Existing sites and Dataverse tables do not prove which model a newly created site
> will use.
> **Cancel leaves:** Nothing — no site or local project exists.

6. Explain how to verify the toggle in Power Platform admin center and use `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Has an environment administrator verified that **Switch to enhanced data model** is enabled for this environment? | EDM availability | Yes, it is enabled, Open Power Platform admin center, Choose another environment, Cancel |

7. On **Open Power Platform admin center**, open `https://aka.ms/ppac`, wait for the user to
   verify or change the setting, and ask again. On **Choose another environment**, return to step
   4. Never toggle the setting through browser automation.
8. After confirmation, rerun:

   ```bash
   node "${PLUGIN_ROOT}/skills/create-site/scripts/list-site-templates.js" --administratorConfirmed
   ```

## Phase 2: Select a Documented Template

Present the returned templates with the disclosure:

> These are the EDM template identifiers supported by this plugin. Microsoft does not publish an
> environment-specific template-catalog API, so this may not include every template shown in
> Power Pages design studio.

> 🚦 **Gate (plan · create-site:edm-2-select-template):** Select the exact supported template
> identifier submitted to Create Website.
>
> **Trigger:** Documented template list loaded.
> **Why we ask:** Display names must never be guessed or converted into API identifiers.
> **Cancel leaves:** Nothing — no site or local project exists.

Use `AskUserQuestion` with:

- Starter Layout 1
- Program Registration
- Event Portal
- Schedule and Manage Meetings
- Cancel

Keep the exact `name` from the helper result as `TEMPLATE_NAME`.
Show the selected template's description, capabilities, requirements, and warning from the helper
result. Do not rewrite or duplicate this metadata in the workflow.

## Phase 3: Gather Site and Destination Configuration

<!-- not-a-gate: creation parameters are data gathering; Phase 4 is the final cloud-mutation gate -->

Use `AskUserQuestion` to collect:

- Site name
- Base language LCID; default to English `1033` unless the user requires another supported
  language
- Subdomain
- Destination: current directory, a new child folder, or another directory

Validate before any cloud mutation:

- Site name is non-empty and no longer than 200 characters.
- Subdomain contains 2-63 lowercase letters, numbers, or hyphens and does not start/end with `-`.
- Destination resolves to a concrete path.
- Destination does not contain an unrelated Power Pages project.
- A non-empty destination requires a different directory; do not overwrite.

## Phase 4: Review and Approve Provisioning

Show:

```text
Site type: Enhanced data model (declarative)
Environment URL: <environmentUrl>
Environment ID: <environmentId>
Template: <template display name> (<templateName>)
Template requirements: <requirements, or "None listed">
Site name: <siteName>
Language LCID: <lcid>
Subdomain: <subdomain>
Website record ID: Assigned by Power Pages during provisioning
Download destination: <resolved path>
```

> 🚦 **Gate (final · create-site:edm-4-provision):** Final consent immediately before the Create
> Website API call.
>
> **Trigger:** All cloud and local parameters have been validated.
> **Why we ask:** The next action creates a real Power Pages resource in the confirmed environment.
> **Cancel leaves:** Nothing — no API call has been made.

Ask: **Create this site and download it?** Options: **Create site**, **Change settings**, **Cancel**.

## Phase 5: Provision the Site

Before submitting the request, generate the browser status page:

```bash
node "${PLUGIN_ROOT}/skills/create-site/scripts/render-edm-status.js" --templateName "<templateName>" --status "provisioning" --siteName "<siteName>" --subdomain "<subdomain>" --language "<lcid>"
```

Store the returned `output` as `STATUS_PAGE_PATH` and `url` as `STATUS_PAGE_URL`. The renderer
uses a stable OS temporary path derived from the validated subdomain, embeds all preview images,
and overwrites the same file as the workflow advances.

Open `STATUS_PAGE_PATH` in the user's default browser using the OS-native launcher pattern from
`plan-alm`: `Start-Process` on Windows, `open` on macOS, or `xdg-open` on Linux. Print
`STATUS_PAGE_URL` before launching so the user has a direct fallback. Do not block provisioning if
the browser launcher fails.

Run the shared provisioner:

```bash
node "${PLUGIN_ROOT}/skills/activate-site/scripts/activate-site.js" --siteName "<siteName>" --subdomain "<subdomain>" --organizationId "<organizationId>" --environmentId "<environmentId>" --cloud "<cloud>" --templateName "<templateName>" --selectedBaseLanguage "<lcid>"
```

Use a command timeout of at least six minutes.

- `Succeeded`: store the service-assigned `websiteRecordId` as `WEBSITE_RECORD_ID`, then continue.
- `Running`: preserve `operationLocation` and all submitted parameters. Do not
  POST again. Resume with the same command and append:

  ```bash
  --operationLocation "<saved operationLocation>"
  ```
- `Failed` before acceptance: show the service error. Allow parameter correction where relevant.
- `401`/`403`: repair authentication or permissions, then retry only when the response proves the
  request was not accepted.
- Template unavailable: return to Phase 2; never substitute a template automatically.

If status-page rendering fails before submission, repair it before the POST. If an update fails
after the request was accepted, report the status-page error but continue polling the accepted
operation; a presentation failure must never cause a second creation POST.

## Phase 6: Verify and Download

Update the status page before website identity lookup:

```bash
node "${PLUGIN_ROOT}/skills/create-site/scripts/render-edm-status.js" --output "<statusPagePath>" --templateName "<templateName>" --status "registration" --siteName "<siteName>" --subdomain "<subdomain>" --siteUrl "<siteUrl>" --language "<lcid>"
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
   verify the site reports the **Enhanced** data model.
4. If it reports Standard or cannot be matched, stop before download. Do not use the Enhanced
   download flag as a conversion mechanism. Render the terminal status `model-mismatch` so the
   browser explains why the workflow stopped and confirms that no duplicate site will be created.
5. Update the status page with `--status "download"`, then run:

   ```bash
   pac pages download --path "<destination>" --webSiteId "<websiteRecordId>" --environment "<environmentUrl>" --modelVersion Enhanced
   ```

6. Locate the downloaded directory containing `.powerpages-site/.portalconfig/` and use its parent
   as `PROJECT_ROOT`. If provisioning succeeded but download is not immediately available, retry
   download with bounded backoff. Never create the website again.

## Phase 7: Validate and Establish the Baseline

Update the status page with `--status "validation"` before running the validator.

Run the create-site validator against the resolved project:

```bash
node "${PLUGIN_ROOT}/skills/create-site/scripts/validate-site.js" --projectRoot "<projectRoot>" --websiteRecordId "<websiteRecordId>" --skipGit true
```

The declarative path must verify:

- `.powerpages-site/.portalconfig/` exists.
- `.powerpages-site/website.yml` exists and is non-empty.
- `website.yml` identifies the submitted website record ID.
- The downloaded tree contains declarative assets in addition to identity metadata.
- Git is initialized.

Initialize Git only after the downloaded identity is confirmed:

Update the status page with `--status "git"` immediately before Git initialization.

```bash
git init
git add -A
git commit -m "Initial EDM site from <template display name> template"
```

Run the validator again after Git initialization.

```bash
node "${PLUGIN_ROOT}/skills/create-site/scripts/validate-site.js" --projectRoot "<projectRoot>" --websiteRecordId "<websiteRecordId>"
```

After the final validator succeeds, update the status page with terminal status `ready`. Include
the final site URL and website record ID. Terminal pages stop auto-refreshing but remain available
in the OS temporary directory for the user to review while beginning customization.

## Phase 8: Present Results

Record usage through `${PLUGIN_ROOT}/references/skill-tracking-reference.md` with skill name
`CreateSite`.

Present:

- Site name and template
- Environment
- Website record ID
- Site URL
- Local project path
- Confirmed data model: Enhanced
- Validation and Git baseline result
- Creation status page URL

Explain that the local files are the validated, committed baseline of the site already created in
the environment. Do not ask to deploy the unchanged baseline.

<!-- gate: create-site:edm-8-customize | category=plan | cancel-leaves=edm-baseline -->

> 🚦 **Gate (plan · create-site:edm-8-customize):** Choose whether to continue into coordinated
> local declarative customization.
>
> **Trigger:** Enhanced download, identity validation, and the untouched-template Git baseline
> succeeded.
> **Why:** Customization can create or modify several local declarative records, while declining
> should leave the verified Microsoft template unchanged.
> **Cancel leaves:** The created live site and verified local baseline.

Use `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Would you like to customize the downloaded declarative template now? | Customize site | Customize now, Keep the template unchanged |

On **Customize now**, invoke `/customize-declarative-site` through the `Skill` tool and provide:

- exact `PROJECT_ROOT` and declarative site root;
- site name and selected template;
- environment URL;
- `WEBSITE_RECORD_ID`;
- configured base language;
- the user's original site intent, when present.

The customization skill owns its own plan approval, authoring-skill coordination, local
verification, commits, and deployment handoff. Do not duplicate those phases here.

On **Keep the template unchanged**, finish after recommending only downstream skills whose
declarative support has been verified.
