# Localization Framework Reference

Use this reference from `/power-pages:add-localization` after deterministic
project inspection. Localization affects only the code-site SPA. It does not
install or enable languages in the Dataverse environment.

## Current availability

| Framework | Available mode | Recommended tooling | Temporarily unavailable |
|---|---|---|---|
| React | Runtime | `i18next` + `react-i18next` | — |
| Vue | Runtime | Stable `vue-i18n` | — |
| Angular | Runtime | `@jsverse/transloco` | Static/build-time localization (`@angular/localize`) |
| Astro | None | — | Static locale routes (built-in Astro i18n) |

React and Vue use runtime localization because the current Vite templates
produce one SPA build. Per-locale static output would require a separately
designed multi-build, routing, output-directory, and asset-path pipeline.

Angular currently uses Transloco for in-place runtime switching. Its
`@angular/localize` static implementation remains documented below but is not
selectable until the centralized availability registry re-enables it.

Astro's built-in static implementation remains documented below but is not
currently selectable. An Astro invocation stops before configuration or plan
rendering.

`scripts/lib/localization-config.js` is the source of truth. Workflows,
package validation, plan rendering, and final validation must consume that
registry rather than maintaining separate availability lists.

## Shared implementation rules

1. Extract user-visible text only. Do not translate identifiers, routes, URLs,
   API endpoints, Dataverse logical names, environment variables, package
   names, CSS classes, or code examples.
2. Use stable semantic keys grouped by feature, not English source text as
   keys. Example: `navigation.home`, not `Home`.
3. Preserve existing non-empty target translations.
4. Add missing keys to every configured locale. Report stale keys but never
   delete them automatically.
5. Preserve `{{name}}`, `{count}`, `%s`, ICU expressions, markup, Markdown,
   URLs, and escaped characters exactly.
6. Configure exactly one default/fallback locale.
7. Set the document `lang` and `dir` for every active locale.
8. Use canonical BCP-47 locale identifiers internally and readable language
   names in the selector.
9. Put the selector in the site's existing shared header/navigation when one
   exists. Otherwise create a reusable selector and integrate it into the
   shared layout.
10. Use the project's established file naming, TypeScript, formatting, and
    component conventions. Do not create a competing structure.

## Agent-generated translation

When selected, translate during skill execution and write the result into
normal project resources. Do not add a runtime translation API or credentials.

Always show:

> AI translations may contain errors - please verify them before publishing.

Before accepting a generated translation, compare its protected tokens with
the default-locale value. Regenerate or flag values that alter the token set.
Legal, medical, financial, marketing, and regulated content requires human
review.

For manual translation mode, create the complete target key structure with
blank values. Do not copy source text into the targets and present it as
translated.

## Runtime locale behavior

Applies to React, Vue, and Angular with Transloco.

Resolve the initial locale in this order:

1. A supported locale saved in `localStorage`.
2. The best supported match from `navigator.languages`.
3. The configured default locale.

Store only the canonical locale string in `localStorage` under a
site-specific key. This is browser-local preference data; do not write it to
Dataverse or associate it with the signed-in user.

Generate one locale coordinator for runtime-localized sites. Single-language
sites and static localization modes do not receive this infrastructure. The
coordinator is the only owner of active locale changes.

Required coordinator paths:

- React/Vue: `src/i18n/localeCoordinator.ts`
- Angular runtime: follow the existing i18n service directory, otherwise
  `src/app/i18n/locale-coordinator.service.ts`

The coordinator must expose a public `switchLocale` operation and:

1. Canonicalize and validate the requested supported locale.
2. Prepare messages and any required target-script font before visible change.
3. Cancel or invalidate stale switch requests.
4. Activate the localization library locale without reloading.
5. Set `document.documentElement.lang` and `.dir` from the same resolved locale.
6. Apply the locale/script font profile and localized metadata when configured.
7. Persist the canonical locale only after a successful commit.
8. Fall back to the default locale for invalid saved values and missing messages.

Add direction-change subscriptions only when components cache physical
geometry, such as charts, carousels, virtualized lists, grids, or overlays.
Ordinary components using logical CSS need no subscription.

The language selector calls the coordinator; it must not independently mutate
the localization library, `lang`, `dir`, or persistence.

## Dormant static locale behavior

This guidance is retained for Angular with `@angular/localize` and Astro so the
implementations can be re-enabled without reconstruction. Current workflows
must not execute it while those modes are `temporarily-unavailable`.

- Generate a locale-specific build or route for every configured locale.
- Include the active locale in the URL/build output.
- Make the language selector navigate to the equivalent localized route.
- Preserve route context where an equivalent route exists.
- Otherwise navigate to the approved locale landing page.
- Generate locale-specific `lang` and `dir` values.
- Do not use separate browser persistence; the locale URL is the durable
  selection and is shareable/bookmarkable.

## React

Recommended defaults:

- Initialization: `src/i18n/index.ts`
- Resources: `src/i18n/locales/<locale>.json`
- Selector: follow the existing component directory convention

Install compatible stable versions of `i18next` and `react-i18next`. Initialize
i18next once near the application entry point. Use `useTranslation()` in
components and `t()` for visible strings. Use `fallbackLng` for the approved
default locale and escape values according to React's normal safe rendering.

## Vue

Recommended defaults:

- Initialization: `src/i18n/index.ts`
- Resources: `src/i18n/locales/<locale>.json`
- Selector: follow the existing component directory convention

Install a stable `vue-i18n` release; never silently use an npm prerelease tag.
Register the i18n plugin once in the app entry point. Use `$t` or
`useI18n()` consistently with the existing Composition/Options API style.

