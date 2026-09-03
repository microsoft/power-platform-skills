---
name: add-localization
description: >-
  Adds or extends multilingual localization in a Power Pages code-site SPA.
  Use whenever the user asks to translate, localize, internationalize, support
  multiple languages, add a language selector, add locale routes, repair an
  i18n setup, or add languages to an existing React, Vue, Angular, or Astro
  Power Pages site.
user-invocable: true
argument-hint: Optional project path, languages, or [FROM_CREATE_SITE] context
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, Skill, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_snapshot, mcp__plugin_power-pages_playwright__browser_click, mcp__plugin_power-pages_playwright__browser_close
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Add Localization

Add framework-appropriate localization to a Power Pages code-site SPA. This
skill changes only client-side site artifacts; it never enables Dataverse
environment languages or translates Dataverse records.

**Initial request:** $ARGUMENTS

Read `${PLUGIN_ROOT}/references/i18n-frameworks.md` and
`${PLUGIN_ROOT}/references/bidirectional-design.md` before planning or editing. Also apply
`${PLUGIN_ROOT}/references/site-modification-integrity.md` to all existing and future visible
site changes.

## Core principles

- Detect framework and existing localization from project evidence.
- Read mode availability only from `localization-config.js`; never plan or
  preserve a mode that is currently unavailable.
- Preserve valid available package/mode choices, the default locale, and
  non-empty translations.
- Ask questions in the fixed order below; skip only documented conditional
  questions.
- Validate language tags and package alternatives with deterministic scripts.
- Require plan approval before package installation or project-file changes.
- Use agent-generated translation only during authoring; never add a deployed
  translation service or credentials.
- Always show: **AI translations may contain errors - please verify them before publishing.**
- Treat `[FROM_CREATE_SITE]` in `$ARGUMENTS` as invocation context. It suppresses
  this skill's deploy prompt so create-site remains deployment owner.
- Generate a locale coordinator only for React, Vue, and runtime Angular.
  Single-language and dormant static implementations do not receive it.

## Workflow

1. Detect project and existing localization.
2. Gather and validate configuration.
3. Render, open, and approve the implementation plan.
4. Configure localization infrastructure.
5. Extract and localize content.
6. Verify localization independently.
7. Review changes with the maker.
8. Record usage and complete or offer deployment.

---

## Phase 1: Detect project and existing localization

Create all eight phase tasks upfront, then mark Phase 1 in progress.

First parse `$ARGUMENTS`, excluding the `[FROM_CREATE_SITE]` context marker. If
an explicit project path remains, resolve it as `<PROJECT_ROOT>` and verify that
`<PROJECT_ROOT>/powerpages.config.json` exists. This path takes precedence over
cwd discovery. Otherwise, locate `powerpages.config.json` in the current
directory or one immediate subdirectory. If no valid project root is found,
stop and recommend `/power-pages:create-site`.

Run:

```bash
node "${PLUGIN_ROOT}/scripts/lib/localization-config.js" inspect --projectRoot "<PROJECT_ROOT>"
```

Use only the returned JSON for framework and existing-localization decisions.

<!-- not-a-gate: evidence-backed framework selection or clean stop happens before any localization write -->

