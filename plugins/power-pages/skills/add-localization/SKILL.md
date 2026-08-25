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

Read `${PLUGIN_ROOT}/references/i18n-frameworks.md` before planning or editing.

## Core principles

- Detect framework and existing localization from project evidence.
- Preserve valid package, mode, default locale, and non-empty translations.
- Ask questions in the fixed order below; skip only documented conditional
  questions.
- Validate language tags and package alternatives with deterministic scripts.
- Require plan approval before package installation or project-file changes.
- Use agent-generated translation only during authoring; never add a deployed
  translation service or credentials.
- Always show: **AI translations may contain errors - please verify them before publishing.**
- Treat `[FROM_CREATE_SITE]` in `$ARGUMENTS` as invocation context. It suppresses
  this skill's deploy prompt so create-site remains deployment owner.

## Workflow

1. Detect project and existing localization.
2. Gather and validate configuration.
3. Present and approve the implementation plan.
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

- React: runtime; state the decision without asking.
- Vue: runtime; state the decision without asking.
- Angular new setup: use `AskUserQuestion` with **Static locale builds with
  @angular/localize (Recommended)** and **Runtime switching with Transloco**.
- Astro: static locale routes; state the decision without asking.
- Add-languages mode: preserve the detected mode without asking.
- Repair mode: ask only when Angular mode is changing or mode evidence
  conflicts.

### 2.4 Package

<!-- not-a-gate: package selection is validated before plan approval -->

For new setup or relevant repair, use `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Which localization package should be used? | Package | Framework recommendation (Recommended), Suggest a different package, Cancel |

Skip for Astro built-in i18n and add-languages mode. Validate alternatives:

```bash
node "${PLUGIN_ROOT}/scripts/validate-i18n-package.js" --projectRoot "<PROJECT_ROOT>" --framework "<FRAMEWORK>" --package "<PACKAGE>" --version "<VERSION_OR_RANGE>" --mode "<runtime|static>"
```

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

---

## Phase 3: Plan and approve

Present:

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
- Known limitations and any approved translation replacements.

<!-- gate: add-localization:3.plan-approval | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · add-localization:3.plan-approval):** Approves the complete localization delta before dependencies or site files change.
>
> **Trigger:** The deterministic plan and file inventory have been presented.
> **Why we ask:** A wrong package, mode, default locale, or extraction scope can touch most visible UI files.
> **Cancel leaves:** Nothing — discovery and validation were read-only.

Use `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| How should the localization plan proceed? | Plan | Approve and implement (Recommended), Revise configuration, Cancel |

Loop through Phase 2 for revisions. Do not install or edit before approval.

---

## Phase 4: Configure localization infrastructure

Install only approved stable packages using the project's package manager.
Follow `${PLUGIN_ROOT}/references/i18n-frameworks.md` for the selected
framework/mode.

Adopt valid existing conventions rather than creating a second initialization
or resource hierarchy. In repair mode, apply only the approved delta. Never
remove a package, switch Angular mode, or replace custom initialization unless
the approved plan names that change.

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

Write `.powerpages-localization.json` using reference schema version 1
after the approved implementation is complete. Record `packageVerification`
from the package-validator result. For an unverified alternative, record
`status: unverified`, `source: user-approved`, and the official evidence URL
when one was supplied. Record `initializationEvidence` when deterministic
framework patterns do not recognize the selected package. Set `lastOperation` to `create`,
`add-languages`, `repair`, or `reconfigure`, and set `translationMethod` to
`agent` or `blank`.

---

## Phase 6: Verify localization

Run the independent validator:

```bash
node "${PLUGIN_ROOT}/skills/add-localization/scripts/validate-localization.js" --projectRoot "<PROJECT_ROOT>"
```
Fix all reported errors.

Run the project's existing build. Start or reuse its dev server and verify
with Playwright:

- Default locale and one target locale.
- Selector behavior or equivalent static locale navigation.
- Representative translated content.
- `html[lang]` and `html[dir]`.
- Browser console has no localization errors.
- One RTL locale when configured.

For static modes, verify equivalent locale URLs/builds. For runtime modes,
verify persisted selection, browser-language matching, invalid saved-value
fallback, and no page reload during switching.

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
manual visual review.

<!-- gate: add-localization:7.review | category=plan | cancel-leaves=localized-site-files -->

> 🚦 **Gate (plan · add-localization:7.review):** Maker accepts the verified localization result or requests a focused revision.
>
> **Trigger:** Build, validator, and browser verification have completed.
> **Why we ask:** Translation wording and selector placement require maker review even when technical checks pass.
> **Cancel leaves:** Localized site files — the verified localization changes remain on disk for review or revision.

Use `AskUserQuestion` with **Accept changes** and **Request revisions**. Apply
requested revisions, then repeat Phase 6 and this gate.

---

## Phase 8: Record usage and complete invocation

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Record usage with skill name `AddLocalization`.

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
