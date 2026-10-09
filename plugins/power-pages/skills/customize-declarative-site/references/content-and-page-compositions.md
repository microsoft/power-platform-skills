# Declarative Content and Page Planning

Use this reference when `customize-declarative-site` must turn an outcome such as “add an FAQs
page” into resolved visitor-facing content and a supported page composition.

## Content reasoning

Before asking for content, inspect the selected site's pages, navigation, terminology, enabled
languages, reusable snippets, assets, templates, and similar visitor journeys. Classify proposed
content as:

1. **Known** — explicitly supplied by the user or present in the site.
2. **Safely draftable** — explanatory copy that does not assert a business policy or unpublished
   fact.
3. **Confirmation required** — dates, prices, eligibility, legal terms, cancellation/refund
   policies, service levels, contact details, or any other organization-specific commitment.

Draft categories, headings, introductions, transitions, and general explanatory copy from the
first two groups. Ask for all confirmation-required facts together. Never invent them, hide them
behind placeholders, or ask the user to write an entire page when only a few facts are missing.

For an FAQ page, derive candidate categories from the site's audience and visitor journey. For an
event site these can include registration, eligibility, pricing, schedule, venue, accessibility,
cancellation, and support. Present only categories relevant to the inspected site.

## Clarification defaults

Prefer one compact clarification round. Resolve safe defaults from the site:

- route: derive a conventional route from the page name;
- locale: use the default website language unless additional enabled languages are requested;
- template: reuse the closest verified sibling page template;
- layout: reuse an established site-local pattern when it fits;
- styling: preserve the existing visual language unless visual change is requested;
- navigation: mirror comparable informational pages, but ask when primary versus footer placement
  materially changes the user's intent.

For an explicit new-site design handoff, use the approved `newSiteDesign` and shared
`${PLUGIN_ROOT}/references/site-design-quality.md` instead of the preservation-only styling
default. Design a cohesive complete experience with purposeful imagery, hierarchy, and responsive
section rhythm. The native Bootstrap/Studio structure and platform behavior remain protected;
the baseline's generic appearance is not a design requirement.

Use [page blueprints](../../../references/page-blueprints.md) to select narrative beats and a
role-appropriate first screen from that same brief. Translate ideas through the native structures
below: a product-moment split may use supported one-third or equal columns, not a guessed 7/5
Studio serialization; a bento-like composition is supported sections/columns/elements, not a new
component type. Keep the primary task clear without forcing oversized hero text onto every native
form or list. A signature moment must use an approved, genuinely available capability or static
explanatory composition, not invented data or new behavior.
Read only the relevant blueprint/narrative patterns, not the SPA implementation contract. These
are conceptual patterns, not required component types or serialized layouts. Keep existing native
color roles and Bootstrap breakpoints rather than imposing SPA token names or grid counts.
Do not invent testimonials, service levels, metrics, endorsements or live status counts, even
behind a source comment. Use confirmed capability or truthful process explanation instead.
Only when the calling scope expressly permits sample content, label it visibly as sample content
and report it before any separately approved deployment.

Do not ask about UUIDs, metadata filenames, serialization, indentation, escaping, or routine
accessibility attributes.

## Site header planning

For new-site design or full-site redesign, include a concrete header treatment derived from the
experience brief: brand name/logo, navigation hierarchy, any requested primary action, spacing,
typography, surfaces and states, and the narrow-screen menu arrangement. Reuse known decisions
instead of starting another questionnaire. The creation template supplies component/domain
context, not a visual constraint; do not retain its default header merely because it was selected.
This header treatment is part of the required custom site composition, not a substitute for
designing Home and the primary visitor journey.

For every header update, including a header-only request, explicitly assess whether the logo or
wordmark matches the website's approved name and brand requirements. Plan its replacement when
it does not; changing header colors or navigation alone does not resolve an unsuitable starter
logo. Follow **Logos and favicons** in [visual asset planning](visual-asset-planning.md) for source
selection, justified retention and unresolved brand decisions. Reuse those decisions rather than
adding a separate logo questionnaire.

