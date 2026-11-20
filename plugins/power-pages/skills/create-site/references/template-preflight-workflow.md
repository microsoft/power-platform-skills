# Template preflight

8. For the template path only:

   1. Mark **Resolve target environment** as `in_progress`.
   2. Resolve the target environment via the shared auth helpers:
      ```bash
      node "${PLUGIN_ROOT}/scripts/resolve-template-import-context.js"
      ```
      Use the returned `environmentUrl` for the remaining template workflow. The PAC import wrapper uses the current PAC authentication with this explicit target URL; Dataverse preflight and seed helpers acquire Azure tokens internally so credentials are never returned in JSON or carried between tasks. If `ok: false`, surface the error and stop before import. Do not emit `template_import_failure` because no import was attempted; `template_used` was already emitted when the template path was selected.

<!-- gate: create-site:1.5.confirm-environment | category=consent | cancel-leaves=template-cache -->

> 🚦 **Gate (consent · create-site:1.5.confirm-environment):** Confirm the resolved target environment before running template install preflights.
>
> **Trigger:** Phase 1.5 after `resolve-template-import-context.js` returns `environmentUrl` and before any CLI-tenant, `.js` unblock, language, solution import, seed, or activation step.
> **Why we ask:** PAC auth can point at a different Dataverse environment than the user intended. Even preflights can inspect or modify environment-level settings, so the skill must not continue silently.
> **Cancel leaves:** `template-cache` — template catalog assets, the discovered solution sources, and website code may already be cached locally; no org mutation has happened if cancelled here.

   3. Mark **Resolve target environment** as `completed` and **Confirm target environment** as `in_progress`, then ask the user to confirm the resolved target environment before any environment preflight:

      Ask the user:

      | Question | Header | Options |
      |----------|--------|---------|
      | Use **`<environmentUrl>`** as the target environment for this template install? | Confirm Environment | Yes, use this environment (Recommended), No, start from scratch, Cancel |

      - **Yes**: continue to the preflight checks below.
      - **No, start from scratch**: set `CREATION_PATH = "from-scratch"` and continue to the deferred framework/location questions. Do not run environment preflights or import the template.
      - **Cancel**: stop before environment preflights. Do not emit `template_import_failure` because no import was attempted; `template_used` was already emitted when the template path was selected.

   4. Mark **Confirm target environment** as `completed` and **Validate CLI tenant alignment** as `in_progress`, then confirm PAC CLI and Azure CLI are authenticated to the same tenant before any import preflight that depends on both CLIs:
      ```bash
      node "${PLUGIN_ROOT}/scripts/validate-cli-tenant-alignment.js" --envUrl "<environmentUrl>"
      ```
      - **`ok: true`**: mark **Validate CLI tenant alignment** as `completed`.
      - **`ok: false`**: surface the error and the `pacTenantId`, `azTenantId`, and `tokenTenantId` fields when present. Stop before import and tell the user to switch either PAC auth or Azure CLI to the same tenant, then rerun the skill. Do not emit `template_import_failure` because no import was attempted.
   5. Mark both **Validate JavaScript unblock requirement** and **Validate Dataverse language requirements** as `in_progress`. Run the `.js` blocked-attachment dry run and the Dataverse language check in parallel because both are read-only preflights against the confirmed target environment:
      ```bash
      node "${PLUGIN_ROOT}/scripts/lib/fix-blocked-attachments.js" --envUrl "<environmentUrl>" --extensions js --dry-run --quiet
      node "${PLUGIN_ROOT}/scripts/check-available-languages.js" --envUrl "<environmentUrl>" --requiredLocaleIds "<SELECTED_TEMPLATE_VARIANT.requiredDataverseLanguages or SELECTED_TEMPLATE.requiredDataverseLanguages comma-separated>"
      ```
      Capture both JSON results before deciding what to do next. Do not mutate `blockedattachments` until the language check has also completed; if the language check blocks import, route to the language-requirement question without changing attachment settings.
      Evaluate the `.js` result:
      - **`wasBlocked` does not include `js`**: mark **Validate JavaScript unblock requirement** as `completed`; JavaScript attachments are allowed.
      - **`wasBlocked` includes `js`**: keep **Validate JavaScript unblock requirement** as `in_progress`; this may need the `.js` unblock consent gate below, but handle language failures first because they block import without any environment mutation.
      Evaluate the language result:
      - **`ok: true` and `hasRequiredLanguages: true`**: mark **Validate Dataverse language requirements** as `completed`; the target environment has every LCID required by the selected variant, falling back to the family requirements when the variant does not override them.
      - **`ok: false`**: tell the user the skill could not verify available Dataverse languages, surface the script error, then ask whether to switch to from-scratch or stop. Do not import the template and do not mutate `blockedattachments`.
      - **`ok: true` and `hasRequiredLanguages: false`**: explain that the selected template requires the missing Dataverse language LCIDs from `missingLocaleIds`. Block before any solution import mutation. Do not provide a "proceed anyway" branch and do not mutate `blockedattachments`.

<!-- gate: create-site:1.5.unblock-js | category=consent | cancel-leaves=attachment-block-modified -->

> 🚦 **Gate (consent · create-site:1.5.unblock-js):** Preflight unblock of `.js` from the target environment's `blockedattachments` setting before uploading website code.
>
> **Trigger:** Phase 1.5 when `fix-blocked-attachments.js --dry-run --extensions js` reports `.js` is blocked in the target environment.
> **Why we ask:** The packaged SPA is uploaded with `pac pages upload-code-site` after its supporting solutions are ready. That upload includes JavaScript files and fails when `.js` is blocked. Checking before solution import avoids leaving supporting artifacts behind when the site cannot be created.
> **Cancel leaves:** `attachment-block-modified` is possible only if the user approved and the update partially completed. Pure Cancel here leaves the original `blockedattachments` value untouched and no template installation has started.

      Ask the user:

      | Question | Header | Options |
      |----------|--------|---------|
      | This environment currently blocks `.js` attachments. The template site's code upload will fail unless `.js` is unblocked. Remove only `js` from `blockedattachments` now? | Unblock JavaScript | Yes, unblock `.js` and continue (Recommended), No, start from scratch, Cancel |

      - **Yes**: run the helper without `--dry-run`, preserving every other blocked extension:
        ```bash
        node "${PLUGIN_ROOT}/scripts/lib/fix-blocked-attachments.js" --envUrl "<environmentUrl>" --extensions js --quiet
        ```
        Confirm the JSON result has `removed` containing `js` or `changed: true`, then rerun the dry-run check and continue only if `.js` is no longer blocked.
      - **No, start from scratch**: set `CREATION_PATH = "from-scratch"` and continue to the deferred framework/location questions. Do not import the template.
      - **Cancel**: stop before template installation. Do not emit `template_import_failure` because no import was attempted; `template_used` was already emitted when the template path was selected.

<!-- not-a-gate: route selection after a blocking preflight; no org mutation has happened and there is no option to override missing template language requirements -->

    6. Only when the language preflight cannot continue:

       Ask the user:

       | Question | Header | Options |
       |----------|--------|---------|
       | This template requires Dataverse language LCID(s) `<requiredLocaleIds>`, but the target environment is missing `<missingLocaleIds>` or the language check could not be completed. What would you like to do? | Template Language Requirement | Start from scratch (Recommended), Cancel |

       - **Start from scratch**: set `CREATION_PATH = "from-scratch"` and continue to the deferred framework/location questions. Do not import the template.
       - **Cancel**: stop before template installation. Do not emit `template_import_failure` because no import was attempted; `template_used` was already emitted when the template path was selected.
