# Site Modification Integrity

Apply this contract whenever a skill, agent, or manual change adds or changes visible SPA
content after site creation. It keeps localization and bidirectional behavior as lifecycle
properties rather than one-time scaffolding tasks.

## Before editing

1. Locate the code-site root by finding `powerpages.config.json`.
2. Read `.powerpages-localization.json` when it exists. Do not create localization infrastructure
   merely because a site is single-language.
3. Read `references/bidirectional-design.md`. Preserve the site's established framework,
   component patterns, design system, and localization package.

## Visible content

When a localization manifest exists:

- Put every new user-visible string behind a stable semantic translation key. This includes page
  copy, navigation, buttons, headings, form labels, placeholders, validation messages, loading,
  empty and error states, dialog text, image alternatives, accessible names, document titles, and
  visible metadata.
- Add each key to every configured locale resource. Preserve existing keys and translations.
- Follow `translationMethod`: generate a translation for `agent`; add an empty target value for
  `blank`. Never copy source-language prose into a target locale as if it were translated.
- Preserve interpolation variables, markup placeholders, and protected tokens exactly.
- For static localization, update the localized route/page output required by the framework.
- Do not expose a locale listed in `unavailableLocales` through selectors, auto-detection,
  alternate links, navigation, or generated production routes.

When no localization manifest exists, keep visible strings organized so `/add-localization` can
extract them later, but do not introduce an i18n dependency or manifest.

## Direction and layout

- Use logical CSS properties and direction-neutral component APIs. An intentional physical
  declaration needs the adjacent exception documented by `bidirectional-design.md`.
- Keep DOM, reading, focus, and visual order aligned. Do not use CSS reversal to simulate RTL.
- Isolate user-generated or externally sourced mixed-direction values using semantic `dir`
  handling, normally `dir="auto"` at the smallest useful boundary.
- Use the active locale for `Intl` formatting and the locale coordinator for runtime language,
  direction, font-profile, and geometry-change updates.
- Classify new directional images or icons as unchanged, mirrored, or replaced. Do not mirror
  text, trademarks, media controls, or universally directional symbols.

## Content expansion

Design text containers to wrap and grow:

- Avoid fixed width or height on containers that hold translated text.
- Allow labels, buttons, navigation, cards, tables, dialogs, and form errors to reflow.
- Prefer flexible min/max constraints and test long strings, narrow viewports, zoom, and both
  directions. Truncation is acceptable only when the full value remains accessible.

## Completion

Run the normal skill validator, then:

```bash
node "${PLUGIN_ROOT}/scripts/validate-site-integrity.js" --projectRoot "<PROJECT_ROOT>"
```

Deterministic localization or bidirectional errors block completion. Review findings such as
fixed text geometry, visual reordering, transforms, gradients, and clipping must be inspected in
both directions and with expanded content; they do not fail the command by themselves. Deployment
runs the same validator as a final backstop for changes made outside a skill.