Resolve the active header binding and real source/callers before assigning work. Plan localized
brand text or snippet-backed logo values through `author-content-snippet`, header markup/Liquid
through `author-web-template`, and visual treatment through the final `style-site` pass. Navigation
record changes use their verified owner; do not hardcode a replacement menu or invent destinations.
Trace desktop and mobile logo variants, image URLs or wordmark values, accessible brand names,
home links and requested locales in the actual callers; do not assume a snippet name or one shared
value covers them all. Include logo source/value changes before final sizing and responsive styling.
Use only the owners needed by the approved change. Preserve the existing binding and record IDs
when modifying the bound source; a new header binding requires explicitly approved global scope.

Preserve required navigation, search, language selection, sign-in/out and anonymous/authenticated
branches, accessible labels/skip links, native responsive behavior, and narrowly scoped dynamic
`substitution` regions. These are functional contracts, not a requirement to keep the starter's
visual layout. Do not duplicate the global header inside page content or hide it with CSS.
Keep logo delivery and source verification within the existing visual-asset contract.

Make the header outcome, including its logo decision, visible in the existing plan summary and
relevant component/styling cards. If the user requests preservation, or an inspected existing header already meets the
approved direction, record what remains and why in `preservation`; template selection alone
is not a preservation reason. Do not add a no-op owner task. Unresolved bindings or unavailable
source are readiness findings with remediation, not a claim that customization succeeded.
Narrow existing-site work leaves unrelated header content and appearance unchanged.

## Example page compositions

Compose these patterns from the supported Design Studio layouts and page elements. A “card” here
means a column containing supported elements and later styled as one surface; it is not a native
`type: card` component.

These examples are non-exhaustive and are not a catalog of allowed page designs. Prefer a
composition derived from the user's goal and a suitable existing site-local pattern. Use any
valid combination of supported layouts and elements, and combine or adapt the examples below
when they help.

| Pattern | Composition |
|---|---|
| Hero | One or two columns containing text, image, and buttons |
| Feature cards | Two or three columns; each column contains text/image/button elements |
| FAQ list | One column containing semantic question headings and answer text |
| FAQ categories | Card-style category columns followed by one-column FAQ sections |
| Image and text | Two equal, one-third-left, or one-third-right layout |
| Call to action | One column containing concise text and one or more buttons |
| Statistics | Three columns containing value and label text |
| Resource links | Repeated card-style columns containing text and buttons |

Choose structure in this order:

1. inspect a similar existing page and reuse its verified composition when appropriate;
2. choose one of the patterns above;
3. map every section to a supported layout;
4. map each column to ordered supported elements: text, image, button, video, or spacer;
5. add `style-site` only when the requested result requires presentation not already supplied by
   the selected local pattern.

For new-site designs, include the final coordinated `style-site` treatment from the approved
brief after every structural operation. Pass the verified Bootstrap major to the page-content
owner; use the Bootstrap 5 examples only on verified Bootstrap 5 sites.
Carry the approved narrative and first-screen intent in the resolved composition and `designContext`.
Do not repeat the full design review at each page-element handoff.

When an image is proposed, follow `visual-asset-planning.md` first. The content composition must
consume the approved direct HTTPS URL for a new-site image addition. Put it in static inputs or
the image's `source`; do not invent an import dependency or create a Web File. Existing image
URLs can be reused, and explicitly selected file imports outside URL-based creation use an
`outputBindings` value from an earlier `author-web-file` operation. Never place a local filesystem
path, symbolic asset name, gallery-page URL, or Design Studio placeholder data URI into the page.

Do not invent a new Design Studio component serialization. If the request requires unsupported
nested markup or behavior, disclose the boundary and propose the closest supported composition.

## Minimal skill selection

Invoke only owners required by the resolved structure:

- page metadata, route, template, localized shells, navigation: `author-webpage`;
- localized section/column/element composition: `author-webpage-content`;
- uploaded assets: `author-web-file`;
- reusable text or Liquid values: `author-content-snippet`;
- Liquid source or reusable layout logic: `author-web-template`;
- a new page-template binding: `author-page-template`;
- local visual treatment: `style-site`.

A straightforward page normally needs only `author-webpage`, which can invoke
`author-webpage-content` with the resolved composition. Do not add assets, snippets, templates, or
styling operations merely because those skills are available.
