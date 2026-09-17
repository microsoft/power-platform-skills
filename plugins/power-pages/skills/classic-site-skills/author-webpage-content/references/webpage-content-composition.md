# Webpage Content Composition

Canonical composition rules for turning a resolved webpage design into one localized
`.webpage.copy.html` file in a PAC CLI-downloaded declarative Power Pages site.

This reference coordinates section and page-element contracts. It does not redefine the
serialized markup owned by the references under:

```text
${PLUGIN_ROOT}/skills/classic-site-skills/page-elements/references/
```

## Resolved composition contract

Normalize the request into this conceptual shape before editing:

```yaml
targetFile: web-pages/contact/content-pages/Contact.en-US.webpage.copy.html
locale: en-US
mode: create
sections:
  - layout: two-equal-columns
    attributes: {}
    columns:
      - elements:
          - type: text
            content: Contact our team
      - elements:
          - type: image
            source: /contact-team.jpg
            alt: Customer support team
resolvedDependencies:
  webFiles:
    contact-team.jpg: /contact-team.jpg
  snippets: {}
preserve: []
```

The request does not need to use YAML, but it must resolve the same decisions:

- one exact existing localized target file and its resolved locale;
- one operation mode;
- ordered sections;
- one supported layout for every new or structurally changed section;
- ordered columns matching that layout;
- ordered page elements within each column;
- final visitor-facing values and accessibility properties;
- final URLs, snippet names, and other external references;
- content that must be preserved during an existing-page operation.

Reject a handoff that still contains unresolved design tokens such as `heroImage`,
`primaryCtaUrl`, `TBD`, or `use the appropriate snippet`. Return those dependencies to
the orchestrator rather than guessing their values.

## Content ownership

Visitor-facing body content belongs in the selected localized file:

```text
web-pages/<page-directory>/content-pages/<Page>.<locale>.webpage.copy.html
```

The calling `author-webpage` workflow owns the corresponding root/localized metadata and
must create the target file before composition. This workflow does not inspect, create,
or repair webpage YAML. The root-level copy file is not an interchangeable target.

Compose only HTML in this workflow. Page metadata, summaries, custom CSS, custom
JavaScript, navigation, assets, snippets, and templates remain owned by their respective
authoring skills.

## Composition model

Treat the page as an ordered tree:

```text
page
└── section[]
    └── column[]
        └── element[]
```

Preserve order at every level. A page plan that lists section A before section B must
serialize A before B. Within a section, columns follow the selected layout from left to
right. Within a column, elements appear in the exact supplied order.

Each new section must use one supported Design Studio layout from
`${PLUGIN_ROOT}/skills/classic-site-skills/page-elements/references/design-studio-section-layouts.md`.
The number and width of direct `.columnBlockLayout` children must match that layout.

When a column contains multiple elements, place their component markup as consecutive
children of the same `.columnBlockLayout`. Do not wrap each element in another section,
container, or column. Preserve empty sibling columns required by the selected layout.

A spacer may be:

- an element within a selected column; or
- a full-width page-level form explicitly supported by the spacer reference.

Do not treat a spacer as a sixth column layout.

## Resolved rendered values

The caller resolves dependencies before invoking this workflow. Require the final values
that must appear in HTML:

| Rendered reference | Required handoff value |
|---|---|
| Web file | Final public URL |
| Internal page | Final route |
| Content snippet | Exact `adx_name` |
| Liquid variable or include | Final expression or include contract |
| External URL | Absolute safe URL with the required scheme |

Do not discover, create, or repair the underlying records. If a final rendered value is
missing, return its logical purpose, requested consumer, locale if applicable, and
expected value to the caller.

## Whole-page composition

Use this workflow for `create` and `replace`:

1. Read the complete current target file.
2. For `create`, require an empty file or an explicitly replaceable blank-page baseline.
3. For `replace`, inventory the current top-level sections, Liquid blocks, comments, and
   standalone nodes. Require the preservation contract to account for anything that
   cannot safely be discarded.
4. Load the section-layout reference and every component-specific reference needed by
   the plan.
5. Generate each component using its final resolved values.
6. For each section, start from the selected section layout and place all column
   elements in document order.
7. Concatenate completed sections in page order without adding an undocumented outer
   page wrapper.
8. Confirm that every requested element appears exactly once.
9. Write the complete body only after the full composition is internally coherent.

An empty page is valid only when the resolved plan explicitly requests no body content.
Do not create decorative, sample, or filler sections to make a page appear complete.

## Existing-page operations

Use the narrowest operation that satisfies the request:

### Append

Resolve whether the new content belongs:

- after the final top-level section;
- inside an identified existing column; or
- at another exact insertion boundary.

Do not interpret “add to the page” as permission to choose an arbitrary section or
column when several placements are plausible.

### Modify an element

Identify one exact component using its section, column, neighboring content, current
properties, and component-specific markers. Change only the selected component and its
mechanically required companion attributes.

### Modify a section layout

Follow the structural migration workflow in the section-layout reference. Inventory and
map every existing direct child before replacing columns. Do not combine this migration
with unrelated component redesign.

### Replace the page body

Treat replacement as destructive. Preserve only the nodes explicitly required by the
handoff, but do not discard unaccounted Liquid, scripts, forms, lists, entities, or
custom markup merely because they are absent from a visual mockup.

## Locale rules

One composition targets one locale. Never copy visitor-facing text from one language
into another as an inferred translation.

For a multilingual plan, process each locale as a separate resolved composition and
target file. Layout may be shared when the plan explicitly establishes it, but text,
alternative text, labels, titles, and other visitor-facing values must be supplied or
resolved for that locale.

## Safety and preservation

- Escape plain text and attribute values according to each component reference.
- Reject active-content URL schemes and unsafe user-supplied markup.
- Preserve existing Liquid and custom markup outside the approved boundary.
- Preserve page-local serialization when it is compatible with the requested Design
  Studio element instead of reformatting the whole file.
- Do not move meaningful inline CSS or JavaScript into companion files as an incidental
  cleanup.
- Do not add external libraries, tracking code, forms, data access, or authentication
  behavior unless the resolved plan and owning workflow explicitly provide them.
- Do not make unrelated visual improvements.

## Verification checklist

- [ ] The target is exactly one localized `.webpage.copy.html` file.
- [ ] The caller supplied one existing localized target file and locale.
- [ ] The operation mode and preservation contract match the performed edit.
- [ ] Top-level sections appear in the requested order.
- [ ] Each new or migrated section matches one supported layout.
- [ ] Direct columns have the expected count, width classes, and order.
- [ ] Every planned element appears exactly once in its assigned column and order.
- [ ] No `<!-- COMPONENT_HTML -->`, sample content, unresolved token, or TODO remains.
- [ ] No web-file URL, internal route, snippet name, or Liquid value remains symbolic.
- [ ] Text, links, images, buttons, videos, and spacers pass their component checklist.
- [ ] Accessibility values are present and meaningful where required.
- [ ] Unrequested locales and unrelated existing content are unchanged.
- [ ] Only the selected localized HTML file changed.

## Prohibited shortcuts

- Do not create or repair localized webpage metadata or companion files.
- Do not invoke separate element skills that edit the same target file independently.
- Do not copy an unrelated page as a design shortcut.
- Do not invent translations, assets, destinations, snippets, or Liquid contracts.
- Do not flatten a multi-column design into arbitrary custom markup.
- Do not replace an existing page merely because reconstructing it is easier than a
  precise edit.
