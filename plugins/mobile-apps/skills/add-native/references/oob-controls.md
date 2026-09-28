# Microsoft Out-of-Box (OOB) Native Controls

This is the canonical allowlist and use-case map for Microsoft native controls added on demand to a Power Apps mobile app. The planner, `/add-native`, its implementation helpers, and dependency validation must use this file. Do not infer permission from a package namespace or from a package being available on npm.

## Allowed controls

Only a requested control in this table may be added to the app's runtime `dependencies` when absent from the base template. Do not install every row. The dependency validator reads the marked table below; keep its header, columns, backticks, and markers intact.

If neither the user's request nor the approved plan requires a listed control, leave `package.json` and its lockfile unchanged. Table membership permits selection; it is not consent to install. The validator checks permitted package names, while the skill's request/approval gate owns whether an addition should occur.

<!-- microsoft-native-controls:start -->
| Use case | Capability | Package | Dependency spec | Helper |
|---|---|---|---|---|
| Open or preview an HTTPS or local file PDF | `pdf-viewer` | `@microsoft/power-apps-native-pdf-viewer` | `^0.2.9` | `add-pdf-viewer` |
| Capture a signature, freehand ink, drawing, or handwritten sign-off | `pen-input` | `@microsoft/power-apps-native-pen-input` | `^0.1.9` | `add-pen-input` |
| Explicitly requested Microsoft barcode or QR scanning control | `native-barcode-scanner` | `@microsoft/power-apps-native-barcode-scanner` | `^1.1.4` | `add-barcode-scanner` |
| Continuous or background GPS tracking with durable Dataverse sync | `geolocation` | `@microsoft/power-apps-native-bglocation` | `*` | `add-geolocation` |
<!-- microsoft-native-controls:end -->

Use the matching helper under `skills/add-native/<Helper>/SKILL.md` inside `/add-native`; do not ask users to invoke internal helpers directly:

- [PDF viewer](../add-pdf-viewer/SKILL.md): inspect the installed API for the requested HTTPS or `file://` input support; do not gate on a hardcoded version number. This is not PDF generation or picking/uploading a document. Use template-shipped `expo-print` for report generation and `expo-document-picker` or the host File control for picking.
- [Pen input](../add-pen-input/SKILL.md): returns a PNG data URI. Plan storage and cancellation/error handling; it is not a generic form input replacement.
- [Microsoft barcode scanner](../add-barcode-scanner/SKILL.md): only when the user explicitly requests the Microsoft control, its package, or `native-barcode-scanner`. Generic barcode/QR requests retain the existing `barcode-scanner`/`qr-scanner` Expo camera flow, including embedded/custom previews. Do not migrate existing scanner screens implicitly.
- [Background location](../add-geolocation/SKILL.md): use only for continuous/background tracking or durable location upload, with the helper's MSAL and existing Dataverse table/column checks. A single foreground coordinate read uses template-shipped `expo-location` instead.

The `Dependency spec` values are defaults for new additions, not version allowlists. Eligibility is based on the exact **package name only**. Do not reject, upgrade, downgrade, or rewrite an existing control dependency because its declaration or installed version differs from this table. Preserve the listed caret ranges and background-location `*` when adding a missing dependency; the lockfile records the resolved version. In particular, `*` can resolve a newer release on a future install without a lockfile. Check the package's actual API/peer compatibility, not an exact version match or a hardcoded minimum-version gate.

**Unlisted native controls remain blocked.** An unlisted `@microsoft/power-apps-native-*` package must already be part of the template baseline; it cannot use this on-demand exception. Template-shipped host/offline dependencies remain allowed. Other native packages remain template-bound and runtime bans still apply. These controls are not pure-JavaScript dependencies and must not bypass the native boundary through a JS-only approval.

## Dependency setup

1. Require a user-requested capability or its approved `Native Capabilities` plan row. A plan-only invocation never installs or changes manifests. Work in the app's `--working-dir`, not `${PLUGIN_ROOT}/template`.
2. Read the app's `package.json`, lockfile, and installed package metadata first. Reuse an existing runtime dependency without changing its version or declaration. If it is declared but not installed, stop and request the normal project dependency restore rather than silently updating its version. A differing version is not a failure. If the installed package demonstrably lacks an API required by the requested feature, explain that specific API limitation and ask how to proceed; do not infer it from a version mismatch or silently change versions.
3. For a missing runtime dependency, select only the requested row and its dependency spec. If the package already exists only in `devDependencies`, preserve its compatible declaration and locked version when moving it to runtime `dependencies`; do not silently re-resolve it. Check the published metadata for the selected spec against the app's React, React Native, and extension SDK versions before installing:

   ```bash
   CONTROL_PACKAGE="<exact package from the selected row>"
   CONTROL_SPEC="<dependency spec from the selected row>"
   npm view "$CONTROL_PACKAGE@$CONTROL_SPEC" version peerDependencies engines --json
   ```

   Show the package/spec, resolved candidate version, and manifest/lockfile impact. Reuse approval when that dependency change was already approved; otherwise confirm it before installing. A registry, authentication, or peer-compatibility failure is a block, not permission to switch feeds, add other native dependencies, use `--force`/`--legacy-peer-deps`, or modify native configuration.
4. Add the dependency with npm from the app root. This updates both `package.json` and the npm lockfile; never hand-edit the lockfile:

   ```bash
   npm pkg set "dependencies.$CONTROL_PACKAGE=$CONTROL_SPEC"
   npm install
   ```

   Setting the manifest first preserves the declared `*` or caret range; `npm install <name>@* --save-exact` would incorrectly replace it with an exact version. For a dev-only dependency, move its existing declaration instead of duplicating it in both sections. Do not run `npm update`, install all controls, or run Expo prebuild, CocoaPods, or Gradle. If the install fails, show the error, inspect any manifest/lockfile changes, and stop before generating imports or reporting success.
5. Verify `dependencies` contains the selected spec after an addition, the lockfile's root declaration agrees, the resolved installed version satisfies that spec and peer requirements, and the installed package resolves:

   ```bash
   npm ls "$CONTROL_PACKAGE" --depth=0
   node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" \
     --project-root "<working_dir>" \
     --file package.json
   ```

   Set `CONTROL_PACKAGE` for this check even when reusing an existing dependency. Forward any existing `--approved-js-dependency` rows from the approved JavaScript dependency plan to the validator, as required by the [JavaScript dependency installation contract](../../../shared/references/javascript-dependency-planning.md#installation-contract). Inspect the diff for unrelated dependency changes; do not silently retain unrelated upgrades. Continue to the helper's API checks and wrapper generation only after dependency verification passes, then type-check.
6. Report the package/version as **added**, **moved to runtime dependencies**, or **already present**, and include manifest/lockfile changes in the changed-file gate. Keep `app.config.js` and platform projects unchanged. npm installation and TypeScript success do **not** verify native availability in the running player/rewrap binary. Preserve `NATIVE_MODULE_MISSING`/unsupported handling; if native support is absent, stop and explain that a compatible player/runtime is required outside this workflow. Do not patch packages or promise that Metro reload installs native code.

## Adding a supported control

Add a row here only after reviewing the exact package, dependency spec, use case, public React Native API, and native runtime requirements. Add or update its implementation helper and `/add-native` routing, and wire the planner's intent mapping. The helper must reference this file, explain when to use the control, and preserve its own input/output and runtime checks. Keep optional controls out of the base template.

The validator reads package names from this table, not a second hardcoded list. Regression tests must cover the new mapping and verify that unlisted native packages remain blocked. A missing or malformed allowlist is a validation error, not permission to add packages.
