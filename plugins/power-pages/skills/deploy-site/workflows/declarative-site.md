# Deploy a Declarative Power Pages Site

Follow this workflow only after `deploy-site` routes the request to a PAC CLI-downloaded
declarative site. It supports Enhanced and Standard sites when their model can be verified, but it
never guesses a model or uses PAC's default implicitly.

## Invariants

- Use `pac pages upload`, never `pac pages upload-code-site`.
- Pass `--modelVersion` explicitly on every upload.
- Do not run an npm build.
- Do not modify blocked JavaScript attachment settings.
- Do not invoke `activate-site`; a downloaded declarative site already has a website record.
- Confirm the local website identity exists in the selected environment before upload.
- A customization-plan approval is not deployment consent.

## Progress tracking

Create these tasks:

| Task subject | Active form | Description |
|---|---|---|
| Verify declarative project | Verifying declarative project | Resolve one site root, model, identity, and local validity |
| Verify PAC authentication | Verifying PAC authentication | Confirm PAC CLI and the active environment |
| Confirm deployment target | Confirming deployment target | Match the local website identity to the selected environment |
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
   unresolved until the exact PAC site-list match in Phase 3.
5. Run the declarative validator when the website ID is available:

   ```bash
   node "${PLUGIN_ROOT}/skills/create-site/scripts/validate-site.js" \
     --projectRoot "<PROJECT_ROOT>" \
     --websiteRecordId "<WEBSITE_RECORD_ID>"
   ```

6. Inspect Git status and
   `<PROJECT_ROOT>/docs/customize-declarative-site/current-plan.json` when present. Do not require
   the plan for a targeted manual edit, but use only this canonical approved plan to explain
   planned versus actual local changes.

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
Data model: <Enhanced|Standard>
Local site root: <site root>
Environment URL: <environment URL>
Environment ID: <environment ID>
```

Reuse the parent deployment environment consent semantics:

<!-- gate: deploy-site:3.confirm-env | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · deploy-site:3.confirm-env):** Confirm the exact target environment before
> querying and uploading the declarative site.

Use `AskUserQuestion`: **Deploy to this environment / Choose another environment / Cancel**.
After a switch, rerun `pac auth who` and show the resolved values again.

Run `pac pages list -v` and match the exact website record ID. Use that exact row to establish the
authoritative data model, which must be `Enhanced` or `Standard`. Verify its site name and model
agree with any local/invocation evidence. Stop on no match, duplicate/conflicting identity,
unsupported model, or mismatch. Upload is not a conversion mechanism.

## Phase 4: Review the upload

Summarize the local diff by declarative component category:

- webpages and localized page content;
- web files and assets;
- content snippets;
- web templates and page templates;
- navigation and language records;
- styling/CSS;
- other metadata.

Include uncommitted files, validation warnings, the explicit model argument, and the statement
that upload changes the already-live site. Unexpected component categories or unrelated dirty
files must be resolved or explicitly excluded before approval.

## Phase 5: Approve and upload

<!-- gate: deploy-site:declarative-5.upload | category=final | cancel-leaves=local-customization -->

> 🚦 **Gate (final · deploy-site:declarative-5.upload):** Approve the exact declarative root,
> environment, website identity, model, and summarized local changes immediately before upload.
>
> **Trigger:** Local validation and target identity/model verification succeeded.
> **Why:** The next command changes the existing live Power Pages site.
> **Cancel leaves:** All verified local files and commits; the live site is unchanged.

Ask: **Upload these declarative changes to this site?** Options: **Upload changes**, **Review
again**, **Cancel**.

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
2. Rerun `pac pages list -v`; confirm the same website record ID still reports the expected model.
3. Rerun the local declarative validator.
4. Record successful usage as `DeploySite`.
5. Report the environment, website ID, model, uploaded root, component categories, and any pending
   runtime/cache validation.
6. Recommend `/test-site` when a runtime URL is available. Do not offer activation for a
   declarative site.
