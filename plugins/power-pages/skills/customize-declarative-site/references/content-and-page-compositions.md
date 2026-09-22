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

Do not ask about UUIDs, metadata filenames, serialization, indentation, escaping, or routine
accessibility attributes.

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

When an image is proposed, follow `visual-asset-planning.md` first. The content composition must
consume an existing verified Web File URL or an `outputBindings` value from an earlier
`author-web-file` operation. Never place an Unsplash hotlink, local filesystem path, symbolic
asset name, or Design Studio placeholder data URI into the finished page.

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
