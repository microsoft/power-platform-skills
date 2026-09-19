# Deploy a Declarative Power Pages Site

Follow this workflow only after `deploy-site` routes the request to a PAC CLI-downloaded
declarative site. It supports Enhanced and Standard sites when their model can be verified, but it
never guesses a model or uses PAC's default implicitly. When the website does not yet exist in the
selected environment, it requires the user to choose the first-upload model explicitly.

## Invariants

- Use `pac pages upload`, never `pac pages upload-code-site`.
- Pass `--modelVersion` explicitly on every upload.
- Do not run an npm build.
- Do not modify blocked JavaScript attachment settings.
- Do not invoke `activate-site` from this workflow.
- Match existing sites only by the exact local website record ID; never substitute a name match.
- For a first upload, require an explicit Standard or Enhanced selection with no default.
- A customization-plan approval is not deployment consent.

## Progress tracking

Create these tasks:

| Task subject | Active form | Description |
|---|---|---|
| Verify declarative project | Verifying declarative project | Resolve one site root, model, identity, and local validity |
| Verify PAC authentication | Verifying PAC authentication | Confirm PAC CLI and the active environment |
| Confirm deployment target | Confirming deployment target | Match the local website identity or establish an explicit first-upload model |
| Review declarative upload | Reviewing declarative upload | Summarize changed component categories and warnings |
| Upload declarative site | Uploading declarative site | Obtain final approval and run the explicit-model PAC upload |
| Verify declarative deployment | Verifying declarative deployment | Confirm upload success, identity, model, and next checks |

## Phase 1: Verify the project

1. Follow `${PLUGIN_ROOT}/references/design-studio-site-discovery.md` and select exactly one
   declarative root containing `.portalconfig/` and non-empty `website.yml`.
2. Reject a `powerpages.config.json`-only code site.
3. Read the exact website record ID and site name from the downloaded metadata. Stop if identity
   is absent or conflicting.
4. Do not infer the data model from the customization plan or downloaded directory shape. Leave it
   unresolved until Phase 3 obtains it from an exact PAC site-list match or an explicit first-upload
   selection.
5. Run the declarative validator when the website ID is available:

   ```bash
   node "${PLUGIN_ROOT}/skills/create-site/scripts/validate-site.js" \
     --projectRoot "<PROJECT_ROOT>" \
     --websiteRecordId "<WEBSITE_RECORD_ID>"
   ```

6. Inspect Git status and
   `<PROJECT_ROOT>/docs/customize-declarative-site/current-plan.json` when present. Do not require
   the plan for a targeted manual edit. Before using it, validate the current plan, execution
   receipt, website identity, and project-relative site root:

   ```bash
   node "${PLUGIN_ROOT}/scripts/update-customize-declarative-site-execution.js" \
     --projectRoot "<PROJECT_ROOT>" --action status \
     --websiteRecordId "<WEBSITE_RECORD_ID>" --siteRoot "<PROJECT_RELATIVE_SITE_ROOT>"
   ```

   Ignore no mismatch: a stale or copied plan must not describe the selected site.

## Phase 2: Verify PAC and authentication

Run:

```bash
pac help
pac pages upload --help
pac auth who
```

If PAC authentication is missing, guide the user through `pac auth create --environment
"<environmentUrl>"`, then rerun `pac auth who`. Extract and retain the exact environment URL and
ID.

## Phase 3: Confirm the target and identity

Show:

```text
Project type: Declarative Power Pages site
Site name: <site name>
Website record ID: <website record id>
Data model: Pending verification
Local site root: <site root>
Environment URL: <environment URL>
Environment ID: <environment ID>
```

The selected environment has not been queried yet, so do not show Enhanced or Standard here.

Reuse the parent deployment environment consent semantics:

<!-- gate: deploy-site:3.confirm-env | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · deploy-site:3.confirm-env):** Confirm the exact target environment before
> querying and uploading the declarative site.

Use `AskUserQuestion`: **Deploy to this environment / Choose another environment / Cancel**.
After a switch, rerun `pac auth who` and show the resolved values again.

