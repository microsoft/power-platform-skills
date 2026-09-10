# Design Studio Section Layouts

Shared reference for skills that add a component in a new Power Pages Design Studio
section or edit an existing section layout. The five column structures below were
observed in PAC CLI-downloaded webpage HTML. Microsoft documentation describes adding
components to sections but does not specify this serialized HTML contract.

First follow `${PLUGIN_ROOT}/references/design-studio-component-authoring.md`: derive the
target section, requested layout, component placement, and preservation requirements from
the user's prompt and existing markup; use engineering judgment for safe mechanical
details; ask only when component-to-column mapping or another structural choice is
materially ambiguous.

## Layout selection

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
`${PLUGIN_ROOT}/references/design-studio-spacer-component.md` for its PAC-observed
component and full-width forms.

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
2. Replace only the container/column structure and layout-specific inline styles needed
   for the selected OOB target.
3. Move each existing component exactly once according to the approved mapping while
   preserving its markup byte-for-byte where practical.
4. Preserve component order within each target column.
5. Leave newly introduced target columns empty unless the mapping assigns content.
6. Remove source columns only after confirming all their child nodes were mapped.

For a many-to-one migration, define the interleaving order when components come from
multiple source columns. For a one-to-many migration, require a destination column for
every component. If text nodes, Liquid blocks, comments, or malformed markup sit between
columns, treat them as content that also needs an explicit destination; do not drop them.

Do not edit component properties while changing layout unless those edits were separately
requested and included in the preview. Do not change one-third orientation by merely
swapping `col-lg-4` and `col-lg-8`; preserve the approved component-to-column mapping.

After migration, verify that the direct column classes exactly match one supported OOB
layout and that the before/after component inventory has identical counts and identities.

## Preservation rules

- Do not translate column widths into custom percentages.
- Do not add Bootstrap `.row` elements inside the observed section.
- Preserve the exact `container`, `sectionBlockLayout`, and `columnBlockLayout` classes.
- Preserve the inline style order and values from the selected template.
- Do not add content to unselected columns.
- Do not leave the `<!-- COMPONENT_HTML -->` marker in the edited page.
- If the target page already demonstrates a different serialization for the selected OOB
  layout, preserve the page-local convention rather than rewriting it to match this reference.
- For an edit, confirm exactly one selected section changed and every preexisting child
  component is present exactly once afterward.