If framework evidence is ambiguous, show every conflicting dependency/config
file and use `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Framework evidence conflicts. What should this run target? | Framework | Only evidence-backed detected candidates; Stop and fix the project's framework configuration manually |

If the maker stops, make no changes, list the files requiring review, explain
that framework repair is outside localization scope, and end.

After resolving one evidence-backed framework, use the inspection result's
`availability` object. If framework ambiguity required a maker selection, run:

```bash
node "${PLUGIN_ROOT}/scripts/lib/localization-config.js" mode-availability --framework "<SELECTED_FRAMEWORK>"
```

This centralized result is the source of truth for selectable modes.

If `availableModes` is empty, show each centralized temporarily-unavailable
reason and stop without gathering configuration, rendering a plan, installing
dependencies, or editing files. This currently applies to Astro.

If `localization.unavailableModeEvidence` is non-empty, do not offer
add-languages while preserving that evidence, even when the manifest claims an
available mode:

- Angular static: explain that static localization is temporarily unavailable
  and use `AskUserQuestion` with **Reconfigure to Angular runtime localization**
  and **Stop without changes**. Continue only when the maker explicitly selects
  reconfiguration; set `OPERATION=reconfigure`. Phase 2.4 then offers the
  recommended `@jsverse/transloco` package or a validated runtime alternative.
- Any framework with no available alternative: stop without changes and show
  the centralized reason.

Never render a plan for a temporarily unavailable mode. The renderer and final
validator enforce the same registry as a backstop.

When no localization is detected and this is a direct invocation, display:

> **Localization scope**
> This localizes only the SPA user interface; it does not add languages to your Dataverse environment.

When no localization is detected and `siteLanguage.detected=true` in the
inspection result, display the declared locale, direction, source file, and any
conflicts. Treat a valid single-site document language as the existing
source/default locale for a new localization setup. If
`siteLanguage.valid=false`, show every conflict and include the exact root
`lang`/`dir` corrections in the approved localization plan.

When no localization is detected and `siteLanguage.detected=false`, display:

> **Source language not detected**
> The root document does not declare a valid static `lang` attribute, so the
> language of the existing UI cannot be determined reliably. Select the locale
> that represents the existing UI content.

Do not infer the source language from visible text, `dir`, browser preferences,
the operating system, or the development environment. Treat the source locale
as unknown until the maker selects a validated default locale in Phase 2. The
approved plan must name the framework's root document and show the exact
`lang="<DEFAULT_LOCALE>"` and `dir="<RESOLVED_DIRECTION>"` attributes that will
be added.

When localization already exists, its manifest/configuration remains the source
of truth instead of the static root-document attributes.

When localization is detected, display package, mode, locales, default locale,
resource paths, and conflicts.

<!-- not-a-gate: choosing add/repair/stop selects workflow scope before any write -->

Skip the generic existing-localization question when Phase 1 already forced
`OPERATION=reconfigure` because unavailable mode evidence was detected; the
maker already chose reconfiguration instead of stopping, and add-languages
must not be offered again.

Use `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Existing localization was found. What should this run do? | Existing setup | Add languages (Recommended), Repair or reconfigure, Stop without changes |

For **Add languages**, preserve package, mode, and default locale and skip
their questions. For **Repair or reconfigure**, ask only about detected
conflicts or explicitly requested changes. For **Stop**, make no changes.

---

## Phase 2: Gather and validate configuration

Ask configuration questions in this exact order.

### 2.1 Languages

<!-- not-a-gate: locale input is validated before it can enter the plan -->

Use `AskUserQuestion` for comma-separated BCP-47 tags. For add-languages mode,
show existing locales and ask only for additions. For a new setup whose
inspection found a valid single-site document language, show that source locale
and ask only for additional locales; combine the source locale with the
validated additions. Run:

```bash
node "${PLUGIN_ROOT}/scripts/lib/localization-config.js" validate-locales --locales "<COMMA_SEPARATED_TAGS>"
```

Reject invalid entries and re-prompt with each reason. Show canonicalization
changes and duplicates. Confirm canonicalization before continuing. Require at
least two unique locales for a new setup, including the detected source locale
when present, and at least one genuinely new locale for add-languages mode.

### 2.2 Default locale

<!-- not-a-gate: default-locale selection is validated configuration input -->

For a new setup with a valid detected single-site language, preserve it as the
default without asking. Otherwise, use `AskUserQuestion` with only the
validated canonical locales as options and require exactly one. In
add-languages mode, preserve the existing default without asking. In repair
mode, ask only when missing, invalid, conflicting, or explicitly being changed.

### 2.3 Mode

<!-- not-a-gate: mode selection shapes the upcoming plan and writes nothing -->

- If `availableModes` contains one mode, select it and state the decision
  without asking.
- If a future registry change exposes multiple modes, use `AskUserQuestion`
  with only those modes and identify `recommendedMode` as recommended.
- Use the selected mode's centralized `recommendedPackage`; do not reconstruct
  framework-specific mode/package mappings in this workflow.
- Add-languages mode: preserve the detected mode without asking only when its
  registry availability is `available`.
- Repair/reconfigure mode: allow only modes listed in
  `availability.availableModes`.

### 2.4 Package

<!-- not-a-gate: package selection is validated before plan approval -->