## Angular static (dormant)

Use `@angular/localize` matching the installed Angular major/version.

- Mark template content with Angular i18n metadata.
- Extract the source messages with the Angular CLI.
- Store targets under `src/locale/messages.<locale>.xlf`.
- Configure `projects.<project>.i18n` and locale build targets in
  `angular.json`.
- Ensure each locale's base href/output path works with the Power Pages code
  site deployment output.
- Implement selector links between the equivalent locale builds.

The default locale may use the extracted source catalog as its resource-path
entry in the manifest.

## Angular runtime

Use `@jsverse/transloco`.

- Resources: use the project's established Transloco path, otherwise
  `src/assets/i18n/<locale>.json`.
- Configure the provider and loader using the current standalone/module style
  already used by the project.
- Use Transloco services/directives/pipes consistently.
- Implement the shared runtime locale behavior above.

## Astro static (dormant)

Use Astro's built-in `i18n` configuration.

- Configure `locales`, `defaultLocale`, routing, and fallback behavior in the
  existing Astro config.
- Generate locale-aware pages under `src/pages/<locale>/` or adapt the
  project's established route pattern.
- Prefer shared translation resources/helpers rather than duplicating literal
  text across every page.
- Use Astro's locale URL helpers for selector navigation.
- Ensure the default-locale prefix behavior is explicit and consistent.

## Manifest

Write `.powerpages-localization.json` after implementation using this shape:

```json
{
  "schemaVersion": 1,
  "framework": "react",
  "mode": "runtime",
  "packageName": "react-i18next",
  "packageVersion": "^16.0.0",
  "packageVerification": {
    "status": "verified",
    "source": "known-capability"
  },
  "locales": ["en-US", "fr-FR"],
  "defaultLocale": "en-US",
  "translationMethod": "agent",
  "resourcePaths": {
    "en-US": "src/i18n/locales/en-US.json",
    "fr-FR": "src/i18n/locales/fr-FR.json"
  },
  "generatedFiles": ["src/components/LanguageSelector.tsx"],
  "managedFiles": ["src/i18n/index.ts", "src/main.tsx"],
  "unavailableLocales": [],
  "bidirectionalReadiness": {
    "status": "ready",
    "findings": []
  },
  "adoptedExistingConfiguration": false,
  "lastOperation": "create",
  "updatedAt": "2026-07-30T00:00:00.000Z"
}
```

For Astro built-in routing, use `"packageName": "astro-built-in"`. For XLF,
map each locale to its source/target XLF file. Keep paths repository-relative.
Set `translationMethod` to `"agent"` or `"blank"` so validation can
distinguish intentional empty targets from broken translations.

`unavailableLocales` is optional and contains configured locale tags that have
resources on disk for development/remediation but must not be selectable,
auto-detected, advertised, or deployed as production static output. The
implementation must expose one managed `localeAvailability` module with an
`isLocaleAvailable` predicate that rejects the unavailable set. Every selector,
switch/detection path, alternate-language metadata generator, and static output
configuration must apply that predicate; recording the array in the manifest
does not disable a locale by itself. During `pending-remediation`, all
configured locales opposite to the default locale's direction must remain
unavailable.
`bidirectionalReadiness` is optional for same-direction locale sets and required
when the configured set contains both LTR and RTL:

- `ready` — no unresolved compatibility findings.
- `approved-with-limitations` — the experience remains functional, readable,
  accurate, and accessible; the maker explicitly accepted documented limits.
- `pending-remediation` — hard compatibility work remains; affected locales
  belong in `unavailableLocales` and managed availability logic.

Each pending finding must preserve the exact scanner result with `file`, `line`, `rule`, and
`message`.
Only those recorded physical-layout blockers are deferred by lifecycle validation; newly
introduced findings, invisible bidi controls, and invalid exception directives still block.

Schema version 1 includes `packageVerification`:

- Known recommendations use `status: "verified"` and
  `source: "known-capability"`.
- Alternatives verified from npm package text use
  `source: "package-documentation"`.
- Alternatives verified from an accepted official URL use
  `source: "official-documentation"` and record that HTTPS URL as
  `evidenceUrl`.
- An explicitly approved inconclusive alternative uses
  `status: "unverified"` and `source: "user-approved"`.

When a custom package's initialization API does not match built-in detection,
record deterministic evidence:

```json
"initializationEvidence": {
  "file": "src/i18n/custom-provider.ts",
  "marker": "customI18n.initialize("
}
```

The file must stay inside the project, import `packageName` (package subpaths
are allowed), and contain the exact marker. This evidence confirms the
approved implementation location without teaching the detector a
package-specific heuristic.

## Repair and reconfiguration

Offer repair/reconfiguration when one or more of these conditions apply:

- Setup is partial: package, initialization, resources, selector, or routes
  are missing.
- Manifest conflicts with dependencies or source/configuration.
- Multiple localization packages or runtime/static modes conflict.
- Package is missing, deprecated, incompatible, or the maker wants to change
  it.
- An existing Angular static setup must be explicitly reconfigured to the
  currently available runtime mode before this skill can modify it.
- Default locale is missing, invalid, duplicated, conflicting, or explicitly
  being changed.
- Locale resources/routes or translation keys are missing.
- Protected interpolation tokens differ between locales.
- Existing valid localization predates the manifest and should be adopted.
- Existing translations are stale and the maker explicitly approves
  regeneration.

Repair only the approved delta. Preserve non-empty translations unless the
maker explicitly approves replacing identified values. Framework conflicts
are outside this skill: show the evidence, stop without changes, and ask the
maker to fix the project's framework configuration manually.
