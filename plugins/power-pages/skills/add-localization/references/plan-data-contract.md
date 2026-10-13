# Add-localization plan data contract

Use this contract when Phase 3 renders `docs/add-localization-plan.html`.

## Presentation language

Render the artifact in the site's **current source locale**:

- Existing valid localization: use the existing pre-change `defaultLocale`.
- New localization with a valid root document language: use that detected
  locale.
- New localization with a missing or invalid root language: use the locale the
  maker selected in Phase 2 to represent the existing UI.

The source locale remains the plan language even when a repair/reconfigure
operation changes the resulting default locale. A target locale must never be
chosen merely because it is being added.

Set `SOURCE_LOCALE` to the canonical BCP-47 tag and `SOURCE_DIRECTION` to its
resolved `ltr` or `rtl` direction. Write `PLAN_TITLE`, `SUMMARY`,
`PLAN_LABELS`, reasons, descriptions, findings, remediations, checks, and
limitations in `SOURCE_LOCALE`.

Keep technical values unchanged: framework/package names, versions, file paths,
commands, locale tags, CSS properties, identifiers, API names, audit rule
names, URLs, and code markers.

## Mode availability

Before building this data, read the selected framework/mode from
`scripts/lib/localization-config.js`. A plan may use only a mode whose
centralized status is `available`.

Currently available:

- React runtime localization
- Vue runtime localization
- Angular runtime localization

The recommended packages are `react-i18next`, `vue-i18n`, and
`@jsverse/transloco`, respectively. A compatible validated alternative runtime
package may be selected.

Angular static and Astro static remain known implementation capabilities but
are `temporarily-unavailable`. Do not represent them as proposed, preserved, or
changed plan modes. Astro has no currently available localization mode, so an
Astro invocation stops before rendering this artifact. The renderer enforces
this policy independently.

## Required top-level data

```json
{
  "SITE_NAME": "Existing site/brand name",
  "PLAN_TITLE": "Localized title",
  "SOURCE_LANGUAGE": "Localized readable source-language name",
  "SOURCE_LOCALE": "en-US",
  "SOURCE_DIRECTION": "ltr",
  "FRAMEWORK": "React",
  "INVOCATION_CONTEXT": "direct",
  "OPERATION": "create",
  "EXISTING_LOCALIZATION_DETECTED": false,
  "SUMMARY": "Localized plan summary",
  "PLAN_LABELS": {},
  "DISCOVERY_DATA": {},
  "CONFIGURATION_DATA": {},
  "LOCALES_DATA": [],
  "FILES_DATA": [],
  "READINESS_DATA": {},
  "VALIDATION_DATA": [],
  "LIMITATIONS_DATA": []
}
```

Allowed technical enums:

- `FRAMEWORK`: `React`, `Vue`, `Angular`, `Astro`
- `INVOCATION_CONTEXT`: `direct`, `create-site`
- `OPERATION`: `create`, `add-languages`, `repair`, `reconfigure`

## Configuration

First include deterministic discovery evidence:

```json
{
  "frameworkEvidence": ["Localized evidence with unchanged technical names"],
  "existingSetup": ["Localized existing-configuration detail"],
  "conflicts": []
}
```

`frameworkEvidence` must not be empty. Use an empty `conflicts` array when no
conflicts were found.

```json
{
  "package": {
    "value": "react-i18next 15.0.0",
    "name": "react-i18next",
    "version": "15.0.0",
    "status": "new",
    "verification": "verified",
    "selection": "recommended",
    "evidenceSource": "known-capability",
    "evidenceUrl": "https://www.npmjs.com/package/react-i18next",
    "initializationEvidence": null
  },
  "mode": {
    "value": "runtime",
    "status": "new",
    "description": "Optional localized detail"
  },
  "defaultLocale": {
    "value": "en-US",
    "status": "preserved",
    "description": "Optional localized detail"
  },
  "translation": {
    "method": "agent",
    "value": "Localized translation-method label",
    "description": "Localized method explanation",
    "warning": "AI translations may contain errors - please verify them before publishing."
  },
  "selector": {
    "value": "Localized placement label",
    "description": "Localized runtime/static behavior"
  },
  "rootDocumentRepair": null
}
```

`package`, `mode`, and `defaultLocale` use `new`, `preserved`, or `changed`.
`package.value` is localized presentation text. `package.name` and
`package.version` are required technical identities and remain untranslated.
The renderer validates known packages against `FRAMEWORK` and `mode.value`, so
a static package cannot enter a runtime plan under a different display label.
`package.verification` is `verified` or `unverified`. For a custom package,
`initializationEvidence` is `{ "file": "<path>", "marker": "<exact API marker>" }`.
`package.selection` is `recommended`, `alternative`, or `preserved`.
`package.evidenceSource` is `known-capability`, `official-documentation`,
`package-documentation`, or `user-approved`. `unverified` packages must use
`user-approved`; `official-documentation` requires an HTTPS `evidenceUrl`.
`translation.method` is `agent` or `blank`; `agent` requires the AI translation
warning.
For a missing/invalid root language, `rootDocumentRepair` is:

```json
{
  "file": "framework root-document path",
  "lang": "canonical locale",
  "dir": "ltr or rtl"
}
```

For Astro built-in localization, use a localized `package.value` such as
"Astro built-in i18n" while keeping `Astro` technical and set verification to
`verified`.

## Locales

Include every resulting locale:

```json
[
  {
    "language": "Localized readable language name",
    "locale": "en-US",
    "direction": "ltr",
    "roles": ["source", "default", "existing"],
    "availability": "available"
  },
  {
    "language": "Localized readable language name",
    "locale": "ar-SA",
    "direction": "rtl",
    "roles": ["added"],
    "availability": "pending-remediation"
  }
]
```

There must be exactly one `source` and one `default` role. They may belong to
different locales when the operation changes the default. Other role values
are `existing` and `added`; availability is `available` or
`pending-remediation`.

## Files and packages

List the complete delta, including packages and files that will intentionally
remain unchanged:

```json
[
  {
    "path": "package.json",
    "action": "update",
    "reason": "Localized reason"
  }
]
```

Actions are `create`, `update`, `preserve`, `replace`, or `skip`. Never use a
generic directory entry when exact files are known.

## Bidirectional readiness

```json
{
  "transition": "ltr-only → mixed",
  "findings": [
    {
      "severity": "error",
      "file": "src/styles.css",
      "line": 42,
      "rule": "directional-physical-css",
      "message": "Localized explanation",
      "remediation": "Localized proposed remediation",
      "scope": "locale",
      "affectedLocales": ["ar-SA"]
    }
  ],
  "componentScope": [
    {
      "component": "Localized component or surface name",
      "classification": "direction-aware",
      "reason": "Localized classification reason",
      "states": ["Localized applicable state"],
      "viewports": ["desktop", "narrow"],
      "checks": ["Localized planned verification"]
    }
  ],
  "physicalExceptions": ["Localized description with unchanged CSS details"],
  "scriptFonts": ["Localized script/font change"],
  "unavailableLocales": ["ar-SA"]
}
```

Finding severity is `error` or `review`. Preserve the audit's exact `file`,
positive `line`, and `rule`, and provide the proposed `remediation`. Every
finding also has a `scope` and nonempty, unique `affectedLocales`:

- `locale` affects exactly one language-specific locale.
- `direction` affects every configured locale in its `ltr` or `rtl`
  `direction`.
- `shared` affects an explicitly tested subset of configured locales.
- `global` affects every configured locale.

An empty array is valid for findings, physical exceptions, script fonts, and
unavailable locales.

`componentScope` must be non-empty and cover every visible or interactive
component in the existing implementation, including page-local controls.
Classifications are `direction-neutral`, `direction-aware`,
`direction-fixed`, or `unknown-third-party`. `reason`, `states`, and `checks`
are localized. `states` contains every applicable rendered or interactive
state, not a mechanical list of states the component does not support.
`viewports` contains one or both stable values `desktop` and `narrow`.

Treat anything involving inline placement, text direction, horizontal
movement, sequence, directional meaning, mixed-script content, or rendering
outside the normal component subtree as a potential bidirectional surface.
Direction-aware entries require planned LTR and RTL checks. Direction-fixed
entries require a semantic reason and surrounding-UI checks.
Unknown/third-party entries require rendered checks for their supported open
states, including portals, teleports, overlay containers, Shadow DOM, or
iframes. This plan data is human-reference scope, not a new project manifest;
reconcile it against the implementation during Phase 5.

The source locale must be `existing` and `available`, locale tags must be
unique, and `unavailableLocales` must exactly match locales marked
`pending-remediation`. The selected default locale must also remain available.
When a newly proposed default is still pending, preserve the previous default
until that locale is verified and can be enabled.
Every locale named by an unresolved finding must be
`pending-remediation`. A finding for a newly added Arabic locale therefore
does not disable an already verified Hebrew locale unless the finding is
direction-scoped or shared evidence identifies Hebrew as affected. Plan
approval authorizes the proposed remediation; it does not authorize enabling
an affected locale while that blocker remains.

## Verification and limitations

`VALIDATION_DATA` uses stable technical IDs with localized descriptions:

```json
[
  {
    "id": "independent-validator",
    "description": "Localized verification description"
  }
]
```

Include one entry for every required ID; additional unique project-specific
checks are allowed:

`independent-validator`, `project-build`, `package-initialization`,
`resource-completeness`, `protected-tokens`, `locale-navigation`,
`locale-state`, `fallback-behavior`, `document-lang-dir`, `browser-console`,
`representative-routes`, `bidirectional-content`, `localized-formatting`,
`script-fonts`, `directional-components`, and `accessibility`.