For new setup or relevant repair, use `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Which localization package should be used? | Package | Framework recommendation (Recommended), Suggest a different package, Cancel |

Skip for add-languages mode or when the selected mode reports
`builtIn: true`. Validate alternatives:

```bash
node "${PLUGIN_ROOT}/scripts/validate-i18n-package.js" --projectRoot "<PROJECT_ROOT>" --framework "<FRAMEWORK>" --package "<PACKAGE>" --version "<VERSION_OR_RANGE>" --mode "<runtime|static>" --telemetryLocales "<CANONICAL_RESULTING_LOCALES>" --telemetryOperation "<create|add-languages|repair|reconfigure>" --telemetryPackageSelection "<recommended|alternative|preserved>"
```

Pass the same telemetry context on every rerun, including unsupported,
inconclusive, prerelease-confirmation, official-evidence, and explicitly
unverified attempts. The script emits only the normalized package name,
resolved public version when available, intended canonical locales, validation
status, and stable failure codes. It never emits npm error text or evidence
URLs.

<!-- not-a-gate: prerelease acknowledgement still precedes the approved plan and any install -->

Interpret the JSON result as follows:

- `status: supported`: continue and preserve `modeEvidence` for the manifest.
- `status: unsupported`: show every hard failure and the framework
  recommendation. Hard compatibility, maintenance, license, and known-package
  conflicts cannot be overridden.
- `status: inconclusive`: explain that package health and framework
  compatibility passed but the requested localization mode could not be
  established from package documentation.

For an inconclusive package, use `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| The package's runtime/static support could not be verified. How should this proceed? | Package evidence | Use the framework recommendation (Recommended), Provide an official documentation URL, Proceed as explicitly unverified, Cancel |

For an official URL, rerun with `--modeEvidenceUrl "<HTTPS_URL>"`. The script
accepts only the package homepage or repository hostname published in npm
metadata. If the result remains inconclusive, return to the question above.

For an unverified override, explain that completion requires successful build
and browser verification, obtain explicit confirmation, and rerun with
`--allowUnverifiedMode`. Never use that flag for an unsupported result.

A prerelease requires a separate explicit `AskUserQuestion` confirmation and
rerun with `--allowPrerelease`.

For any alternative package whose initialization is not recognized by
deterministic discovery, identify the repository-relative initialization file
and a short exact API-call marker from that file. Include both in the plan as
`initializationEvidence`. The evidence file must import the selected package;
do not invent or accept a marker that is not already present after
implementation.

### 2.5 Translation population

<!-- not-a-gate: translation method shapes the plan and writes nothing -->

Use `AskUserQuestion`:

1. Generate translations with the agent (Recommended)
2. Create blank translation values for manual completion
3. Cancel

If agent-generated is selected, immediately display the AI translation warning.

### 2.6 Direction transition and readiness audit

Resolve every existing and proposed locale with:

```bash
node "${PLUGIN_ROOT}/scripts/lib/localization-config.js" resolve-locale --locale "<LOCALE>"
```

Classify the existing and resulting sets as `ltr-only`, `rtl-only`, or `mixed`.
When this operation first changes an LTR-only or RTL-only site to `mixed`, run:

```bash
node "${PLUGIN_ROOT}/scripts/audit-bidirectional-readiness.js" --projectRoot "<PROJECT_ROOT>"
```

The command prints structured JSON and exits nonzero when deterministic errors
exist; parse the JSON even on that expected failure path. Add every finding to
the Phase 3 plan. Include logical-CSS remediation,
validated physical exceptions, mixed/user content, localized formatting,
script font coverage, directional assets, calendars/date-pickers, gestures,
drawers, breadcrumbs, tables, charts, carousels, overlays, SVG/canvas, and
third-party components. Do not modify files before plan approval.

For every localization plan, build `READINESS_DATA.componentScope` from the
existing implementation. Include
every visible or interactive shared or page-local component and classify it as
`direction-neutral`, `direction-aware`, `direction-fixed`, or
`unknown-third-party`. For each entry, record the localized reason, every
applicable state, applicable `desktop`/`narrow` viewports, and planned checks.
Treat anything involving inline placement, text direction, horizontal
movement, sequence, directional meaning, mixed-script content, or rendering
outside the normal component subtree as a potential bidirectional surface.

