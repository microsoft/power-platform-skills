# Bidirectional Design Standard

Use this standard for every Power Pages code site, including sites that start
with only one LTR or RTL language. Bidirectional readiness is a design
foundation, not a retrofit performed only after an opposite-direction locale is
added.

## Locale, script, and direction

- Canonicalize locale tags as BCP-47.
- Resolve direction from the locale's explicit or likely writing script. Do not
  maintain a language-only RTL allowlist.
- Set both `lang` and `dir` on the root `<html>` element. `lang` controls
  linguistic behavior; `dir` controls base text and layout direction.
- For a single-language site, the root document is the persisted source of
  truth. Do not create localization infrastructure until localization is added.

References:

- https://www.w3.org/International/articles/language-tags/
- https://www.w3.org/TR/css-writing-modes-3/#text-direction
- https://www.unicode.org/reports/tr35/

## Direction-neutral layout

Use logical CSS whenever placement follows reading direction:

| Physical declaration | Logical declaration |
|---|---|
| `margin-left/right` | `margin-inline-start/end` |
| `padding-left/right` | `padding-inline-start/end` |
| `left/right` | `inset-inline-start/end` |
| `border-left/right` | `border-inline-start/end` |
| physical corner radii | `border-start/end-start/end-radius` |
| `text-align: left/right` | `text-align: start/end` |
| `width` for flow-relative sizing | `inline-size` |

Keep meaningful reading and focus sequence in DOM order. Do not simulate RTL
with reversed arrays, `row-reverse`, or `order`. A flex row already follows its
inherited inline direction.

Some geometry is intentionally physical: centering, maps, media timelines,
fixed lighting and shadows, charts with a fixed domain axis, or a product
requirement that keeps a control in one physical corner. Keep such behavior
only after verifying both directions and add an adjacent directive:

```css
/* bidi-physical: Map controls remain at physical right by product requirement; verify=ltr,rtl */
right: 1rem;
```

The directive applies only to the immediately following declaration. It must
contain a specific reason and `verify=ltr,rtl`; file-wide suppression is not
allowed.

Transforms, animation coordinates, gradients, shadows, clipping, canvas, SVG,
charts, horizontal scrolling, and third-party positioning do not become
logical automatically. Review their semantic direction component by component.

Reference: https://www.w3.org/TR/css-logical-1/

## Mixed-direction content

Classify inserted content at its rendering boundary:

- Translated UI content inherits the active document direction.
- Unknown or user-authored content such as names, comments, titles, and search
  queries uses `<bdi>` or `dir="auto"`.
- Machine-oriented values such as URLs, email addresses, source code, file
  paths, GUIDs, and Latin identifiers use an isolated explicit direction,
  normally `dir="ltr"`.
- Never reverse strings. Format numbers, dates, currency, percentages, and
  relative time with `Intl` APIs for the active locale.

Use `dir="auto"` on free-form multilingual inputs. Use the `dirname` form
attribute when the submitted value's detected direction must be preserved.

References:

- https://www.w3.org/International/questions/qa-html-dir
- https://www.w3.org/International/articles/inline-bidi-markup/
- https://www.unicode.org/reports/tr9/

## Typography and content flexibility

- Select fonts for the scripts used by configured locales, including shaping,
  glyph coverage, weights, combining marks, and punctuation.
- Reuse one font profile across languages when it supports their scripts well.
  Add script-specific profiles only when necessary, with locale-specific
  overrides for genuine typographic differences such as Urdu Nasta'liq.
- Preserve the site's visual character across script profiles.
- Do not rely on capitalization, Latin-style italics, or letter spacing for
  hierarchy. Avoid arbitrary letter spacing on cursive scripts.
- Avoid fixed-height text containers. Allow navigation, buttons, validation,
  cards, and headings to wrap and accommodate translated text expansion.
- For runtime localization, prepare a required target-script font before
  committing the visible locale switch when late loading would cause a
  significant layout shift.

References:

- https://www.w3.org/International/articles/typography/fontstyles.en.html
- https://www.w3.org/TR/alreq/

## Components, icons, and assets

Give every direction-sensitive component an explicit contract:

- Navigation, drawers, tabs, pagination, breadcrumbs, forms, calendars,
  date-pickers, carousels, timelines, charts, drag/drop, and gestures must be
  reviewed in both directions.
- Mirror icons whose meaning follows inline progression, such as previous/next
  and breadcrumb chevrons.
- Keep logos, maps, photographs, status marks, clocks, and media controls
  unchanged unless their specific semantics require otherwise.
- Classify images and illustrations as unchanged, mirrored, or replaced with a
  localized asset. Never mirror embedded text or trademarks.
- Decide whether table and chart order is linguistic or domain-fixed. Do not
  mirror chronological, scientific, or geographic meaning automatically.
- Native controls and scrollbars should inherit direction; custom horizontal
  scrolling must use semantic start/end operations rather than raw assumptions
  about `scrollLeft`.

Reference: https://learn.microsoft.com/en-us/globalization/fonts-layout/mirroring

## Localization modes and scoped coordination

- Single-language sites use static root `lang`/`dir` and do not receive a
  locale coordinator.
- Angular static localization and Astro built-in localization use
  locale-specific outputs/routes and do not receive a runtime coordinator.
- React, Vue, and runtime Angular use one locale coordinator as the authority
  for active locale, messages, canonical `lang`, resolved `dir`, script font
  profile, metadata, fallback, and persistence.
- A runtime switch prepares resources first and then commits locale-dependent
  state together. Stale requests cannot overwrite a newer selection.
- Add direction-change notifications only for components that cache physical
  geometry, such as charts, carousels, virtualized lists, grids, and overlays.

## First opposite-direction locale

When a locale set first changes from LTR-only or RTL-only to mixed direction,
run the bidirectional-readiness audit before implementation approval. Include
safe remediation, intentional physical exceptions, typography, assets,
mixed-content boundaries, and complex component behavior in the plan.

Use a tiered disposition:

- Build/runtime failures, incorrect `lang`/`dir`, unreadable text, unreachable
  critical controls, and serious accessibility failures keep the new locale
  unavailable to end users until fixed.
- Usable limitations may proceed only after the maker reviews the exact impact
  and explicitly approves enabling the locale with documented limitations.
- The maker may preserve localization work while keeping the locale
  unavailable for later remediation.

Unavailable locale resources may remain on disk, but one managed
`localeAvailability` module must export an `isLocaleAvailable` predicate that
excludes those locales. Selectors, browser detection and switching,
alternate-language metadata, and production static output must all apply it.
The manifest is a record of that state, not the mechanism that enforces it.
While hard bidirectional blockers remain, every configured locale opposite to
the default locale's direction stays unavailable.

Do not describe a technically broken or inaccessible locale as successfully
enabled.

## Verification

- Audit every generated or modified site, not only the first RTL locale.
- Test every representative route in LTR and RTL at desktop and narrow/mobile
  viewports.
- For runtime modes, test LTR -> RTL -> LTR and RTL -> LTR -> RTL without
  reload, stale requests, route loss, form-state loss, or focus loss.
- Verify calendars, gestures, overlays, charts, mixed-direction fixtures,
  script fonts, localized formatting, console output, and accessibility.
- Use expanded pseudo-LTR and pseudo-RTL content during site creation so future
  localization defects are found before real translations exist.
- Scan source and identifiers for unexpected Unicode bidi controls. Normal
  translated prose may legitimately contain controls; source-code exceptions
  require deliberate review.

High-visibility marketing, onboarding, legal, and brand content should receive
native-speaker or regional review before publication. Technical
bidirectionality does not replace cultural localization.
