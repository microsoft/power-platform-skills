# Phase 7 of 10 — Integrations

**Steps:** 9–10. **Previous:** [6 — Data](phase-06-data.md). **Next:** [8 — Screen shell](phase-08-screens.md).
[Phase index](../SKILL.md#load-only-the-active-phase). Advance only after this phase's exit condition passes.

### Step 9 — Apply native capabilities

**Telemetry checkpoint: `configure_native_capabilities`**

Read the approved Native Capabilities matrix. For each row invoke
`/add-native --working-dir <working_dir> --capability <name>` sequentially.
The helper routes camera/PDF/pen/geolocation implementations and enforces live native allowlist,
storage/control boundaries; never install missing native modules or fake wrappers.
If None, skip only these invocations, **not** Step 9a/9b.

### Step 9a — Install approved pure-JavaScript dependencies

**Telemetry checkpoint: `install_approved_javascript_dependencies`**

Read the Installation Contract in
[javascript-dependency-planning.md](${PLUGIN_ROOT}/shared/references/javascript-dependency-planning.md)
for approved `## Screens → ### JavaScript Dependencies` rows.
Gate 4b consent covers exactly those packages/versions. Install/validate before skeleton/builders,
including package/lockfile and module resolution checks. No package substitution, compiler-error
guessing, or routing JS-only dependencies through `/add-native`.
If native content/incompatible dependencies emerge, remove only the just-added package and STOP.
Absent/None dependency table is a no-change skip.

### Step 9b — Apply design system

The native-host `createPowerAppsTamaguiConfig` owns baseline semantic aliases, contrast,
animations and font fallback; do not copy that implementation into app source.
Read the relevant branch of
[tamagui-integration.md](${PLUGIN_ROOT}/skills/design-system/references/tamagui-integration.md).

| Existing artifacts | Action |
|---|---|
| `brand/tokens.ts` | Highest priority: brand-import mode; resolved app light/dark themes and matching host ThemeTokens |
| Approved `## Design` says required | Apply canonical integration using that complete section, not a summary |
| Default/add-aliases | Verify host factory already supplies `$surface0`–`$surface3` and `$accent*`; no config rewrite |
| Custom font | Follow canonical font path only if needed package ships in the live template |

The integration reference owns brand-token/provider wiring. Keep `useTheme()` and
`useThemeTokens()` synchronized, preserve `SafeAreaProvider`, provider ordering, `offlineProfile`,
`@ts-ignore` boundaries and color-scheme `defaultTheme`. No outer TamaguiProvider.
Run `npx tsc --noEmit` after Tamagui/provider changes; block if unresolved.
For typography customization, copy/merge the canonical `native-typography` and `TypographyText`
helpers, bind approved roles with `createNativeTypography`, and apply its returned fonts.
Place `assertNativeFontDefaults(tamaguiConfig)` after the final host factory call, not only
against a baseline. Preserve complete role props for actual text consumers in Step 10.8.
The helper's regression tests do not validate this app's unknown configuration: record an
unobserved final assertion as typography-unverified until the native app loads. Do not run
an arbitrary config evaluator or treat TypeScript/source-pattern success as runtime proof.

### Step 10 — Add connectors

**Telemetry checkpoint: `generate_connector_data_sources`**

Read approved Connectors. None skips only this step. For each row:
`sharepointonline` → `/add-sharepoint --working-dir <working_dir>`;
other APIs → `/add-connector --working-dir <working_dir> --connector <api-name>`.
Pass already-approved context and known connection IDs/references; helpers own connection resolution.
Run sequentially. Dataverse/connector/service writers share `src/generated/` and
`power.config.json`; parallel mutations race and are forbidden.
Refresh schema output after data-source changes and pass the actual service surface to Step 10.7.
Record results in the memory bank; load screen-shell phase next.
