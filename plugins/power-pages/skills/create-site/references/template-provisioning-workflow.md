# Template provisioning

9. Prepare seed data in the main conversation before starting either mutating workstream.
      If seed data is present, fetch it:
      ```bash
      node "${PLUGIN_ROOT}/scripts/fetch-template-seed-data.js" --sha "<catalog-sha>" --seedDataPath "<SELECTED_TEMPLATE_VARIANT.seedDataPath or SELECTED_TEMPLATE.seedDataPath>"
      ```
      Save `localDir` and `seedFile` from a successful result as `TEMPLATE_SEED_DIRECTORY` and `TEMPLATE_SEED_FILE`.
      Inspect the source and target without inserting records:
      ```bash
      node "${PLUGIN_ROOT}/scripts/apply-seed-data.js" \
        --seedDir "<TEMPLATE_SEED_DIRECTORY>" \
        --seedFile "<TEMPLATE_SEED_FILE>" \
        --envUrl "<environmentUrl>" \
        --plan
      ```
      This reports table/record/file counts, financial entity sets, and active target currencies with `writes: 0`.
      <!-- not-a-gate: create-site:1.5.seed-currency — Read-only currency selection prepares already-approved optional seed records; it does not create currencies or mutate records. -->
      If `requiresCurrencySelection` is true, ask in the main conversation which existing active currency the financial sample rows should use.
      Show the available currency codes/names, explain that the numeric amounts are not converted, and offer **Skip sample data**.
      Never create a currency, copy a source-environment currency GUID, or silently assume USD.
      Save the selected ISO code as `TEMPLATE_SEED_CURRENCY_CODE`.
      If the user skips sample data, do not launch seed writes.
      If no financial rows are present, omit currency selection and the `--currencyCode` flag.
      Fetch/plan failures remain best-effort seed failures: show the explicit failure, retain it in the seed summary, and create the site without a seed task rather than pretending records were inserted.

      Start site provisioning and seed-data application only after successful imports and the main-conversation seed decisions.
      Run these independent workstreams concurrently when background work is supported; otherwise run them sequentially, retaining both results before activation:
      - Mark **Clone, build, and upload template site** as `in_progress`.
      - If seed data is ready and was not skipped, mark **Apply template seed data** as `in_progress` and launch the seed-data workstream with an available background-work capability. The background task must only apply and verify the prepared seed data. It must not clone, build, upload, activate, update the shared status file, ask the user questions, or retry failed writes.
      - Run the site-provisioning wrapper in the main conversation while the seed-data task runs. These workstreams are independent after the supporting solution import creates the required Dataverse tables.

      When seed data is present, update the status page:
      ```json
      { "state": "running", "phase": "siteAndSeed", "message": "Creating template site and seeding data" }
      ```
      When seed data is absent, update it with:
      ```json
      { "state": "running", "phase": "site", "message": "Cloning, building, and uploading template site" }
      ```
      Clone the packaged SPA source into the directory selected earlier, then upload the clone:
      ```bash
      node "${PLUGIN_ROOT}/scripts/provision-template-site.js" \
        --sourcePath "<SELECTED_TEMPLATE_WEBSITE_CODE>" \
        --outputDirectory "<TEMPLATE_CLONE_OUTPUT_DIRECTORY>" \
        --siteName "<__SITE_NAME__>"
      ```
      Treat the wrapper as the sole template-site provisioning entry point. Do not rerun its underlying `pac`, `npm`, or build commands directly for diagnosis. Never pipe a mutating command such as `pac pages clone` or `pac pages upload-code-site` through `head`, `tail`, or another consumer that can close the output stream before the command finishes. The wrapper safely captures a bounded diagnostic tail without interrupting the command. On success, save the returned `clonedPath` as both `CLONED_TEMPLATE_SITE_PATH` and `PROJECT_ROOT`, `siteName` as `IMPORTED_SITE_NAME`, and `websiteRecordId` as `IMPORTED_WEBSITE_RECORD_ID`.
   10. In the seed-data background task, use the main conversation's prepared directory/file and currency decision:
       ```bash
       node "${PLUGIN_ROOT}/scripts/apply-seed-data.js" \
         --seedDir "<TEMPLATE_SEED_DIRECTORY>" \
         --seedFile "<TEMPLATE_SEED_FILE>" \
         --envUrl "<environmentUrl>" \
         --currencyCode "<TEMPLATE_SEED_CURRENCY_CODE, only when financial rows were planned>"
       ```
       Omit the entire currency flag when no financial rows were planned.
       The seeder resolves only an existing active target currency and its exact metadata navigation before any writes.
       It removes declared upload-column values and their generated file-name companions from create payloads; file-upload actions populate those fields.
       Return the complete JSON summary (`ok`, `inserted`, `failed`, `skipped`, `errors`) to the main conversation.
       A partial row, state, validation, or file-upload failure must be reported as `ok: false`; never rely solely on a successful CLI exit.
       Seed records must use the exact table entity-set names, column logical names, and scalar or collection `<NavigationProperty>@odata.bind` lookup names from the template solution metadata.
       Never derive lookup navigation properties from a primary key, entity set, display name, or app-style alias such as `categoryId`; the seeder rejects ambiguous aliases and malformed collection binds before its first Dataverse write.
       For verification, query the planned record IDs—not merely `$top=1`—and compare expected references and native collection memberships.
       Verify each uploaded attachment through its target file metadata/content, rather than counting only created attachment rows.
       Ordinary existing seed-record skips do not reconcile native N:N memberships; disclose that limit and do not silently update existing contacts, businesses, or assignments.
   11. Wait for both workstreams to finish before showing the inactive-site summary or starting activation. Record the seed summary, then mark **Apply template seed data** as `completed`; if seed data is absent, mark it skipped. Seed fetch and insertion remain best-effort: surface their result, but do not fail site creation or block activation.

       If `EMIT_TEMPLATE_IMPORT_SUCCESS = true`, emit the import result now:
       ```bash
       node "${PLUGIN_ROOT}/scripts/emit-create-site-template-outcome.js" \
         --eventName template_import_success \
         --templateId "<SELECTED_TEMPLATE.id>" \
         --templateKind "<SELECTED_TEMPLATE.kind>" \
         --framework "<SELECTED_TEMPLATE_VARIANT.framework>" \
         --audience "<internal|external from Phase 1 discovery>" \
         --seedApplied "<true only when the seed summary has inserted > 0 and failed = 0; otherwise false>"
       ```
       `--audience` is the site audience captured in Phase 1 (`internal` or `external`), **not** the template's `audience` persona array from the catalog manifest. Do not include site name, URL, subdomain, free-text purpose, or any other user-identifying value.
   12. If clone, cloned-identity inspection, dependency installation, build, build-output validation, or upload fails, run `template_clone_failure` telemetry silently. Map the returned `step` to `errorClass`: `clone`/`clone-output` → `PacPagesClone`, `install` → `NpmInstall`, `build` → `NpmBuild`, `build-output` → `CompiledOutput`, and `upload` → `PacPagesUploadCodeSite`:
       ```bash
       node "${PLUGIN_ROOT}/scripts/emit-create-site-template-outcome.js" \
         --eventName template_clone_failure \
         --templateId "<SELECTED_TEMPLATE.id>" \
         --templateKind "<SELECTED_TEMPLATE.kind>" \
         --framework "<SELECTED_TEMPLATE_VARIANT.framework>" \
         --audience "<internal|external from Phase 1 discovery>" \
         --outcome failure \
         --errorClass "<PacPagesClone|NpmInstall|NpmBuild|CompiledOutput|PacPagesUploadCodeSite>"
       ```
       Update the status page before firing the recovery gate:
       ```json
       { "state": "error", "phase": "site", "message": "Template site creation failed" }
       ```
       Diagnose the failure only from the wrapper's returned `step`, `error`, and preserved local path. Do not rerun the wrapper or any underlying command until the user chooses a recovery option.
       Then fire this gate:

      <!-- gate: create-site:1.5.clone-failed | category=progress | cancel-leaves=partial-template-clone -->

      > 🚦 **Gate (progress · create-site:1.5.clone-failed):** Choose how to proceed after cloning, building, or uploading the packaged template site fails.
      >
      > **Trigger:** Phase 1.5 when cloning, cloned identity inspection, dependency installation, the project build, compiled-output validation, or `pac pages upload-code-site` fails.
      > **Why we ask:** The selected project directory can contain partial clone or build output, the environment can contain a partial code-site upload, and supporting solutions may already be installed.
      > **Cancel leaves:** `partial-template-clone` — cached template artifacts and local files remain in the selected project directory; supporting solutions or a partial site upload may also remain in Dataverse.

      Ask the user:

      | Question | Header | Options |
      |----------|--------|---------|
      | The template site could not be cloned, built, or uploaded. How would you like to proceed? | Site Creation Failed | Retry site creation (Recommended), Fall back to from-scratch, Stop |

      Do not retry automatically. If the wrapper returned `outputDirectoryRemoved: true`, **Retry site creation** may reuse the same selected location. Otherwise, ask for a new empty directory using the same **Project Location** prompt, update `TEMPLATE_CLONE_OUTPUT_DIRECTORY`, and rerun the wrapper. If the user falls back to from-scratch, explain that local files, supporting solutions, or a partial site upload may remain and recommend `<SELECTED_TEMPLATE_VARIANT.framework>`.
   13. When clone, build, and upload succeed, mark **Clone, build, and upload template site** as `completed` and run `template_clone_success` telemetry silently:
       ```bash
       node "${PLUGIN_ROOT}/scripts/emit-create-site-template-outcome.js" \
         --eventName template_clone_success \
         --templateId "<SELECTED_TEMPLATE.id>" \
         --templateKind "<SELECTED_TEMPLATE.kind>" \
         --framework "<SELECTED_TEMPLATE_VARIANT.framework>" \
         --audience "<internal|external from Phase 1 discovery>"
       ```
       Do not include the site name, clone path, URL, or Website Record ID in telemetry.
   14. Mark **Show inactive template site** as `in_progress`. Tell the user: "Template `<displayName>` was created as `<IMPORTED_SITE_NAME>` (`<IMPORTED_WEBSITE_RECORD_ID>`). It is not activated yet. Seed-data processing is complete, and activation is next." If the template has no seed data, say that instead of implying records were inserted. Mark **Show inactive template site** as `completed`.
