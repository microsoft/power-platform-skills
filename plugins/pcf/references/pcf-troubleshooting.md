# PCF troubleshooting

Entries use the diagnostic format required by the `/pcf` skill: **Symptom** → **Candidate causes** → **Discriminating checks** → **Fix** → **Verify**. Version scopes are included where behavior is tied to a measured release or documented prerequisite. General platform references: [debugging PCF](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/debugging-custom-controls), [best practices](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/code-components-best-practices), [manifest schema](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/), and [Power Pages PCF](https://learn.microsoft.com/en-us/power-pages/configure/component-framework).

## Setup

### Missing required tool

**Symptom**: `Missing required tool: node`, `Missing required tool: npm`, `Missing required tool: pac`, `Missing required tool: dotnet`, or `Missing required tool: az`.

**Candidate causes**: The selected mode needs a tool that is not installed, not on `PATH`, or not usable in the current shell. Build-only modes need Node/npm; `pac pcf push` needs PAC and MSBuild/.NET; environment verification and inventory need authenticated Azure CLI (`az`) plus SDK Dataverse reads, not PAC auth. PAC auth is a prerequisite only for push/package paths.

**Discriminating checks**: Run the doctor command for the same mode. Check `node --version`, `npm --version`, `pac help`, `dotnet --info` and `az account show` only for tools the mode needs.

**Fix**: Install the missing tool and reopen the shell so `PATH` is refreshed. For PCF, use the toolchain baseline in `pcf-hosts.md`, not a random global version.

**Verify**: Re-run `node "${PLUGIN_ROOT}/scripts/pcf-doctor.js" --needs <mode>` and confirm it reports the tool as found.

`pcf-doctor.js --needs` accepts `build` and `push`; `--hosts` accepts `model` and `pages`. Typos and empty comma lists fail before any tool probing so missing prerequisites are not silently downgraded.

### NuGet restore fails for Microsoft.PowerApps.MSBuild.Pcf

**Symptom**: Build or push output names `Microsoft.PowerApps.MSBuild.Pcf` and restore fails before packaging.

**Candidate causes**: NuGet.org is unavailable, a local NuGet configuration overrides public feeds, corporate proxy configuration blocks restore, or the SDK/MSBuild runtime is not available.

**Discriminating checks**: Inspect the restore section of the MSBuild log. Confirm the configured package sources include NuGet.org and that `dotnet restore` can reach the NuGet flat-container feed named in the matrix.

**Fix**: Restore public NuGet access or correct the local NuGet source configuration. Do not commit internal feed URLs to this public repo.

**Verify**: Re-run the same build command and confirm restore completes before PCF compilation starts.

### MSB4036

**Symptom**: MSBuild reports `MSB4036` during `pac pcf push` or solution packaging.

**Candidate causes**: A required MSBuild task from the PCF build package did not restore, the wrong MSBuild host is running, or the build is using an SDK that cannot load the restored task.

**Discriminating checks**: Check whether restore completed and whether the log references `Microsoft.PowerApps.MSBuild.Pcf`. Compare the .NET SDK with the recommended baseline in `pcf-hosts.md`.

**Fix**: Fix restore first, then use the recommended .NET SDK. If the failure persists, delete generated `bin`/`obj` folders and rebuild.

**Verify**: The build reaches `pcf-scripts build` and produces the expected solution package or push log.

## Scaffold and build

### [pcf-1041] Not a valid sub-command 'production'

**Symptom**: `[pcf-1041] Not a valid sub-command 'production'`.

**Candidate causes**: PowerShell consumed the argument separator before npm received it. This was reproduced in PowerShell 7.6.6 with npm 10 when `npm run build -- --buildMode production` was not passed as intended.

**Discriminating checks**: Inspect the command that reached `pcf-scripts`. If `production` appears as a positional subcommand instead of the value for `--buildMode`, the separator was lost.

**Fix**: Use the skill's `pcf-build.js` wrapper or invoke the resolved `pcf-scripts` bin with `process.execPath` so no shell re-parses `--`. If running manually, keep the exact npm separator syntax for your shell.

**Verify**: The build log shows `pcf-scripts build --buildMode production` and no `[pcf-1041]` line.

### [pcf-1014] manifest validation

**Symptom**: `[pcf-1014]` appears while validating `ControlManifest.Input.xml`.

**Candidate causes**: Invalid XML, a missing required attribute, an unsupported property type, duplicate property names, a bound property with a default value, or a platform-library declaration that conflicts with the control type.

**Discriminating checks**: Run the manifest gate and read the finding id, such as `PCF_ATTR_MISSING`, `PCF_PROPERTY_DUPLICATE`, `PCF_DEFAULT_ON_BOUND`, `PCF_TYPE_UNSUPPORTED`, `PCF_PAGES_VIRTUAL` or `PCF_PAGES_PLATFORM_LIBRARY`.

**Fix**: Correct the manifest against the [manifest schema](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/). For Pages, also apply the host rules in `pcf-hosts.md`.

**Verify**: `node "${PLUGIN_ROOT}/scripts/lint-pcf.js" --project <dir>` passes. Then run a production build through the project build command and confirm it passes.

If project lint reports that no `ControlManifest.Input.xml` files were found, pass the PCF project root or the exact manifest with `--manifest`; an empty result is a failed lint, not a successful project.

### Production build mode is set but ineffective

**Symptom**: The gate reports `PROJ_BUILDMODE_NOT_PRODUCTION` or says `PcfBuildMode` is set but ineffective — move it below the `Microsoft.Common.props` import.

**Candidate causes**: With the matrix's current `Microsoft.PowerApps.MSBuild.Pcf` package, Debug builds set `PcfBuildMode=development` after the first project property group. `pac pcf push` builds Debug, so an early property can be overwritten. Observed behavior on 2026-09-29: first property group still produced a development bundle, while a property group after the import produced a production bundle.

**Discriminating checks**: Inspect the `.pcfproj`. The effective `<PcfBuildMode>production</PcfBuildMode>` must appear after the `Microsoft.Common.props` import.

**Fix**: Let the `BUILDMODE_PRODUCTION` repair from `node "${PLUGIN_ROOT}/scripts/pcf-upgrade.js" --project <dir> --apply --steps BUILDMODE_PRODUCTION` place the property after the import, or make the same edit manually.

**Verify**: Re-run the project gate; then build and confirm the bundle size and mode match a production build.

### npm ERESOLVE after adding ESLint plugins

**Symptom**: `npm ERR! ERESOLVE` appears after adding or upgrading ESLint-related packages.

**Candidate causes**: The PCF toolchain pins peer dependency ranges. Adding an ESLint plugin from another major line can conflict with the template's ESLint and TypeScript packages.

**Discriminating checks**: Read the peer conflict in npm output. Compare changed `package.json` entries with the dependency set selected by the compatibility matrix.

**Fix**: Revert ad-hoc ESLint package changes and use the lockfile dependency set. If a lint rule is needed, update the matrix and lockfiles together in a separate reviewed change.

**Verify**: `npm ci` completes, then `npm run lint` and the PCF gates pass.

### Web resource content size is too big

**Symptom**: Import or push fails with `Web resource content size is too big`.

**Candidate causes**: A development bundle was deployed, large dependencies were bundled into a standard control, source maps or test data were included, or the control should use virtual platform libraries for model-driven apps.

**Discriminating checks**: Check the `bundle.js` size in `out/controls` or the solution ZIP. Confirm build mode is production. Compare standard versus virtual host support in `pcf-hosts.md`.

**Fix**: Produce a production build, remove unused dependencies, split optional assets, or use a virtual control where the target host supports platform libraries. Learn warns against deploying development builds: [best practices](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/code-components-best-practices#avoid-deploying-development-builds-to-dataverse).

**Verify**: Rebuild in production mode and re-import. The gate should report the bundle under the policy threshold.

### Solution checker web-avoid-eval rule

**Symptom**: Solution checker reports `web-avoid-eval` for the PCF bundle.

**Candidate causes**: The bundle or a dependency uses `eval`, `new Function`, string-based timers, or a development-source-map pattern that emits eval-like code. Solution checker performs static analysis on solution web resources: [solution checker](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/use-powerapps-checker).

**Discriminating checks**: Search the production bundle for `eval(` and inspect webpack devtool settings. Run the source gate for `PCF_CODE_EVAL`.

**Fix**: Use production build settings, replace the dependency or code path, and do not suppress the checker by hiding the string.

**Verify**: Run solution checker again and confirm `web-avoid-eval` is gone.

## Deploy and import

### Fluent platform library rejection

**Symptom**: Import fails with `platform library fluent_9_68_0 with version 9.68.0 is not supported by the platform.`

**Candidate causes**: A recent React template or dependency update declared a Fluent version that the platform rejects. The rendered platform-library table in `pcf-hosts.md` owns the current documented declarations, tooling-accepted ranges and observed exclusions.

**Discriminating checks**: Inspect `<platform-library name="Fluent" version="..." />` in the manifest. Run the manifest gate and look for `PCF_PLATFORM_LIB_KNOWN_BAD`.

**Fix**: Use the Fluent baseline from `pcf-hosts.md` / compatibility matrix and reinstall from the committed lockfile.

**Verify**: Rebuild and push/import. The registration read-back should show the expected manifest version.

### Import succeeded but the old version runs

**Symptom**: Import or push reports success, but the app still runs the old bundle.

**Candidate causes**: The manifest version did not change, publish did not reach the target form/app, browser cache still has old scripts, or the user is viewing another app/form binding.

**Discriminating checks**: Compare the manifest version, registration read-back, bound form, published layer and browser network response. The probe in this release found same-version byte replacement inconclusive, so do not assume it refreshed.

**Fix**: Bump the component version, publish the form/app, and hard refresh the browser. For release packaging, also bump the solution version.

**Verify**: `verify-pcf.js` reaches `registered` and `bound(published)`, and the browser network response contains the new bundle.

### Managed control or solution refuses update/delete

**Symptom**: Update, replace, delete or unbind fails because the component, form or solution is managed.

**Candidate causes**: The artifact came from a managed solution, or a managed layer owns the form/control dependency.

**Discriminating checks**: Read `ismanaged` for the control/form solution component and inspect solution layers in Maker.

**Fix**: Update through the owning managed solution, or perform unbind/delete in an unmanaged development environment before producing a managed release. Do not directly edit managed artifacts.

**Verify**: The operation succeeds in the correct unmanaged source environment or through a new managed solution version.

### Bound control cannot be deleted

**Symptom**: `The CustomControl({…}) component cannot be deleted because it is referenced by 1 other components. For a list of referenced components, use the RetrieveDependenciesForDeleteRequest.`

**Candidate causes**: A form, grid or other solution component still references the control. Observed on 2026-09-29 when deleting a bound control.

**Discriminating checks**: Run inventory / where-used. Its output is registered solution dependencies only — not proof of Liquid or text references; an empty result is not "safe to delete". Also inspect known forms and Pages Liquid references.

**Fix**: Unbind the control, publish the changed artifact, verify dependencies again, then delete.

**Verify**: `pcf-inventory.js` no longer reports registered dependencies, the form no longer references the control, and delete succeeds.

### Dataverse rejects an OData `in` operator

**Symptom**: `verify-pcf.js` fails a Dataverse read with HTTP 501 and `The query node In is not supported`.

**Candidate causes**: The Dataverse endpoint rejected an OData `in` filter. Some OData surfaces accept `in`, but this metadata path requires an explicit `or` expression instead.

**Discriminating checks**: Inspect the JSON failure object from `verify-pcf.js` and the emitted request filter. A failing form lookup usually shows a filter shaped like `type in (2,7)`.

**Fix**: Use the current verifier, which emits `(type eq 2 or type eq 7)` for form-type filtering. If you own custom verification code, replace `in` with equivalent `or` comparisons for this Dataverse metadata query.

**Verify**: Re-run `verify-pcf.js`; it should read draft and published form metadata instead of returning the HTTP 501 OData error.

### Push fails while publishing all customizations with SQL 1205

**Symptom**: `pac pcf push` imports the temporary solution, then fails at `Publishing All Customizations...` with `Sql error: Generic SQL error. CRM ErrorCode: -2147204784 Sql ErrorCode: -2146232060 Sql Number: 1205`. `pcf-push.js` returns `ok: false` with a deadlock hint.

**Candidate causes**: SQL Server error 1205 means the server chose this transaction as a deadlock victim ([MSSQLSERVER_1205](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-1205-database-engine-error)). On a shared environment this happens when another import or publish is running at the same time. Observed on 2026-09-29 on a shared test environment during a concurrent publish. It is not caused by the project.

**Discriminating checks**: The pac output shows `Importing the temporary solution wrapper into the current org: done.` before the error, so the build and import succeeded. `pcf-inventory.js --control <prefix>_<namespace>.<constructor>` shows whether the control is already registered. HTTP 429 responses from the same environment around the same time point to the same contention.

**Fix**: Wait a minute, then re-run the same `pcf-push.js` command. If the environment stays busy, publish from Maker (**Publish all customizations**) once it is quiet, or push to a less contended development environment. Do not change the project to work around it.

**Verify**: The re-run push returns `ok: true` with a registration read-back whose version matches the manifest.

## Binding

### Custom control declaration for form factor(s) 0,1 is missing

**Symptom**: `Custom control declaration for form factor(s) 0,1 is missing for control with uniqueid {…}.`

**Candidate causes**: The FormXML binding declared only web (`formFactor="2"`) or otherwise omitted phone/tablet factors. Observed on 2026-09-29: a web-only declaration was rejected at form write with HTTP 400.

**Discriminating checks**: Inspect the binding XML or verifier output for `PCF_BIND_FACTOR_UNDECLARED`. Remember this is distinct from runtime `context.client.getFormFactor()` values: [getFormFactor](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/client/getformfactor).

**Fix**: Emit all three FormXML factors: phone `0`, tablet `1`, web `2`. Use semantic clients (`phone`, `tablet`, `web`) at user-facing boundaries and let the verifier map them.

**Verify**: `verify-pcf.js` reports no `PCF_BIND_FACTOR_UNDECLARED`, and a published form read preserves the binding.

### PCF_BIND_FORCONTROL_CASE

**Symptom**: The verifier reports `PCF_BIND_FORCONTROL_CASE`.

**Candidate causes**: The `controlDescription forControl` value and the cell `uniqueid` differ only by GUID casing. In current probes, GUID comparison for this join behaved case-insensitively, so the finding is informational until a platform probe shows orphaning.

**Discriminating checks**: Compare the two GUIDs character-for-character and case-insensitively.

**Fix**: Normalize emitted GUID casing when rewriting bindings; do not hand-edit FormXML to chase this finding alone.

**Verify**: Re-run verify. If the binding otherwise matches, treat this as info.

## Runtime

### Error loading control

**Symptom**: The app shows `Error loading control`.

**Candidate causes**: The control threw during `init` or `updateView`; the record is new/unsaved and required id inputs are missing; a bound value is temporarily null; a BigInt-like column value is mishandled; a required feature is unavailable; the user lacks field read permission; the bundle is stale; or import used an unsupported manifest/platform-library combination.

**Discriminating checks**: Open browser developer tools, inspect the console and network, and compare the running bundle with the registered version. The Learn debugging article explains browser and deployed debugging: [debugging](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/debugging-custom-controls).

| Observation | Cause | Fix |
| --- | --- | --- |
| Console stack or `TypeError` in `init` / `updateView` | Code crash, including unsafe parsing of a BigInt-like column | Reproduce with the same parameter value in a unit test, add null/type guards, and render a recoverable error state. |
| No record id / configured `entityId` is empty | New unsaved record | Render a disabled unsaved-record state. Do not read internal context for a record id. |
| Parameter object is missing, `raw` is null, or `security.readable` / `security.editable` is false | Null-first or field-security path | Render empty/loading/permission states and avoid leaking the raw value. |
| Registration/import log shows a manifest or platform-library rejection | Unsupported manifest or platform-library version | Use the manifest/platform-library troubleshooting entry and the `pcf-hosts.md` tables. |
| Network tab loads an older bundle than the registered version | Cache or old-version path | Use the "Import succeeded but the old version runs" entry. |

**Fix**: Apply the concrete fix from the table for the discriminating observation. For current-record needs, pass `entityId` and `entityName` as configured inputs instead of using internal context.

**Verify**: Load an existing record, a new unsaved record, a user without field read permission, and two instances on one page. The control should not crash.

### Harness Web API not implemented

**Symptom**: The local harness throws `not implemented` when code calls `context.webAPI`, dataset paging, sorting or filtering.

**Candidate causes**: The test harness does not implement every host API. Learn lists WebAPI, paging, sorting, filtering, choices/lookups and model-driven APIs as common harness limitations.

**Discriminating checks**: Confirm the same code path works after deployment or behind a test adapter. Check whether the failure occurs only under `npm start` / `pcf-start`.

**Fix**: Keep unit tests around adapters and run deployed smoke tests for WebAPI/paging behavior. Do not delete WebAPI code merely to make the harness pass.

**Verify**: Unit tests pass with adapters, and deployed smoke reaches the API under the target host.

### Dataset refresh loop or page reset

**Symptom**: A dataset control reloads repeatedly or jumps back to page 1 after user actions.

**Candidate causes**: `dataset.refresh()` is called from `updateView`, paging calls run in parallel, or refresh is used where a local state update would suffice. Learn states `refresh will reset paging to page 1` and does not support parallel execution.

**Discriminating checks**: Log `updatedProperties`, paging state and refresh calls. Look for refresh triggered by the very update that refresh caused.

**Fix**: Gate refresh behind explicit user actions or changed filter/sort inputs. Serialize paging calls and debounce search.

**Verify**: Paging next/previous, sorting and refresh tests pass without duplicate loads or unexpected page resets.

## Power Pages

### Pages virtual control does not render

**Symptom**: A Power Pages field/list/Liquid PCF area is blank or falls back after deploying a virtual control.

**Candidate causes**: Power Pages does not support React controls and platform libraries. Learn states React controls and platform libraries are not supported with Power Pages, and the plugin emits `Power Pages does not support platform-library declarations`.

**Discriminating checks**: Inspect the manifest for `control-type="virtual"` or `<platform-library>`. Check the Pages site version and feature prerequisites in `pcf-hosts.md`.

**Fix**: Use a standard control bundle for Power Pages, remove platform libraries, and guard unsupported APIs such as `Utility` and `Device.*`.

**Verify**: The Pages lint profile passes and the control renders on the target site.

### Pages list falls back to the default grid

**Symptom**: A Power Pages list uses the default grid instead of the PCF control.

**Candidate causes**: The list is not configured with `Use a configured code component`, the model-driven side has only a form sub-grid binding instead of a view/table control configuration, the site/base package prerequisite is not met, or Pages server cache has not refreshed.

**Discriminating checks**: In Portal Management, inspect the list record and the view/table control configuration. Confirm the dataset prerequisites in the matrix-rendered table in `pcf-hosts.md`.

**Fix**: Configure the list with `Use a configured code component = Yes` and ensure the view/table has the control configuration. Wait for cache propagation or clear cache when appropriate.

**Verify**: Reload the site as a permitted user and confirm the PCF grid renders; test paging and selection.

### Pages Web API request fails

**Symptom**: A PCF on Power Pages fails to read or write records through `context.webAPI` or raw `/_api` calls.

**Candidate causes**: Missing per-table Web API site settings, use of `*` in `Webapi/<table>/fields`, missing table permissions/web roles, wrong entity-set name in raw AJAX, or missing CSRF token for raw AJAX. Learn says the wildcard is deprecated and requests fail until explicit columns or `UseFieldsFromView` are configured.

**Discriminating checks**: Check `Webapi/<logical-name>/enabled`, `Webapi/<logical-name>/fields`, `Webapi/<logical-name>/UseFieldsFromView`, the **Power Pages Web API Columns** view, table permissions, web roles and browser network responses. Learn distinguishes logical name for site settings from EntitySetName for Web API URLs: [Web API overview](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview).

**Fix**: Use logical names in site settings, explicit columns or the exact **Power Pages Web API Columns** view, correct table permissions and EntitySetName in URLs. Include the CSRF token only for raw AJAX; PCF `context.webAPI` handles its own host path.

**Verify**: A permitted user succeeds, a denied user fails safely, and changes to the view propagate after the documented delay.
