# Design Studio Spacer Component

Shared reference for skills that add or edit a spacer on a Power Pages Design Studio page
in a PAC CLI-downloaded declarative site. This reference applies to localized webpage
content under `web-pages/`.

First follow `${PLUGIN_ROOT}/references/design-studio-component-authoring.md`: derive the
page, locale, target spacer or insertion point, placement form, height, and background
theme from the user's prompt and existing markup; use engineering judgment for safe
mechanical details; ask only about material ambiguity. This reference supplies
spacer-specific markup, edit boundaries, safety, preservation, and verification rules.

Microsoft Learn documents that a spacer adds space between page sections and supports a
palette-based background plus configurable height. The exact HTML below comes from
PAC-downloaded Design Studio samples; Microsoft Learn does not specify the serialized
markup.

## Target file contract

Edit only the selected localized content file:

```text
web-pages/<page-directory>/content-pages/<Page>.<locale>.webpage.copy.html
```

Do not substitute the page-level `<Page>.webpage.copy.html`. The calling skill is
responsible for selecting the page and language and obtaining approval for the precise
placement.

## Two observed placements

The supplied PAC markup demonstrates two distinct placements:

1. **Inside a column** — a spacer component nested in an existing
   `.columnBlockLayout`.
2. **Between sections** — a full-width spacer represented directly in the page body,
   with no `.container` or `.columnBlockLayout` wrapper.

Do not interchange these shapes. Use the form that matches the placement selected by
the user.

## Spacer inside a column

Insert only this empty element at the approved position inside the selected
`.columnBlockLayout`:

```html
<div data-component-theme="portalThemeColor4" class="row sectionBlockLayout" style="display: flex; flex-wrap: wrap; padding: 8px; margin: 0px; min-height: 15px;"></div>
```

For example, the supplied one-column sample serializes as:

```html
<div class="row sectionBlockLayout text-start" style="display: flex; flex-wrap: wrap; margin: 0px; min-height: auto; padding: 8px;">
  <div class="container" style="display: flex; flex-wrap: wrap;">
    <div class="col-lg-12 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px; padding: 16px; margin: 60px 0px;"><div data-component-theme="portalThemeColor4" class="row sectionBlockLayout" style="display: flex; flex-wrap: wrap; padding: 8px; margin: 0px; min-height: 15px;"></div></div>
  </div>
</div>
```

When adding a spacer to an existing one-, two-, three-, `4+8`, or `8+4` section, do
not recreate the section. Add only the empty spacer element to the selected existing
column.

## Full-width spacer between sections

Insert this form as a direct sibling between two existing page sections:

```html
<div data-component-theme="portalThemeColor5" class="row sectionBlockLayout" style="display: flex; flex-wrap: wrap; padding: 8px; margin: 0px; min-height: 15px;"></div>
```

The supplied sample also demonstrates a spacer without an explicit theme:

```html
<div class="row sectionBlockLayout" style="display: flex; flex-wrap: wrap; padding: 8px; margin: 0px; min-height: 15px;"></div>
```

A full-width spacer has no child `.container` or `.columnBlockLayout`. Do not wrap it
in an otherwise empty column section.

## Height

The supplied sample uses:

```css
min-height: 15px;
```

Use `15px` when reproducing that sample. If the user explicitly selects another spacer
height, store the approved value in `min-height`; do not change the other observed style
declarations.

Accept only a finite, nonnegative CSS length explicitly supported by the skill. Reject
CSS expressions and values containing declarations, braces, or URLs. When the desired
height came from an existing Design Studio spacer, preserve its exact value.

## Background theme

`data-component-theme="portalThemeColor4"` and
`data-component-theme="portalThemeColor5"` in the supplied markup are examples of
palette selections, not universal defaults.

- Use a `portalThemeColor*` value already observed in the site or explicitly selected
  from the site's theme palette.
- Preserve the exact attribute when copying an existing spacer's appearance.
- Omit `data-component-theme` when the user selected the default or inherited appearance
  and the page's generated markup follows the theme-less form.
- Do not translate a palette token into a hard-coded color.
- Do not invent an unobserved `portalThemeColor*` value.

## Component integrity

- Keep the spacer element empty; do not put text, buttons, images, or other components
  inside it.
- Keep `row sectionBlockLayout` together in the class list.
- Do not add `text-start`; the supplied spacer itself does not use that class.
- Preserve `display: flex`, `flex-wrap: wrap`, `padding: 8px`, and `margin: 0px`.
- Change only `min-height` and `data-component-theme` when those properties were
  explicitly selected.
- A spacer is decorative layout. Do not add focus behavior, links, `role`, `tabindex`,
  or an accessible name to the empty element.

## Editing an existing spacer

Spacer identification requires care because both spacers and ordinary page sections use
`row sectionBlockLayout`. A candidate spacer must be empty, have a finite
`min-height` such as `15px` rather than `auto`, and match one of the two observed
placements:

- directly inside a selected `.columnBlockLayout`; or
- directly between page sections with no container child.

Report each candidate's placement, height, theme attribute, and neighboring content. If
multiple spacers could match, require explicit selection; never update every
`sectionBlockLayout`.

The editable properties are `min-height` and `data-component-theme`. Preserve the class
list, other style declarations, exact placement, and empty content. To remove a
background selection, remove only `data-component-theme`; do not add a hard-coded
background color. To change the height, replace only the `min-height` value after
validating it.

Moving a spacer is a separate structural edit: remove the exact selected empty element
and insert that same element at the approved destination. Do not move its parent column
or section. Converting a column spacer to a full-width spacer, or the reverse, requires
explicit approval because its parent relationship changes.

Deleting a spacer must remove only the selected spacer element. Do not delete its parent
column or section even if that wrapper becomes empty unless wrapper deletion was
separately requested and approved.

## Preserve the existing page

- Read the complete target `.webpage.copy.html` before editing.
- Make the smallest possible insertion.
- Preserve existing Liquid, sections, columns, theme attributes, inline styles,
  indentation, and line endings.
- Do not reformat unrelated markup.
- Insert the spacer only at the exact approved position.
- Apply the spacer only to the selected locale.

## Verification checklist

After editing:

1. Re-read the complete localized `.webpage.copy.html` file.
2. Confirm all previous page content remains.
3. Confirm the spacer is empty and has `row sectionBlockLayout`.
4. Confirm a column spacer is inside the approved `.columnBlockLayout`.
5. Confirm a full-width spacer is a direct page-body sibling with no container wrapper.
6. Confirm `min-height` matches the approved height.
7. Confirm the theme attribute matches the approved palette value or is intentionally
   absent.
8. For an edit, confirm exactly one selected spacer changed and no ordinary content
   section was mistaken for a spacer.
9. Confirm no other locale or page-level copy changed.
10. Review the local diff before any `pac pages upload`.

Editing the downloaded file changes only the local copy. A skill using this reference
must not upload or deploy unless the user separately requests and approves that action.

## Microsoft documentation

- [Add a spacer](https://learn.microsoft.com/power-pages/getting-started/add-spacer)
