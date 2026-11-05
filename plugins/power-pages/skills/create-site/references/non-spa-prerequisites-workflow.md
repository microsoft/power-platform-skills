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

   Ask the user:

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

   Ask the user:

   Confirm the resolved environment before continuing.

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

   Ask the user:

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
