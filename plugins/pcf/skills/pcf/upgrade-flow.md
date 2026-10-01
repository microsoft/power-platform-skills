# /pcf upgrade flow

Use this flow for an existing PCF project. It keeps upgrade automation narrow and leaves runtime-shape changes to explicit manual work. Microsoft Learn documents PCF lifecycle and manifest/platform-library concepts at https://learn.microsoft.com/en-us/power-apps/developer/component-framework/overview and https://learn.microsoft.com/en-us/power-apps/developer/component-framework/react-controls-platform-libraries.

## Sequence

1. Diagnose:
   ```powershell
   node "${PLUGIN_ROOT}/scripts/pcf-doctor.js" [--project <dir>] [--hosts model,pages] [--needs build]
   ```
2. Plan:
   ```powershell
   node "${PLUGIN_ROOT}/scripts/pcf-upgrade.js" [--project <dir>] [--hosts model,pages] [--steps <id,...>] [--allow-dirty] [--no-install] [--npm-cli <path>]
   ```
3. Show the JSON plan. Separate automatic steps from manual notes.
4. Obtain consent before modifying files. If unattended, require explicit `--apply` authority and a clean or `--allow-dirty` workspace.
5. Apply:
   ```powershell
   node "${PLUGIN_ROOT}/scripts/pcf-upgrade.js" [--project <dir>] [--hosts model,pages] --apply [--steps <id,...>] [--allow-dirty] [--no-install] [--npm-cli <path>]
   ```
   For a scoped repair, use the boolean `--apply` flag plus `--steps`, for example:
   ```powershell
   node "${PLUGIN_ROOT}/scripts/pcf-upgrade.js" --project <dir> --apply --steps PLATFORM_LIB_VERSION
   ```
   Do not pass a value to `--apply`; the CLI rejects `--apply <id>` and `--apply=<id>`.
   REINSTALL is a selectable step when the plan contains it. Each automatic step has `requiresStep`. `DEPS_TO_MATRIX` sets `requiresStep` to `REINSTALL` because pinning `package.json` without refreshing `package-lock.json` leaves a stale lockfile. Selecting `DEPS_TO_MATRIX` includes that required step even when `--steps` omits it, and listing both still installs once. Selecting `REINSTALL` alone runs only the reinstall, or records the skipped `npm install` command when `--no-install` is set. An unknown `--steps` value lists every selectable id, including `REINSTALL` when the plan contains it.
6. If `--no-install` is used, run the reinstall command the result names, usually `npm install` in the PCF project.
7. Run `pcf-gates.js --project <dir>`, redeploy with `deploy-flow.md`, rebind if needed, and verify.
8. Before redeploying over an existing registration, run `lint-pcf.js --manifest <current> --against <previous manifest>` when the previous manifest is available from source control or an exported baseline. If no baseline exists, record that compatibility was not compared instead of claiming a backwards-compatible upgrade.

## STANDARD_TO_VIRTUAL

Changing a standard control to virtual changes the runtime shape and is not automatic. Create or migrate to a virtual template only for model-driven apps, remove Pages from the target hosts, add platform libraries from the matrix, and retest all rendering and bundle assumptions.

## FLUENT_8_TO_9

Fluent 8 to Fluent 9 is a code and styling migration, not a package-only edit. Replace imports with `@fluentui/react-components`, update component props and styling, verify accessibility, then run gates. Keep versions from the matrix.

## PAGES_VIRTUAL_TO_STANDARD

Power Pages does not support virtual controls or platform libraries. For a Pages target, create a standard control, remove platform-library declarations, avoid unsupported Pages APIs, and verify through `pages-flow.md`.

## ESLINT_FLAT_CONFIG

This release does not delete or replace existing ESLint configuration automatically. Add `eslint.config.mjs` from a generated template, run lint, then remove legacy `.eslintrc*` files only after lint proves equivalent coverage.

## DECLARE_FEATURES

When source uses host features such as WebAPI, Device or Utility, declare them in manifest `uses-feature` entries. Use `required="false"` unless the control cannot function without the API, and guard optional methods at runtime.
