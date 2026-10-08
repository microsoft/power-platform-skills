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

Prefer one compact clarification round. For existing-site work without a redesign request,
resolve safe defaults from the site:

- route: derive a conventional route from the page name;
- locale: use the default website language unless additional enabled languages are requested;
- page-template binding: reuse a compatible verified sibling page template;
- layout: reuse an established site-local pattern when it fits;
- styling: preserve the existing visual language unless visual change is requested;
- navigation: mirror comparable informational pages, but ask when primary versus footer placement
  materially changes the user's intent.

For an explicit new-site design handoff, use the approved `newSiteDesign` and shared
`${PLUGIN_ROOT}/references/site-design-quality.md` instead of the layout-reuse and styling
defaults above. The creation template supplies data-model/domain and requirements context and
reusable native components; it does not constrain appearance, page composition, layout, branding,
or presentation. Retain
explicit preservation preferences, required content/capabilities and working data bindings, not
the starter arrangement by default. Design purposeful imagery, hierarchy and responsive section
rhythm, freely recomposing supported native sections/columns/elements in the approved scope.
Native Bootstrap/Studio serialization and platform behavior remain protected. A PAC page-template
binding is a rendering contract, not the creation template's visual identity: reuse it when
compatible with the brief, or route an approved layout/binding change to its native owner.

## New-site custom layout planning

Require an original, requirement-led page composition, not a cosmetic refresh of the selected
creation template. Complete this reasoning within the existing plan preparation, not a new
approval stage:

1. Inventory reusable **components** independently of layout: required forms, lists, snippets,
   navigation/authentication behavior and useful content. Resolve each component's source,
   identity, bindings, callers, locale and any positioning dependency. Preserving a form's
   behavior does not mean preserving the hero or section arrangement around it.
2. Design Home and the primary visitor journey from the experience brief before choosing a
   starter-page pattern. Specify the first-screen hierarchy, section purposes and sequence,
   supported column composition, image/copy balance, actions, responsive stacking and placements
   for reused components. Include the shared header/footer treatment where it shapes that
   experience. Do not use the starter outline as the default outline.
3. Map that composition to actual native owner operations and exact source targets. Record
   section/column/element decisions and existing-component destinations in `inputs`, and the
   required source/bindings and explicit user exceptions in `preserve`. Use
   `newSiteDesign.composition` for the overall rationale, not as a substitute for those executable
   details. Resolve all required layout work before the final dependent `style-site` operation.
4. State what is reused as a component, what surrounding composition changes, and what remains
   only because the user explicitly requested it. Show these decisions in the existing plan's
   summaries, inputs and wireframes. A preserved logo or working registration form does not
   preserve the whole page. Reuse generic native grid primitives without copying the starter
   page's full composition; do not churn IDs or change sections merely to inflate a diff.

For example, a student-camp site can reuse a verified program list, registration form and
eligibility snippet while composing a student-focused first screen, an activity-led introduction,
program discovery and a clear registration path. Their real bindings and required content stay;
the starter hero, sequence, surrounding layout and decorative treatment are not inherited.
This is an example of component reuse, not a mandated camp layout or permission to invent programs.

Do not create `type: form`, `type: list` or `type: reuse` as new page-element serializations. A
reused component is existing verified source or an existing Liquid/snippet reference with an
explicit destination, handled through the native owner that can safely retain/place it.
Return unsupported relocation or unknown dependencies for resolution rather than omitting a
required component, substituting static HTML, or keeping the whole starter layout silently.

In the existing final verification, compare the actual source composition with both the plan
and downloaded baseline. A rename, copy/image swap or palette change on the same starter
composition is not a custom-layout result. Missing planned layout work is incomplete, even
when individual edits validate. Report rendered appearance as unobserved until actually checked;
no browser, screenshot, diff-size threshold or additional approval gate is introduced.

## Applying page blueprints

Use [page blueprints](../../../references/page-blueprints.md) to select narrative beats and a
role-appropriate first screen from that same brief. Translate ideas through the native structures
below: a product-moment split may use supported one-third or equal columns, not a guessed 7/5
Studio serialization; a bento-like composition is supported sections/columns/elements, not a new
component type. Keep the primary task clear without forcing oversized hero text onto every native
form or list. A signature moment must use an approved, genuinely available capability or static
explanatory composition, not invented data or new behavior.
Read only the relevant blueprint/narrative patterns, not the SPA implementation contract. These
are conceptual patterns, not required component types or serialized layouts. Choose color roles
for the approved design and use supported Bootstrap breakpoints rather than imposing SPA token
names or grid counts; the starter palette is not mandatory for new-site design.
Do not invent testimonials, service levels, metrics, endorsements or live status counts, even
behind a source comment. Use confirmed capability or truthful process explanation instead.
Only when the calling scope expressly permits sample content, label it visibly as sample content
and report it before any separately approved deployment.

Do not ask about UUIDs, metadata filenames, serialization, indentation, escaping, or routine
accessibility attributes.

## Example page compositions

Compose these patterns from the supported Design Studio layouts and page elements. A “card” here
means a column containing supported elements and later styled as one surface; it is not a native
`type: card` component.

These examples are non-exhaustive and are not a catalog of allowed page designs. Derive the
composition from the user's goal and approved brief. For new-site work, compose the required
custom layout with these primitives, not the starter page as a whole. For existing-site narrow
work, reuse suitable site-local patterns within the requested scope.

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

1. derive the first screen and narrative from the approved intent; inspect similar pages for
   required content, data bindings and supported native serialization;
2. for new-site work, author the custom composition with supported native primitives and place
   reusable components within it; for existing-site narrow work, adapt the suitable local pattern;
3. map every section to a supported layout;
4. map each column to ordered supported elements: text, image, button, video, or spacer;
5. for existing-site narrow work, add `style-site` only when the requested presentation needs it.

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
