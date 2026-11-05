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