`LIMITATIONS_DATA` is an array of localized known or anticipated limitations
and approved translation replacements. A pre-implementation plan may describe
a possible usable limitation, but final maker approval is obtained only after
rendered evidence exists in Phase 7. Use an empty array when none are known.

## Required localized labels

Translate every value below into `SOURCE_LOCALE`. Keep the stable keys
unchanged and preserve `{siteName}` exactly.

```json
{
  "navigation": {
    "group": "Localization plan",
    "overview": "Overview",
    "languages": "Languages",
    "changes": "Changes",
    "readiness": "Bidirectional readiness",
    "verification": "Verification"
  },
  "overview": {
    "title": "Localization overview",
    "description": "Localization implementation plan for {siteName}",
    "framework": "Framework",
    "invocation": "Invocation",
    "operation": "Operation",
    "existingSetup": "Existing localization",
    "configuration": "Approved configuration",
    "frameworkEvidence": "Framework evidence",
    "existingDetails": "Existing setup",
    "conflicts": "Conflicts",
    "noConflicts": "No conflicts detected."
  },
  "configuration": {
    "package": "Package",
    "mode": "Mode",
    "defaultLocale": "Default locale",
    "translation": "Translation population",
    "selector": "Language selector",
    "verification": "Package verification",
    "selection": "Package selection",
    "evidenceSource": "Evidence source",
    "evidence": "Evidence",
    "initialization": "Initialization evidence",
    "rootRepair": "Root document repair"
  },
  "languages": {
    "title": "Languages",
    "description": "Source, existing, and newly added locales",
    "language": "Language",
    "locale": "Locale",
    "direction": "Direction",
    "roles": "Roles",
    "availability": "Availability"
  },
  "changes": {
    "title": "Files and packages",
    "description": "Exact implementation delta after approval",
    "path": "Path or package",
    "action": "Action",
    "reason": "Reason"
  },
  "readiness": {
    "title": "Bidirectional readiness",
    "description": "Direction transition, findings, and planned remediation",
    "transition": "Direction-set transition",
    "findings": "Readiness findings",
    "noFindings": "No readiness findings.",
    "location": "Location",
    "rule": "Rule",
    "scope": "Scope",
    "affectedLocales": "Affected locales",
    "remediation": "Planned remediation",
    "componentScope": "Component review scope",
    "component": "Component",
    "classification": "Classification",
    "reason": "Reason",
    "states": "Applicable states",
    "viewports": "Applicable viewports",
    "checks": "Planned checks",
    "physicalExceptions": "Physical exceptions",
    "scriptFonts": "Script font changes",
    "unavailableLocales": "Locales pending remediation",
    "none": "None."
  },
  "verification": {
    "title": "Verification and limitations",
    "description": "Checks that will run before maker review",
    "checks": "Verification checks",
    "limitations": "Known limitations",
    "noLimitations": "No known limitations."
  },
  "status": {
    "new": "New",
    "preserved": "Preserved",
    "changed": "Changed",
    "create": "Create",
    "update": "Update",
    "preserve": "Preserve",
    "replace": "Replace",
    "skip": "Skip",
    "source": "Source",
    "default": "Default",
    "existing": "Existing",
    "added": "Added",
    "available": "Available",
    "pendingRemediation": "Pending remediation",
    "verified": "Verified",
    "unverified": "Unverified",
    "yes": "Yes",
    "no": "No"
  },
  "packageSelection": {
    "recommended": "Recommended",
    "alternative": "Alternative",
    "preserved": "Preserved"
  },
  "evidenceSource": {
    "knownCapability": "Known capability",
    "packageDocumentation": "Package documentation",
    "officialDocumentation": "Official documentation",
    "userApproved": "User approved"
  },
  "severity": {
    "error": "Error",
    "review": "Review"
  },
  "classification": {
    "directionNeutral": "Direction-neutral",
    "directionAware": "Direction-aware",
    "directionFixed": "Direction-fixed",
    "unknownThirdParty": "Unknown or third-party"
  },
  "viewport": {
    "desktop": "Desktop",
    "narrow": "Narrow or mobile"
  },
  "operation": {
    "create": "Create localization",
    "addLanguages": "Add languages",
    "repair": "Repair",
    "reconfigure": "Reconfigure"
  },
  "invocation": {
    "direct": "Direct",
    "createSite": "From create-site"
  },
  "footer": {
    "aiWarning": "AI-generated content may be incorrect"
  }
}
```

## Persistence and source of truth

The rendered HTML remains under `docs/` for human reference. It is not parsed
or consumed by implementation, validation, deployment, or later skill runs.
Before implementation, the approved in-memory configuration remains
authoritative. After implementation, `.powerpages-localization.json` and the
site files become the durable source of truth.