Treat a form as a compound surface: include its labels, values, placeholders,
hints, helper text, validation messages, prefixes, suffixes, icons, autofill,
select/autocomplete panels, and validation summary when applicable. Include
portals, teleports, overlay containers, Shadow DOM, iframes, and other
third-party open states. This scope is plan data retained in workflow context
and the human-readable HTML; do not persist a separate component-inventory
JSON file.

---

## Phase 3: Plan and approve

Read
`${PLUGIN_ROOT}/skills/add-localization/references/plan-data-contract.md`, then
build and render the localization plan before asking for approval.

### 3.1 Determine the plan language

Render the artifact in the site's current source locale:

- Existing valid localization: the existing pre-change default locale.
- New setup with a valid detected root language: the detected locale.
- New setup with missing/invalid root language: the Phase 2 locale selected to
  represent the existing UI.

Keep that source locale as the plan language even if this operation changes the
resulting default. Resolve its canonical locale and direction with
`localization-config.js`; use them as `SOURCE_LOCALE` and `SOURCE_DIRECTION`.
Do not choose one of the added target locales merely because it is being added.

### 3.2 Build the plan data

Follow the exact contract in `references/plan-data-contract.md`. The artifact
must include:

- Framework evidence and invocation context.
- Existing setup and conflicts.
- Package/mode/default values marked **new**, **preserved**, or **changed**.
- Package verification status, evidence source/URL, and any custom
  initialization evidence.
- Canonical locales and additions.
- Translation method and warning.
- Exact files/packages to create, update, preserve, replace, or skip.
- For a missing or invalid root document language, the exact root document file
  and the approved canonical `lang` plus resolved `dir` attribute repair.
- Language-selector placement and runtime/static behavior.
- Build, validator, browser, RTL, and token checks.
- Direction-set transition, readiness findings, proposed remediations, physical
  exceptions, script-font changes, the classified component/state/viewport
  review scope, and whether any locale may remain unavailable pending
  remediation.
- Known limitations and any approved translation replacements.

Write maker-facing plan text in `SOURCE_LOCALE`; preserve technical values
unchanged. The renderer rejects malformed locale roles, default/source
inconsistency, invalid actions/statuses, incomplete labels, and incorrect
source direction.

### 3.3 Render and open the plan

Pick an output path under `<PROJECT_ROOT>/docs/`. Use
`add-localization-plan.html` when available; otherwise choose a descriptive
variant such as `add-localization-plan-v2.html`. Never overwrite an earlier
plan.

```bash
node "${PLUGIN_ROOT}/scripts/render-add-localization-plan.js" --output "<PROJECT_ROOT>/docs/add-localization-plan.html" --data-inline '<json-string>'
```

Use `--data-inline` so no plan-data JSON file is persisted. If the command is
too large, use a temporary JSON file with `--data`, then delete that temporary
file after rendering. Capture the renderer's returned output path and open that
exact HTML file in the user's default browser.

The HTML is a durable human-reference artifact only. Do not parse it during
implementation or treat it as workflow state. Before implementation, retain
the approved configuration in context; after implementation,
`.powerpages-localization.json` and the site files are authoritative.

Present a brief terminal summary with the artifact path, source/default/target
locales, package/mode, file counts by action, readiness blockers, unavailable
locales, and known limitations. Keep the terminal approval gate below; the HTML
does not contain an approve button and opening it does not imply approval.

<!-- gate: add-localization:3.plan-approval | category=plan | cancel-leaves=rendered-plan -->

> 🚦 **Gate (plan · add-localization:3.plan-approval):** Approves the complete localization delta before dependencies or site files change.
>
> **Trigger:** The deterministic plan and file inventory have been rendered to `docs/add-localization-plan*.html`, opened in the browser, and summarized in the terminal.
> **Why we ask:** A wrong package, mode, default locale, or extraction scope can touch most visible UI files.
> **Cancel leaves:** The rendered HTML plan remains under `docs/` for reference; no dependencies, site implementation files, or external state changed.

