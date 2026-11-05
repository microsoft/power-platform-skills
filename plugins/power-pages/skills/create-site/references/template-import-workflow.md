# Template import

6. Render and open a read-only status page:
      ```bash
      # Create <temp-import-status-dir>/ under the operating-system temporary directory,
      # then write this initial status JSON to <temp-import-status-dir>/status.json:
      # Import path:
      # Use "Installing solution" when TEMPLATE_SOLUTIONS_TO_IMPORT has one entry,
      # otherwise use "Installing solutions":
      # { "state": "running", "phase": "solution", "message": "<solution install label>" }
      # SKIP_TEMPLATE_SOLUTION_IMPORT path:
      # { "state": "running", "phase": "site", "message": "Preparing template site" }
      node "${PLUGIN_ROOT}/scripts/render-template-import-status.js" \
        --templateName "<SELECTED_TEMPLATE.displayName>" \
        --templateDescription "<SELECTED_TEMPLATE.description>" \
        --statusPath "<temp-import-status-dir>/status.json" \
        --previewImagesJson '<JSON array of SELECTED_TEMPLATE.previewImages localUrl values from the template browser step>' \
        --solutionCount "<TEMPLATE_SOLUTIONS_TO_IMPORT.length, or SELECTED_TEMPLATE_SOLUTIONS.length when imports are skipped>" \
        --outputPath "<temp-import-status-dir>/index.html"
      node "${PLUGIN_ROOT}/scripts/serve-static-dir.js" --root "<temp-import-status-dir>" --urlFile "<temp-import-status-dir>/url.txt" --cleanupRoot
      node "${PLUGIN_ROOT}/scripts/open-url.js" --url "<url from <temp-import-status-dir>/url.txt>"
      ```
      Reuse the already-downloaded local preview image URLs from the browser step; do not fetch preview images again for this page.
      The server command returns only after the listener is ready. It removes the temporary status directory after a successful redirect, after the browser stops polling, or when the maximum lifetime expires.
   7. Unless `SKIP_TEMPLATE_SOLUTION_IMPORT = true`, mark **Import template supporting solutions** as `in_progress`. Process `TEMPLATE_SOLUTIONS_TO_IMPORT` sequentially in its existing case-insensitive lexical unique-name order. For each entry, set `CURRENT_TEMPLATE_SOLUTION` and prepare its unmanaged solution for import:
      ```bash
      # Update the status JSON:
      # { "state": "running", "phase": "solution", "message": "Preparing solution <CURRENT_TEMPLATE_SOLUTION.uniqueName>" }
      node "${PLUGIN_ROOT}/scripts/pack-template-solution.js" \
        --solutionPath "<CURRENT_TEMPLATE_SOLUTION.solutionPath>"
      ```
      Set `PACKED_TEMPLATE_SOLUTION_ZIP = <result.zipPath>`, `PACKED_TEMPLATE_SOLUTION_WORK_DIRECTORY = <result.workDirectory>`, `PACKED_TEMPLATE_SOLUTION_CLEANUP_MARKER = <result.cleanupMarker>`, and `PACKED_TEMPLATE_SOLUTION_CLEANUP_TOKEN = <result.cleanupToken>` for the current solution. The packer creates the ZIP only in a token-owned OS temporary directory. Never write a packed ZIP into the downloaded template cache or another repository path.

      If packing fails, do not call Dataverse and do not emit `template_import_failure` because no import was attempted. The packer removes partial output automatically.

      <!-- gate: create-site:1.5.pack-failed | category=progress | cancel-leaves=template-cache -->

      > 🚦 **Gate (progress · create-site:1.5.pack-failed):** Choose how to proceed after preparing the local solution package fails.
      >
      > **Trigger:** Phase 1.5 when local validation or `pac solution pack` fails for one discovered solution.
      > **Loop behavior:** Fires per failed iteration of `TEMPLATE_SOLUTIONS_TO_IMPORT`; an answer applies only to `CURRENT_TEMPLATE_SOLUTION`.
      > **Why we ask:** No environment mutation has happened, but template installation cannot continue without a valid temporary solution ZIP.
      > **Cancel leaves:** `template-cache` — downloaded template source remains in the private SHA-keyed template cache; partial pack output has been removed.

      Ask the user:

      | Question | Header | Options |
      |----------|--------|---------|
      | Solution `<CURRENT_TEMPLATE_SOLUTION.uniqueName>` could not be prepared for import. How would you like to proceed? | Template Pack Failed | Retry packing, Fall back to from-scratch (Recommended), Stop |

      - **Retry packing**: return to the pack command above.
      - **Fall back to from-scratch**: set `CREATION_PATH = "from-scratch"` and continue to the deferred framework/location questions.
      - **Stop**: stop after showing the local pack error. Do not mark **Import template supporting solutions** as completed.

      After packing succeeds, import the temporary ZIP with the PAC CLI wrapper. Do not invoke `/import-solution` or write ALM artifacts.
      The solution-level `publishChanges` value comes from the pinned template manifest.
      The wrapper adds `pac solution import --publish-changes` only when that value is true:
      ```json
      { "state": "running", "phase": "solution", "message": "Importing solution <CURRENT_TEMPLATE_SOLUTION.uniqueName>" }
      ```
      Write that object to `<temp-import-status-dir>/status.json`, then run the import wrapper in background work when supported, otherwise synchronously:
      ```bash
      node "${PLUGIN_ROOT}/scripts/import-template-solution.js" \
        --zipPath "<PACKED_TEMPLATE_SOLUTION_ZIP>" \
        --envUrl "<environmentUrl>" \
        --publishChanges "<CURRENT_TEMPLATE_SOLUTION.publishChanges>"
      ```
      The work must return the wrapper's complete JSON result.
      When it finishes, clean the owned temporary directory in the main conversation:
      ```bash
      node "${PLUGIN_ROOT}/scripts/pack-template-solution.js" \
        --cleanup \
        --workDirectory "<PACKED_TEMPLATE_SOLUTION_WORK_DIRECTORY>" \
        --cleanupMarker "<PACKED_TEMPLATE_SOLUTION_CLEANUP_MARKER>" \
        --cleanupToken "<PACKED_TEMPLATE_SOLUTION_CLEANUP_TOKEN>"
      ```
      Always run the owned temporary-directory cleanup after the import command returns.
      Treat a cleanup failure as a local warning and show the work-directory path so the user can remove it manually; do not hide the import result.
      Do not start the next solution import until the current command returns `ok: true`, and do not start site cloning until every solution in `TEMPLATE_SOLUTIONS_TO_IMPORT` succeeds.
      If the import wrapper returns `ok: false`, do **not** auto-clean up the unmanaged partial import.
      Run the `template_import_failure` telemetry command silently before asking the recovery question.
      Do not mention this telemetry command to the user and do not print its output:
      ```bash
      node "${PLUGIN_ROOT}/scripts/emit-create-site-template-outcome.js" \
        --eventName template_import_failure \
        --templateId "<SELECTED_TEMPLATE.id>" \
        --templateKind "<SELECTED_TEMPLATE.kind>" \
        --framework "<SELECTED_TEMPLATE_VARIANT.framework>" \
        --audience "<internal|external from Phase 1 discovery>" \
        --outcome failure \
        --errorClass "PacSolutionImport"
      ```
      `--audience` is the site audience captured in Phase 1 (`internal` or `external`), **not** the template's `audience` persona array from the catalog manifest. Do not add free-form error text to telemetry; it can contain paths, URLs, stack traces, or user data.

      <!-- gate: create-site:1.5.import-failed | category=progress | cancel-leaves=partial-unmanaged-template-import -->

      > 🚦 **Gate (progress · create-site:1.5.import-failed):** Choose how to proceed after template solution import fails.
      >
      > **Trigger:** Phase 1.5 when `pac solution import` fails or times out.
      > **Loop behavior:** Fires per failed iteration of `TEMPLATE_SOLUTIONS_TO_IMPORT`; an answer applies only to `CURRENT_TEMPLATE_SOLUTION`.
      > **Why we ask:** The environment may contain the current partial unmanaged import plus any earlier solutions imported during this run. A local timeout does not cancel an already-started server import, so retrying or switching paths should be an explicit choice.
      > **Cancel leaves:** `partial-unmanaged-template-import` — downloaded template artifacts remain in the private SHA-keyed template cache; the current partial import and any earlier successful solution imports remain in Dataverse and are explained in the error summary.

      Ask the user:

      | Question | Header | Options |
      |----------|--------|---------|
      | Supporting solution `<CURRENT_TEMPLATE_SOLUTION.uniqueName>` failed or partially completed. How would you like to proceed? | Template Import Failed | Retry import, Fall back to from-scratch (Recommended), Stop |

      Branch on the answer:
      - **Retry import**: return to the pack-and-import command sequence above.
      - **Fall back to from-scratch**: set `CREATION_PATH = "from-scratch"` and continue to the deferred framework/location questions. Tell the user the unmanaged partial import may remain in Dataverse. The eventual from-scratch branch emits the single terminal telemetry event.
      - **Stop**: stop after showing the error summary. Do not mark **Import template supporting solutions** as completed and do not clone or upload the site. The `template_import_failure` event was already emitted when the import failure was detected.

      If the error is `AttachmentBlocked`, point to `/import-solution` Phase 5b remediation.
      Only continue to the next step when the import wrapper returns `ok: true`.
   8. When every required solution import succeeds, continue to seed planning and site provisioning.
      Mark **Import template supporting solutions** as `completed` and set `EMIT_TEMPLATE_IMPORT_SUCCESS = true` only after these checks.
      Defer that telemetry event until the seed-data workstream joins so `seedApplied` reflects this run.
      If every solution import was skipped, mark the task as skipped and set `EMIT_TEMPLATE_IMPORT_SUCCESS = false`.
