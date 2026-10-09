# Design Studio Section Layouts

Canonical reference for skills that add a page element in a new Power Pages Design Studio
section or edit an existing section layout. The five column structures below were
observed in PAC CLI-downloaded webpage HTML. Microsoft documentation describes adding
components to sections but does not specify this serialized HTML contract.
These are default recipes, not a limit on classic section design. Broader approved local
geometry must preserve native editing boundaries, identities, locale and required behavior.
Report **Studio editing compatibility unverified** when canvas selection, control mapping,
drag/reorder or save/reopen behavior has not been established. Missing editing evidence alone
does not block safe local composition or require a new Studio example; known incompatibilities,
unsafe source and unresolved scope remain blockers. Do not add a new gate or deploy automatically.
For example, `row-reverse` loses Studio drag-and-drop support; use another composition method
when retaining that capability is required. See
[Studio page editing](https://learn.microsoft.com/power-pages/getting-started/customize-pages).

First follow `${PLUGIN_ROOT}/skills/classic-site-skills/page-elements/references/design-studio-component-authoring.md`: derive the
target section, requested layout, component placement, and preservation requirements from
the user's prompt and existing markup; use engineering judgment for safe mechanical
details; ask only when component-to-column mapping or another structural choice is
materially ambiguous.

## Bootstrap version

The examples below are **Bootstrap 5 new-section examples**, including `text-start`. Use them
for a newly created site only after the creation workflow has verified Bootstrap 5 asset evidence.
For an existing site, preserve its inspected native serialization and Bootstrap major; do not
upgrade it or import another framework to match these examples.

For a verified Bootstrap 3 site with no comparable section (for example an empty page), keep
the native section/container/column structure but use its supported `text-left` rather than
Bootstrap 5 `text-start` for the illustrated left-aligned LTR content. Honor existing RTL/language
alignment instead of mechanically applying left alignment. Check any other version-specific
utilities against the site's version. Unknown or conflicting Bootstrap evidence must be resolved
before introducing version-specific markup, not guessed from the template or data model.

Sources: [Power Pages Bootstrap 5](https://learn.microsoft.com/power-pages/configure/bootstrap-version-5),
[Bootstrap 5 text](https://getbootstrap.com/docs/5.3/utilities/text/),
[Bootstrap 3 text alignment](https://getbootstrap.com/docs/3.4/css/#type-alignment).

## Layout selection

The names below remain backward-compatible shortcuts. Also accept an explicit ordered
native column composition from the approved design; a missing recipe name is not a blocker.
Preserve the section/container/column boundaries and inspected Bootstrap major. Do not
claim Studio controls or save/reopen behavior for an unobserved arrangement.

| Design Studio option | Bootstrap columns, in order |
|---|---|
| One column | `col-lg-12` |
| Two equal columns | `col-lg-6`, `col-lg-6` |
| Three equal columns | `col-lg-4`, `col-lg-4`, `col-lg-4` |
| One-third left | `col-lg-4`, `col-lg-8` |
| One-third right | `col-lg-8`, `col-lg-4` |

The `col-lg-*` values describe the large-screen width. Each observed column also has
`min-width: 250px`, so columns can wrap on narrower screens.

The Design Studio menu also displays **Spacer**. It is not a column layout; use
`${PLUGIN_ROOT}/skills/classic-site-skills/page-elements/references/design-studio-spacer-component.md` for its PAC-observed
component and full-width forms.

### Explicit native grid and responsive styling

For an explicit large-screen Bootstrap grid, each planned column may supply an integer
`span` from 1 through 12, mapped to `col-lg-<span>` for the verified Bootstrap version.
All columns must supply spans when any does. `3+3+3+3`, `3+9` and `7+5` are examples, not
another allowlist. Preserve intentional unused space or wrapping instead of forcing a sum
of 12 or stretching equal columns. A conflicting named preset and span list needs a clear
non-preset layout name; do not silently pick one.

Keep **Studio editing compatibility unverified** visible for explicit geometry. Native
markers, valid grid classes and local validation are not a Studio round-trip test.
For CSS-driven widths, responsive grouping, gaps or alignment, resolve the actual targets
and use the normal `style-site` approval. Sample `min-width`, padding, margins and flex values
are defaults, not immutable design tokens; coordinate their winning declarations with the
approved layout so they do not undo intended proportions. Do not inject nested rows merely
to simulate a new component, or remove native boundaries for visual convenience. Where a
broader structure has unobserved editing behavior, disclose it without prohibiting safe
local implementation; known incompatible editing operations remain out of scope.

## Component placement

Replace exactly one `<!-- COMPONENT_HTML -->` marker below with the approved component
markup and remove the marker. For multi-column layouts, move the marker to the column
selected by the user. Preserve every unselected column as an empty
`.columnBlockLayout`.

These templates are for a newly approved section only. When adding to an existing
section, preserve its current structure and insert only the component into the selected
existing column.

## One column

```html
<div class="row sectionBlockLayout text-start" style="display: flex; flex-wrap: wrap; margin: 0px; min-height: auto; padding: 8px;">
  <div class="container" style="display: flex; flex-wrap: wrap;">
    <div class="col-lg-12 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px; padding: 16px; margin: 60px 0px;"><!-- COMPONENT_HTML --></div>
  </div>
</div>
```

## Two equal columns

```html
<div class="row sectionBlockLayout text-start" style="display: flex; flex-wrap: wrap; margin: 0px; min-height: auto; padding: 8px;">
  <div class="container" style="padding: 0px; display: flex; flex-wrap: wrap;">
    <div class="col-lg-6 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px;"><!-- COMPONENT_HTML --></div>
    <div class="col-lg-6 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px;"></div>
  </div>
</div>
```

## Three equal columns

```html
<div class="row sectionBlockLayout text-start" style="display: flex; flex-wrap: wrap; margin: 0px; min-height: auto; padding: 8px;">
  <div class="container" style="padding: 0px; display: flex; flex-wrap: wrap;">
    <div class="col-lg-4 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px;"></div>
    <div class="col-lg-4 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px;"><!-- COMPONENT_HTML --></div>
    <div class="col-lg-4 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px;"></div>
  </div>
</div>
```

## One-third left

```html
<div class="row sectionBlockLayout text-start" style="display: flex; flex-wrap: wrap; padding: 8px; margin: 0px; min-height: auto;">
  <div class="container" style="padding: 0px; display: flex; flex-wrap: wrap;">
    <div class="col-lg-4 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px;"></div>
    <div class="col-lg-8 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px;"><!-- COMPONENT_HTML --></div>
  </div>
</div>
```

This observed sample places the component in the wider right column. The user can instead
select the narrower left column.

## One-third right

```html
<div class="row sectionBlockLayout text-start" style="display: flex; flex-wrap: wrap; padding: 8px; margin: 0px; min-height: auto;">
  <div class="container" style="padding: 0px; display: flex; flex-wrap: wrap;">
    <div class="col-lg-8 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px;"><!-- COMPONENT_HTML --></div>
    <div class="col-lg-4 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px;"></div>
  </div>
</div>
```

This observed sample places the component in the wider left column. The user can instead
select the narrower right column.

## Editing an existing section layout

Treat a layout change as a structural migration, not as a class rename. First identify
one exact outer `.row.sectionBlockLayout` and its direct `.container` and
`.columnBlockLayout` children. Do not select a nested spacer, component-owned row, or
multiple visually similar sections.

Before editing, inventory every direct child component in each source column in document
order. Present the current layout, requested target layout, and an explicit mapping from
each existing component to a target column. Require the user to resolve any ambiguity.
Changing layout must not silently discard, duplicate, or reorder components.

To apply an approved layout edit:

1. Preserve the selected outer section's unrelated attributes, such as `id`,
   `data-component-theme`, classes beyond the layout contract, and non-layout styles.
2. Replace only the approved container/column structure and layout-specific declarations
   needed for the resolved target, retaining native editing boundaries.
3. Move each existing component exactly once according to the approved mapping while
   preserving its markup byte-for-byte where practical.
4. Preserve component order within each target column.
5. Leave newly introduced target columns empty unless the mapping assigns content.
6. Remove source columns only after confirming all their child nodes were mapped or
   explicitly accounted for as approved removals.

For a many-to-one migration, define the interleaving order when components come from
multiple source columns. For a one-to-many migration, require a destination column for
every component. If text nodes, Liquid blocks, comments, or malformed markup sit between
columns, treat them as content that also needs an explicit destination; do not drop them.

Do not edit component properties while changing layout unless those edits were separately
requested and included in the preview. Do not change one-third orientation by merely
swapping `col-lg-4` and `col-lg-8`; preserve the approved component-to-column mapping.

After migration, verify the resolved column order/widths and the component inventory against
the approved mapping. Layout-only moves keep counts and identities; a coordinated replacement
also verifies explicit additions/removals and retained native dependencies. Do not verify by
membership in the five-recipe list.

## Preservation rules

- Keep prescribed grid spans as their intended Bootstrap classes. Approved CSS-driven sizing
  belongs to the guarded styling owner, not an arbitrary structural-authoring substitution.
- Preserve native section boundaries; nested structure must have an explicit purpose and
  editing-compatibility disclosure, never an invented Studio component contract.
- Preserve the exact `container`, `sectionBlockLayout`, and `columnBlockLayout` classes.
- Preserve unrelated native declarations and their order during structural authoring.
  An approved visual change belongs to `style-site`, which can
  update the actual winning inline declaration without replacing the native structure.
- Do not add content to unselected columns.
- Do not leave the `<!-- COMPONENT_HTML -->` marker in the edited page.
- If the target page already demonstrates a different serialization for the selected OOB
  layout, preserve the page-local convention rather than rewriting it to match this reference.
- Confirm only approved sections changed; every retained child is present exactly once and
  every approved removal is absent, without deleting backing records or unrelated callers.