Use `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| How should the localization plan proceed? | Plan | Approve and implement (Recommended), Revise configuration, Cancel |

Loop through Phase 2 for revisions. Render revisions to a new descriptive HTML
filename and reopen the latest artifact. Do not install or edit before
approval.

After approval, emit the final configuration before Phase 4 changes any files:

```bash
node "${PLUGIN_ROOT}/scripts/emit-skill-configured-telemetry.js" --skillName "add-localization" --projectRoot "<PROJECT_ROOT>" --framework "<react|vue|angular|astro>" --operation "<create|add-languages|repair|reconfigure>" --invocationSource "<direct|create-site>" --existingLocalizationDetected "<true|false>" --mode "<runtime|static>" --defaultLocale "<DEFAULT_LOCALE>" --addedLocales "<CANONICAL_ADDED_LOCALES>" --resultingLocales "<CANONICAL_RESULTING_LOCALES>" --packageName "<PACKAGE_NAME>" --packageVersion "<RESOLVED_VERSION_OR_BUILT_IN>" --packageSelection "<recommended|alternative|preserved>" --packageVerification "<verified|unverified>" --translationMethod "<agent|blank>"
```

`invocationSource` is `create-site` only when `$ARGUMENTS` contains
`[FROM_CREATE_SITE]`; otherwise it is `direct`. For add-languages mode,
`addedLocales` contains only genuinely new locales while `resultingLocales`
contains the complete resulting set. The helper strips private-use and extension
subtags before emission.

---

## Phase 4: Configure localization infrastructure

Install only approved stable packages using the project's package manager.
Follow `${PLUGIN_ROOT}/references/i18n-frameworks.md` for the selected
framework/mode.

Adopt valid existing conventions rather than creating a second initialization
or resource hierarchy. In repair mode, apply only the approved delta. Never
remove a package, switch Angular mode, or replace custom initialization unless
the approved plan names that change.

The Angular static and Astro static implementation guidance remains documented
for future re-enablement, but current runs must never execute those dormant
paths.

For runtime mode, create or adopt exactly one locale coordinator at the path
defined in the framework reference. The language selector must call
`switchLocale`; it must not independently update translations, persistence,
`lang`, or `dir`. Add metadata/font preparation and geometry notifications only
when the site needs them. Do not create a coordinator for static mode.

---

## Phase 5: Extract and localize content

Inventory visible strings across pages, shared components, navigation,
validation/status messages, accessibility labels, and page metadata. Create
stable semantic keys and replace visible literals using framework idioms.

Create/synchronize every locale resource. For new locales, include every
default-locale key. Preserve all existing non-empty translations. Report stale
keys without deleting them.

For agent-generated translation:

- Translate from the default locale with page/component context.
- Preserve protected tokens exactly.
- Regenerate or flag any token mismatch before writing.
- Repeat the AI translation warning in the implementation summary.

For blank mode, create complete key structures with blank target values.

Add a language selector to shared navigation/layout. Implement runtime
persistence or static route navigation exactly as described in the framework
reference. Configure `lang`, `dir`, fallback behavior, and RTL handling.
For a new setup whose root document language was missing or invalid, apply the
approved root-document repair: set static `lang` to the approved canonical
default locale and `dir` to that locale's resolved direction. Do not infer or
substitute a different source locale during implementation.

Apply approved bidirectional remediation. Use logical CSS by default. Add
`<bdi>`/`dir="auto"` at unknown-content boundaries, explicit isolation for
machine values, `Intl` formatting for locale-sensitive data, and script-aware
font profiles only where the configured scripts need them. Preserve brand
character across font profiles.

For an existing site, this is a targeted bidirectional adaptation rather than
an unrelated visual redesign. Preserve branding, routes, features, and visual
character while replacing direction-specific assumptions. Reconcile the
approved component scope against the files and components actually changed,
adding any visible or interactive surface or state discovered during
implementation.

Localized form labels, placeholders, hints, helper text, validation messages,
prefixes, suffixes, icons, and open menus follow the active UI direction and
use logical alignment. Free-form multilingual values use `dir="auto"`.
Machine-oriented email addresses, URLs, code, paths, GUIDs, and identifiers may
remain LTR only when classified as direction-fixed and accompanied by the
adjacent `bidi-fixed: <specific reason>; verify=ltr,rtl` directive required by
the shared standard; their surrounding field UI remains direction-aware.

For unknown or third-party components, prefer the package's public locale and
direction API. If none exists, use a documented wrapper or supported theme
override and verify the rendered integration, including body-mounted portals
or overlays. Do not edit `node_modules`. If an externally owned surface cannot
be adapted or verified and the impact is blocking, keep the affected locale
unavailable.

Write `.powerpages-localization.json` using reference schema version 1 before
Phase 6 validation. At this point it is a provisional safety state, not a
readiness claim: set `bidirectionalReadiness.status` to
`pending-remediation`, create one `localeReadiness` entry for every configured
locale, record the current static findings, leave `renderedFindings` empty,
and keep every newly added or otherwise affected locale unavailable until
verification and disposition finish. Mark those locale entries
`pending-remediation`. Preserve the readiness and availability of existing
locales unless current regression evidence shows they are affected. Record
`packageVerification`
from the package-validator result. For an unverified alternative, record
`status: unverified`, `source: user-approved`, and the official evidence URL
when one was supplied. Record `initializationEvidence` when deterministic
framework patterns do not recognize the selected package. Set `lastOperation` to `create`,
`add-languages`, `repair`, or `reconfigure`, and set `translationMethod` to
`agent` or `blank`.

Record `bidirectionalReadiness` for every new or changed localization setup,
including same-direction sets whose pseudo-opposite audit can still find a
future compatibility defect. Keep a locale
in `unavailableLocales` when technical blockers remain. It must be excluded
from selectors, browser auto-detection, alternate-language metadata, and
production static output. Its resources may remain available in development
for remediation. Generate one managed `localeAvailability` module that exports
`isLocaleAvailable`, rejects entries in `unavailableLocales`, and is applied
by every selector, locale switch/detection path, alternate-language metadata
generator, and static locale output configuration. The manifest alone does not
disable a locale. `unavailableLocales` must exactly match locale entries whose
individual readiness is `pending-remediation`.

Assign every static and rendered finding a `scope` and explicit
`affectedLocales`:

- `locale` for a language-specific problem affecting one locale.
- `direction` for a shared LTR or RTL problem; include every configured locale
  of that direction and record `direction`.
- `shared` for a shared implementation problem affecting an explicitly tested
  subset.
- `global` for a problem affecting every configured locale.

Do not infer that all locales of one direction are affected merely because a
new locale of that direction fails. Regression-test an existing locale when
shared direction-sensitive implementation changed, and include it only when
the evidence shows it is affected. If impact cannot be isolated safely,
include every potentially affected locale. Record each pending scanner finding
with its exact `file`, `line`, `rule`, `message`, and `fingerprint` so lifecycle
validation can defer the same known source item only while all explicitly
affected locales remain unavailable, without allowing a replacement or newly
introduced regression.

---

## Phase 6: Verify localization

Run the independent validator:

```bash
node "${PLUGIN_ROOT}/skills/add-localization/scripts/validate-localization.js" --projectRoot "<PROJECT_ROOT>"
```
Fix all reported errors.

Run the project's existing build. Start or reuse its dev server. Read
`${PLUGIN_ROOT}/references/rendered-bidirectional-verification.md` and build an
ephemeral run specification from the reconciled `componentScope` and actual
implementation. Do not persist the specification as a component manifest.
Use stable semantic selectors or add focused `data-bidi-id` verification
anchors where necessary.

Reuse the project's Playwright dependency. If neither `playwright` nor
`playwright-core` is installed, add `playwright` as a development dependency;
do not download a separate bundled browser when a supported system browser is
available.

The specification must include every configured real locale so the CLI can
reconcile it with `.powerpages-localization.json`, and it must cover:

- The default locale and every newly added locale independently.
- Application-driven activation plus representative localized-content
  assertions for every real locale; `set-document` is pseudo-only.
- Selector behavior or equivalent static locale navigation.
- Representative translated content.
- `html[lang]` and `html[dir]`.
- Browser console has no localization errors.
- One RTL locale when configured.
- Every representative route in one LTR and one RTL locale at desktop and
  narrow/mobile viewports when the configured set is mixed.
- Every applicable state and viewport in the classified component scope.
  Direction-neutral components require an inheritance check; direction-aware
  components require LTR and RTL checks; direction-fixed components require a
  semantic reason and surrounding-UI checks; unknown/third-party components
  require rendered checks for supported open states and out-of-subtree
  overlays.
- Script font loading, mixed-direction names/comments/URLs/identifiers,
  locale-aware dates/numbers/percentages, directional icons, calendars, and
  any audited complex component.
- Existing locales on every shared or direction-sensitive surface changed by
  this operation, so a regression is assigned only to locales proven affected.

Use real configured locales for both directions when the resulting locale set
is mixed. For a same-direction set, add a browser-only pseudo-opposite locale
so this localization change cannot introduce a future LTR/RTL regression.

For static modes, verify equivalent locale URLs/builds. For runtime modes, set
`runtimeSwitching: true`, set `defaultLocaleId`, and include two round trips for
every real non-default locale: default -> locale -> default and locale ->
default -> locale. Do not require every possible locale pair, and do not use
pseudo locales for application-switch transitions. Preserve route, form state,
focus, and application state without page reload. Use bare `preserve`
selectors only for form controls; declare text, attribute, or property
preservation evidence for tabs, panels, counters, and other non-form state.
Every real locale, including the default, needs a reusable application
activation action. Do not use `use-current` for a real runtime locale because
the round trip must be able to restore it after switching away.
Separately verify persisted selection, browser-language matching, invalid
saved-value fallback, and that stale resource requests cannot overwrite a
newer selection.

Do not expose a pending locale through a normal selector or switching path for
testing. For each unavailable runtime locale, add a development-only
`window.__powerPagesLocalizationAudit.activate(locale)` adapter behind the
framework's development-mode guard. It must invoke the same coordinator and
resource-loading behavior through a dedicated
`activateLocaleForAudit(locale)` operation while bypassing availability only
for the audit.
Use only the run-spec `audit-activate` action (plus waits when needed) for that
locale, and list every normal locale-selector surface in
`unavailableSelectors`. The rendered audit verifies those selectors are absent
before each component and transition activation. Normal detection, metadata,
and production output must continue to reject the locale and are enforced by
source validation; never create an unconditional production bypass.

Run:

```bash
node "${PLUGIN_ROOT}/scripts/audit-rendered-bidirectional-readiness.js" \
  --url "<DEV_SERVER_URL>" \
  --projectRoot "<PROJECT_ROOT>" \
  --spec "<TEMP_SPEC_PATH>" \
  --evidence-dir "<PROJECT_ROOT>/docs/bidirectional-evidence/<RUN_ID>" \
  --output "<PROJECT_ROOT>/docs/bidirectional-evidence/<RUN_ID>/report.json"
