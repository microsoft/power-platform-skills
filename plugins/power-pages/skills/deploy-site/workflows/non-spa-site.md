# Deploy a Non-SPA Power Pages Site

Follow this workflow only after `deploy-site` routes the request to a PAC CLI-downloaded
non-SPA site. It supports updates to existing Enhanced and Standard sites when their model can be
verified, but it never guesses a model or uses PAC's default implicitly. When the website does not
yet exist in the selected environment, first-upload creation supports only Enhanced.

## Invariants

- Use `pac pages upload`, never `pac pages upload-code-site`.
- Pass `--modelVersion` explicitly on every upload.
- Do not run an npm build.
- Do not modify blocked JavaScript attachment settings.
- Do not invoke `activate-site` from this workflow.
- Match existing sites only by the exact local website record ID; never substitute a name match.
- For a first upload that creates website records, require Enhanced; never create a new Standard
  site. This restriction does not affect uploads to an existing verified Standard site.
- A customization-plan approval is not deployment consent.

## Progress tracking

Create these tasks:

| Task subject | Active form | Description |
|---|---|---|
| Verify non-SPA project | Verifying non-SPA project | Resolve one site root, model, identity, and local validity |
| Verify PAC authentication | Verifying PAC authentication | Confirm PAC CLI and the active environment |
| Confirm deployment target | Confirming deployment target | Match the local website identity or establish an explicit first-upload model |
| Review non-SPA upload | Reviewing non-SPA upload | Summarize changed component categories and warnings |
| Upload non-SPA site | Uploading non-SPA site | Obtain final approval and run the explicit-model PAC upload |
| Verify non-SPA deployment | Verifying non-SPA deployment | Confirm upload success, identity, model, and next checks |

## Phase 1: Verify the project

1. Follow `${PLUGIN_ROOT}/references/design-studio-site-discovery.md` and select exactly one
   non-SPA root containing `.portalconfig/` and non-empty `website.yml`.
2. Reject a `powerpages.config.json`-only SPA site.
3. Read the exact website record ID and site name from the downloaded metadata. Stop if identity
   is absent or conflicting.
4. Do not infer the data model from the customization plan or downloaded directory shape. Leave it
   unresolved until Phase 3 obtains it from an exact PAC site-list match or applies the Enhanced-only
   first-upload creation policy.
5. Run the non-SPA validator when the website ID is available:

   ```bash
   node "${PLUGIN_ROOT}/skills/create-site/scripts/validate-site.js" \
     --projectRoot "<PROJECT_ROOT>" \
     --websiteRecordId "<WEBSITE_RECORD_ID>"
   ```

6. Inspect Git status and
   `<PROJECT_ROOT>/docs/edit-site/current-plan.json` when present. Do not require
   the plan for a targeted manual edit. Before using it, validate the current plan, execution
   receipt, website identity, and project-relative site root:

   ```bash
   node "${PLUGIN_ROOT}/scripts/update-edit-site-execution.js" \
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
Project type: Non-SPA Power Pages site
Site name: <site name>
Website record ID: <website record id>
Data model: Pending verification
Local site root: <site root>
Environment URL: <environment URL>
Environment ID: <environment ID>
```

The selected environment has not been queried yet, so do not show Enhanced or Standard here.

Reuse the parent deployment environment consent semantics:

<!-- gate: deploy-site:non-spa-3.confirm-env | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · deploy-site:non-spa-3.confirm-env):** Confirm the exact target environment before
> querying and uploading the non-SPA site.

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
3. Explain that the target environment has no website with the local record ID, so upload would
   create new website records. New non-SPA website records can be created only with the Enhanced
   data model; existing verified Standard sites remain deployable.
4. Set the model to `Enhanced` and record its source as **EDM-only first-upload policy**. Do not
   infer that the local files are Enhanced and do not offer Standard creation.

After this lookup or policy resolution, show the resolved deployment summary again with:

```text
Deployment mode: <Update existing site|First upload — create site records>
Data model: <Enhanced|Standard>
Model source: <Existing website record|EDM-only first-upload policy>
```

Use that resolved summary for change review and final upload approval.

## Phase 4: Review the upload

Summarize the local diff by non-SPA component category:

- webpages and localized page content;
- web files and assets;
- content snippets;
- web templates and page templates;
- navigation and language records;
- styling/CSS;
- other metadata.

Review `docs/edit-site/**` separately as orchestration evidence. It is not a PAC
component category, must not be presented as uploadable metadata, and does not expand upload scope.

