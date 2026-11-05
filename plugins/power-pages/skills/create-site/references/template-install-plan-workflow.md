# Template install plan

<!-- gate: create-site:1.5.template-import | category=consent | cancel-leaves=template-cache -->

> 🚦 **Gate (consent · create-site:1.5.template-import):** Confirm installing the selected template in the current Power Platform environment.
>
> **Trigger:** Phase 1.5 after the template variant and its unpacked solutions are downloaded and the target environment is resolved.
> **Why we ask:** The install can import unmanaged supporting solutions and create a new code site. Choosing the wrong environment or template is disruptive and cannot be cleanly undone.
> **Cancel leaves:** `template-cache` — the discovered solution sources and preview images may remain in the private SHA-keyed template cache; no org mutation has occurred.

   7. If the language preflight passed but `.js` was blocked and the user approved/verification passed, mark **Validate JavaScript unblock requirement** as `completed`. Then mark **Confirm template install** as `in_progress`, present the template and environment, and ask:

      List any supporting solution whose manifest metadata has `publishChanges: true`.
      Explain that those solutions use `pac solution import --publish-changes` so imported forms, views, and other customizations become visible immediately after import.
      Disclose that PAC's publication step can also publish other pending customizations in the target environment.

      Ask the user:

      | Question | Header | Options |
      |----------|--------|---------|
      | Install **`<SELECTED_TEMPLATE.displayName>`** into **`<environmentUrl>`**? This imports any required unmanaged supporting solutions, runs PAC's publish-changes step for solutions that declare it in the template manifest, clones and builds the website code, and uploads the new code site. The publication step can include other pending customizations in this environment. Seed data is applied before activation when available. | Install Template | Yes, install this template (Recommended), No, start from scratch, Cancel |

      - **No, start from scratch**: set `CREATION_PATH = "from-scratch"` and continue to the deferred framework/location questions.
      - **Cancel**: stop; no org mutation has happened. Do not emit `template_import_failure` because no import was attempted; `template_used` was already emitted when the template path was selected.
   8. Mark **Confirm template install** as `completed`. Initialize `TEMPLATE_SOLUTIONS_TO_IMPORT = []` and `TEMPLATE_SOLUTIONS_TO_SKIP = []`, then process every entry in `SELECTED_TEMPLATE_SOLUTIONS` in the returned order:
      ```bash
      node "${PLUGIN_ROOT}/scripts/inspect-template-solution.js" --solutionPath "<solution.solutionPath>"
      node "${PLUGIN_ROOT}/scripts/check-solution-installed.js" --solutionName "<solution.uniqueName>" --envUrl "<environmentUrl>"
      node "${PLUGIN_ROOT}/scripts/inspect-template-solution.js" --solutionPath "<solution.solutionPath>" --installed "<true|false>" --installedVersion "<version-or-empty>"
      ```
      Do not derive a website name from a solution or expect supporting-solution import to add a `pac pages list -v` row. If metadata inspection returns `ok: false` after variant validation, or `check-solution-installed.js` exits 1, treat that solution as `decision: "ask"` rather than assuming it is absent.
      - **`decision: "import"`**: append the solution to `TEMPLATE_SOLUTIONS_TO_IMPORT`.
      - **`decision: "confirm-update"`**: tell the user that this specific solution has a newer version available and confirm before adding it to `TEMPLATE_SOLUTIONS_TO_IMPORT`.

        <!-- gate: create-site:1.5.update-installed | category=consent | cancel-leaves=template-cache -->

        > 🚦 **Gate (consent · create-site:1.5.update-installed):** Confirm updating an already-installed unmanaged template solution. Repeat for each solution that needs an update.
        >
        > **Trigger:** Phase 1.5 when one of the selected template solutions is already installed and the downloaded source has a newer version.
        > **Loop behavior:** Fires once per matching entry in `SELECTED_TEMPLATE_SOLUTIONS`; three solutions needing updates require three confirmations.
        > **Why we ask:** Updating an unmanaged solution merges changes into the environment and cannot be cleanly rolled back.
        > **Cancel leaves:** `template-cache` — downloaded template artifacts remain in the private SHA-keyed template cache; no org mutation happens if cancelled.

        Ask the user:

        | Question | Header | Options |
        |----------|--------|---------|
        | Solution `<solution.uniqueName>` is installed at version `<installedVersion>`, and the template contains `<availableVersion>`. Update it in this environment? | Update Solution | Yes, update this solution (Recommended), No, cancel |

        If the user declines or cancels, stop before import; no org mutation has happened. Do not emit `template_import_failure` because no import was attempted; `template_used` was already emitted when the template path was selected.
        If the user confirms, append this solution to `TEMPLATE_SOLUTIONS_TO_IMPORT`.
      - **`decision: "offer-clone"`**: append the same-or-newer solution to `TEMPLATE_SOLUTIONS_TO_SKIP`.
      - **`decision: "ask"`** or detection failure: ask whether to import that solution anyway, start from scratch, or stop.

        <!-- gate: create-site:1.5.reinstall-unknown | category=consent | cancel-leaves=template-cache -->

        > 🚦 **Gate (consent · create-site:1.5.reinstall-unknown):** Confirm whether to import when installed-solution detection failed.
        >
        > **Trigger:** Phase 1.5 when `check-solution-installed.js` cannot determine whether one selected template solution already exists.
        > **Loop behavior:** Fires once per unknown entry in `SELECTED_TEMPLATE_SOLUTIONS`; an answer applies only to the named solution.
        > **Why we ask:** Importing an unmanaged solution that may already exist can merge components.
        > **Cancel leaves:** `template-cache` — downloaded template artifacts remain in the private SHA-keyed template cache; no org mutation happens if cancelled.

        Ask the user:

        | Question | Header | Options |
        |----------|--------|---------|
        | I couldn't determine whether solution `<solution.uniqueName>` is installed. Importing it may merge unmanaged components. How would you like to proceed? | Solution Install Unknown | Import anyway (advanced), Start from scratch (Recommended), Stop |

        Branch on the answer:
        - **Import anyway**: append this solution to `TEMPLATE_SOLUTIONS_TO_IMPORT`.
        - **Start from scratch**: set `CREATION_PATH = "from-scratch"` and continue to the deferred framework/location questions.
        - **Stop**: stop before import; no org mutation has happened. Do not emit `template_import_failure` because no import was attempted; `template_used` was already emitted when the template path was selected.

      Append the full site-install tasks.
      Include **Import template supporting solutions** only when `TEMPLATE_SOLUTIONS_TO_IMPORT` is non-empty.
      If every solution was skipped, ask once before creating the site:

      <!-- gate: create-site:1.5.clone-existing | category=consent | cancel-leaves=template-cache -->

      > 🚦 **Gate (consent · create-site:1.5.clone-existing):** Confirm creating a new site while reusing already-installed supporting solutions.
      >
      > **Trigger:** Phase 1.5 when every selected template solution is installed at the same or a newer version.
      > **Why we ask:** The skill will skip all solution imports but still clone and upload a new code site.
      > **Cancel leaves:** `template-cache` — downloaded template artifacts remain in the private SHA-keyed template cache; no site clone/upload happens if cancelled.

      Ask the user:

      | Question | Header | Options |
      |----------|--------|---------|
      | All supporting solutions are already installed at the same or newer versions. Create a new `<SELECTED_TEMPLATE_VARIANT.framework>` site from the website code? | Create Template Site | Yes, create the site (Recommended), No, cancel |

      If the user confirms, set `SKIP_TEMPLATE_SOLUTION_IMPORT = true`. If the user declines, stop. Do not emit an import result event because no solution import was attempted.