```

Parse stdout even when the expected blocking exit code is `1`. Exit code `2`
means the runner or specification failed. Delete the temporary specification
after the report is written. Fix every rendered error and rerun affected
cases. Give every review finding explicit evidence and a proposed disposition
for the Phase 7 maker decision.

Re-run the static audit after remediation and reconcile its exact current
findings with the rendered report. Update each locale's provisional readiness before Phase 7, then derive the
overall status: any pending locale makes the overall status
`pending-remediation`; otherwise any locale approved with limitations makes it
`approved-with-limitations`; otherwise it is `ready`.

- With any static or rendered error, retain the unresolved finding and mark
  every locale in its `affectedLocales` as `pending-remediation`.
- With review findings but no errors, keep each affected locale
  `pending-remediation` until the maker disposes every review item.
- For a locale with no unresolved findings, set its entry to `ready`. Remove it
  from `unavailableLocales` and update every managed availability boundary.
- Do not change an existing ready locale merely because another locale remains
  pending.

A known usable limitation may become `approved-with-limitations` only after
maker approval in Phase 7. A visible opaque third-party surface, unreadable or
clipped text, incorrect direction, unreachable control, broken focus order,
or state-losing locale switch cannot be approved as ready.

For an explicitly unverified package, all build, initialization, switching or
route navigation, resource loading, `lang`/`dir`, and console checks are
mandatory. If any check fails, stop and recommend the framework package; do
not silently replace the approved package.

Repeat the AI translation warning when applicable.

---

## Phase 7: Review changes

Present files as **Created**, **Updated**, **Preserved**, or **Skipped**, each
with a one-line reason. Include locale/key counts, blank/stale values,
translation warning, build result, browser checks, and RTL areas needing
manual visual review. Present the reconciled component scope with each
classification and the applicable states/viewports exercised. The
pre-implementation plan is scope, not evidence; report the implementation and
rendered checks that satisfied each direction-aware, direction-fixed, and
unknown/third-party entry.
Include the rendered report path, passed/review/failed case totals, and
failure/review screenshots. The run specification is temporary workflow input,
not a new project inventory.

Classify each newly added or regression-tested locale as:

- **Ready** — the new locale may be enabled.
- **Approved with limitations** — only usable degradation remains; show the
  exact component/page impact and browser evidence.
- **Pending remediation** — build/runtime failure, incorrect `lang`/`dir`,
  unreadable text, unreachable critical controls, or serious accessibility
  failure remains; keep the affected locale unavailable.

<!-- gate: add-localization:7.review | category=plan | cancel-leaves=localized-site-files -->

> 🚦 **Gate (plan · add-localization:7.review):** Maker accepts the verified localization result or requests a focused revision.
>
> **Trigger:** Build, validator, and browser verification have completed.
> **Why we ask:** Translation wording and selector placement require maker review even when technical checks pass.
> **Cancel leaves:** Localized site files — the verified localization changes remain on disk for review or revision.

Use `AskUserQuestion`:

- For **Ready**: **Accept changes** and **Request revisions**.
- For usable limitations: **Fix before enabling**, **Enable with documented
  limitations**, **Save but keep locale unavailable**, and **Request revisions**.
- For **Pending remediation**: **Fix blockers now**, **Save but keep locale
  unavailable**, and **Request revisions**. Do not offer enablement.

Explicit acceptance applies only to usable degradation. It cannot override a
build/runtime failure, incorrect direction, unreadable content, unreachable
critical control, or serious accessibility failure. Apply requested revisions,
then repeat Phase 6 and this gate.

After the maker's choice, finalize `.powerpages-localization.json`:

- **Accept changes:** set the reviewed locale entries to `ready` and remove
  findings that affected only those locales.
- **Enable with documented limitations:** retain only the accepted
  review-severity findings, set each affected locale entry to
  `approved-with-limitations`, remove those locales from
  `unavailableLocales`, and add a `disposition` to every retained finding with
  `status: maker-approved`, the exact component/page impact, the report or
  screenshot evidence path, and an ISO `approvedAt` timestamp. Accepted review
  checks that are not limitations are removed from the unresolved finding
  arrays.
- **Save but keep locale unavailable:** keep the affected locale entries
  `pending-remediation`, retain the undisposed findings, and keep only those
  affected locales unavailable.

Never add a maker-approved disposition to an error finding. After changing
status or availability, rerun the independent validator, project build, and
the locale activation cases affected by that change. Do not complete the
workflow until the final manifest, selector/detection boundaries, and actual
rendered availability agree. If the maker saves a pending locale, do not offer
deployment in Phase 8.

---

## Phase 8: Record usage and complete invocation

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Record usage with skill name `AddLocalization`.

Present a final localization summary before returning or offering deployment.
Include the final readiness status, available and unavailable locales, static
and rendered finding totals, the rendered report path, every maker-approved
limitation with its impact/evidence, and the manifest path. Do not describe a
locale as enabled when it remains in `unavailableLocales`.

If `$ARGUMENTS` contains `[FROM_CREATE_SITE]`, return control to create-site
without asking about deployment.

For direct invocation only:

<!-- gate: add-localization:8.deploy | category=plan | cancel-leaves=localized-site-files -->

> 🚦 **Gate (plan · add-localization:8.deploy):** Offers deployment after a standalone localization run.
>
> **Trigger:** Direct invocation was accepted and usage tracking completed.
> **Why we ask:** Deployment targets environment state and must remain a separate maker decision.
> **Cancel leaves:** Localized site files — the completed localization remains on disk for later deployment; no deploy fired.

Use `AskUserQuestion` with **Deploy now (Recommended)** and **Skip for now**.
Invoke `/power-pages:deploy-site` only when selected.

## Progress tracking

| Task subject | Active form | Description |
|---|---|---|
| Detect project localization | Detecting localization | Inspect framework evidence and existing localization |
| Gather localization configuration | Gathering configuration | Validate locales, default, mode, package, and translation method |
| Approve localization plan | Reviewing localization plan | Present exact delta and obtain approval |
| Configure localization infrastructure | Configuring localization | Install approved tooling and initialize framework integration |
| Localize site content | Localizing site content | Extract keys, populate locales, and add selector/navigation |
| Verify localization | Verifying localization | Run validator, build, Playwright, token, fallback, and RTL checks |
| Review localization changes | Reviewing localization changes | Present inventory and apply requested revisions |
| Complete localization workflow | Completing localization | Track usage and conditionally offer deployment |