Include uncommitted files, validation warnings, deployment mode, model source, and the explicit
model argument. For an update, state that upload changes the existing live site. For a first
upload, state that it creates the non-SPA website records in the selected environment.
Unexpected component categories or unrelated dirty files must be resolved or explicitly excluded
before approval.

### 4.1 Audit permission-sensitive changes

From the exact local diff, detect whether uploadable changes affect any of these surfaces:

- Basic Forms, Advanced Forms or steps, or Lists;
- reachable Liquid/FetchXML in webpage copies, Web Templates, or Content Snippets;
- JavaScript Web Files containing `/_api/` or another Power Pages Web API caller;
- site settings, web roles, table permissions, or webpage access-control rules.

Do not trigger this gate for styling, static copy, images, navigation, or unrelated metadata when
the changed content has no data-access or access-control evidence.

When at least one permission-sensitive surface changed:

<!-- gate: deploy-site:non-spa-4.permissions-audit | category=plan | cancel-leaves=local-customization -->

> 🚦 **Gate (plan · deploy-site:non-spa-4.permissions-audit):** Run a read-only permissions
> audit before uploading access-sensitive non-SPA site changes.
>
> **Trigger:** The reviewed diff changes a Form, Advanced Form, List, reachable Liquid/FetchXML,
> Web API JavaScript, site setting, web role, table permission, or webpage access rule.
> **Why:** These changes can drift from table permissions, role coverage, field allowlists, or
> inherited page access even when local schema validation passes.
> **Cancel leaves:** All local customization unchanged; no upload has started.

Use `AskUserQuestion`: **Run permissions audit (Recommended) / Continue without audit / Cancel**.

- On **Run permissions audit**, invoke `/audit-permissions` for the exact `projectRoot` and wait
  for it to complete. The audit owns its existing fix-offer gate.
- If the audit or accepted fixes change any local file, rerun the non-SPA validator, recompute
  the Git diff, and regenerate the complete Phase 4 component summary before Phase 5. If the new
  diff introduces another permission-sensitive surface, include it in the refreshed summary; do
  not ask this gate a second time in the same deployment attempt.
- If validation fails after a fix, stop before upload.
- On **Continue without audit**, record that the user explicitly skipped the read-only check and
  continue to Phase 5.
- On **Cancel**, stop without upload.

When no permission-sensitive surface changed, skip this gate without mentioning it.

## Phase 5: Approve and upload

<!-- gate: deploy-site:non-spa-5.upload | category=final | cancel-leaves=local-customization -->

> 🚦 **Gate (final · deploy-site:non-spa-5.upload):** Approve the exact non-SPA root,
> environment, deployment mode, website identity, model, and summarized local changes immediately
> before upload.
>
> **Trigger:** Local validation and target identity/model resolution succeeded.
> **Why:** The next command changes an existing site or creates the non-SPA site records in the
> selected environment.
> **Cancel leaves:** All verified local files and commits; the target environment is unchanged.

For **Update existing site**, ask: **Upload these non-SPA changes to this site?** Options:
**Upload changes**, **Review again**, **Cancel**.

For **First upload — create site records**, ask: **Create this Enhanced data model non-SPA site
in the selected environment?** Options: **Create and upload**, **Review again**, **Cancel**.

Before executing, verify the installed `pac pages upload --help` output supports the arguments below.
Use the installed CLI's equivalent spelling only when needed; never omit the explicit model:

```bash
pac pages upload --path "<DECLARATIVE_SITE_ROOT>" \
  --environment "<ENVIRONMENT_URL>" \
  --modelVersion "<Enhanced|Standard>"
```

Replace the model placeholder with the existing website's authoritative model for an update, or
with `Enhanced` for a first upload.

On failure, show the PAC error and leave local state intact. Do not retry against another
environment, model, or site without returning through identity verification and final approval.

## Phase 6: Verify and report

1. Require a successful PAC exit and success output.
2. Rerun `pac pages list -v`; confirm exactly one row now matches the website record ID, site name,
   and expected model. For a first upload, this is the required proof that the new site records
   were created with the required Enhanced model.
3. Rerun the local non-SPA validator.
4. Record successful usage as `DeploySite`.
5. Report the environment, deployment mode, website ID, model and model source, uploaded root,
   component categories, and any pending runtime/cache validation.
6. Recommend `/test-site` when a runtime URL is available. Do not offer activation for a
   non-SPA site.