Run `pac pages list -v` and match the exact website record ID.

If exactly one row matches:

1. Set deployment mode to **Update existing site**.
2. Use that row to establish the authoritative data model, which must be `Enhanced` or `Standard`.
3. Verify its site name agrees with the downloaded identity.
4. Stop on duplicate/conflicting identity, unsupported model, or name mismatch. Upload is not a
   conversion mechanism.

If no row matches:

1. Check whether the environment contains a different website record with the same site name. If
   so, stop and report both identities; never overwrite or adopt it by name.
2. Set deployment mode to **First upload — create site records**.
3. Explain that the target environment has no website with the local record ID and that the local
   files do not reliably reveal Standard versus Enhanced.

   <!-- not-a-gate: first-upload model selection is required data gathering; the Phase 5 final gate approves the cloud mutation -->

4. Use `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | This website does not exist in the selected environment. Which data model should be used for the first upload? | Site data model | Enhanced, Standard, Cancel |

   Do not recommend, preselect, or silently default either model. On **Cancel**, stop without
   uploading. Record the answer as **user-selected**, not environment-authoritative.

After this lookup or selection, show the resolved deployment summary again with:

```text
Deployment mode: <Update existing site|First upload — create site records>
Data model: <Enhanced|Standard>
Model source: <Existing website record|Explicit first-upload selection>
```

Use that resolved summary for change review and final upload approval.

## Phase 4: Review the upload

Summarize the local diff by declarative component category:

- webpages and localized page content;
- web files and assets;
- content snippets;
- web templates and page templates;
- navigation and language records;
- styling/CSS;
- other metadata.

Review `docs/customize-declarative-site/**` separately as orchestration evidence. It is not a PAC
component category, must not be presented as uploadable metadata, and does not expand upload scope.

Include uncommitted files, validation warnings, deployment mode, model source, and the explicit
model argument. For an update, state that upload changes the existing live site. For a first
upload, state that it creates the declarative website records in the selected environment.
Unexpected component categories or unrelated dirty files must be resolved or explicitly excluded
before approval.

## Phase 5: Approve and upload

<!-- gate: deploy-site:declarative-5.upload | category=final | cancel-leaves=local-customization -->

> 🚦 **Gate (final · deploy-site:declarative-5.upload):** Approve the exact declarative root,
> environment, deployment mode, website identity, model, and summarized local changes immediately
> before upload.
>
> **Trigger:** Local validation and target identity/model resolution succeeded.
> **Why:** The next command changes an existing site or creates the declarative site records in the
> selected environment.
> **Cancel leaves:** All verified local files and commits; the target environment is unchanged.

For **Update existing site**, ask: **Upload these declarative changes to this site?** Options:
**Upload changes**, **Review again**, **Cancel**.

For **First upload — create site records**, ask: **Create this declarative site in the selected
environment using the chosen data model?** Options: **Create and upload**, **Review again**,
**Cancel**.

Before executing, verify the installed `pac pages upload --help` output supports the arguments below.
Use the installed CLI's equivalent spelling only when needed; never omit the explicit model:

```bash
pac pages upload --path "<DECLARATIVE_SITE_ROOT>" \
  --environment "<ENVIRONMENT_URL>" \
  --modelVersion "<Enhanced|Standard>"
```

On failure, show the PAC error and leave local state intact. Do not retry against another
environment, model, or site without returning through identity verification and final approval.

## Phase 6: Verify and report

1. Require a successful PAC exit and success output.
2. Rerun `pac pages list -v`; confirm exactly one row now matches the website record ID, site name,
   and expected model. For a first upload, this is the required proof that the new site records
   were created with the user-selected model.
3. Rerun the local declarative validator.
4. Record successful usage as `DeploySite`.
5. Report the environment, deployment mode, website ID, model and model source, uploaded root,
   component categories, and any pending runtime/cache validation.
6. Recommend `/test-site` when a runtime URL is available. Do not offer activation for a
   declarative site.
