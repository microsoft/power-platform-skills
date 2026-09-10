# Design Studio Button Component

Shared reference for skills that add or edit a Power Pages Design Studio-style button in
a PAC CLI-downloaded site. This reference applies to declarative Power Pages sites with
a root-level `.portalconfig` directory and `web-pages/` content. It does not apply to
Power Pages code sites built with React, Angular, Vue, or Astro.

First follow `${PLUGIN_ROOT}/references/design-studio-component-authoring.md`: derive the
page, locale, target or insertion point, label, destination, style, and window behavior
from the user's prompt and existing markup; use engineering judgment for safe mechanical
details; ask only about material ambiguity. This reference supplies button-specific
markup, edit boundaries, safety, and verification rules.

Microsoft documents that newly created button components use an `<a>` element for
navigation. Design Studio recognizes an anchor as a button component when its class
list includes `btn`.

## Relevant PAC download structure

```text
<site-root>/
├── .portalconfig/
├── website.yml
└── web-pages/
    └── <page-directory>/
        ├── <Page>.webpage.copy.html
        ├── <Page>.webpage.yml
        └── content-pages/
            ├── <Page>.<locale>.webpage.copy.html
            └── <Page>.<locale>.webpage.yml
```

The localized file under `content-pages/` is the editable page body shown to visitors
for that language:

```text
web-pages/<page-directory>/content-pages/<Page>.<locale>.webpage.copy.html
```

Do not assume the page-level `<Page>.webpage.copy.html` has the same content. It belongs
to the root webpage record and can be empty even when the localized content page contains
the rendered body.

## Target file contract

The skill must pass a localized
`web-pages/<page-directory>/content-pages/<Page>.<locale>.webpage.copy.html` file. Refuse
page-level copy files and paths outside `content-pages/`. The skill is responsible for
matching the localized record to its root webpage and confirming the language.

## Preserve the existing page

- Read the complete target `.webpage.copy.html` before editing it.
- Make the smallest possible insertion. Do not replace the whole page.
- Preserve existing Liquid tags, HTML entities, `data-*` attributes, classes, inline styles,
  indentation, and line endings.
- Do not reformat unrelated markup.
- Insert the button only at the exact section, column, and relative position approved by
  the user through the skill.
- When the approved placement is a new section, use the selected layout from
  `${PLUGIN_ROOT}/references/design-studio-section-layouts.md`.

## OOB section layouts

Design Studio provides five column layouts: one column, two equal columns, three equal
columns, one-third left, and one-third right. Their shared PAC-observed HTML is defined in
`${PLUGIN_ROOT}/references/design-studio-section-layouts.md`.

When adding a button to an existing section, add only the anchor inside the selected
`.columnBlockLayout`; do not add another section or container. When creating a new
multi-column section, replace the shared template's `<!-- COMPONENT_HTML -->` marker
with the approved button anchor and preserve the empty sibling columns.

## Button contract

The baseline button markup is:

```html
<a href="/contact-us" class="btn button1">Contact us</a>
```

- `Contact us` is only an example. The visible label can be any user-provided text, such
  as `Register`, `View application`, `Download guide`, or `Next`, after HTML escaping it.
- `a` provides navigation.
- `href` contains the destination.
- `btn` makes the anchor recognizable as a button component in Design Studio.
- `button1` applies the site's primary button styling.
- The anchor text is the visible, accessible button label.

Preserve a different button style class when the user selected an existing button to copy.
Do not invent a secondary-style class without first observing that class in the downloaded
site's markup or theme.

Legacy sites can contain `<button onclick="window.location.href='...'">` components. They
remain supported, but create new navigational buttons with the modern anchor structure.

## Destination patterns

### Page within the same site

Use a root-relative path beginning with `/`:

```html
<a href="/contact-us" class="btn button1">Contact us</a>
```

Prefer the selected page's `adx_partialurl` when generating the path. Preserve any intentional
parent-page segments and trailing-slash convention already used by the site.

### External website

Use an absolute URL, including the scheme:

```html
<a href="https://example.com/help" class="btn button1">Visit help center</a>
```

`href="example.com/help"` is not an external URL. Browsers interpret it as a path relative to
the current page. Normalize an intended external destination to `https://...` only after
confirming that intent with the user.

### Email and telephone

Design Studio supports `mailto:` and `tel:` links:

```html
<a href="mailto:support@example.com" class="btn button1">Email support</a>
```

```html
<a href="tel:+15550101234" class="btn button1">Call support</a>
```

### No destination yet

For the explicitly requested placeholder case, use the empty-destination markup supplied
with the page sample:

```html
<a href="" class="btn button1">Button</a>
```

Use this only when the user explicitly wants a placeholder. Explain that it does not provide
useful navigation and can reload the current page. If the requested control performs an action
instead of navigation, this anchor pattern is the wrong component; the implementing skill
should stop and gather the action behavior before adding markup.

## Open in the current or a new window

For the current window, omit `target`:

```html
<a href="https://example.com/help" class="btn button1">Visit help center</a>
```

For a new window or tab, add both `target="_blank"` and
`rel="noopener noreferrer"`:

```html
<a href="https://example.com/help" target="_blank" rel="noopener noreferrer" class="btn button1">Visit help center</a>
```

Use the same attribute pair for an internal link when the user explicitly chooses the
new-window option. `noopener` prevents the opened page from controlling the originating
window through `window.opener`; `noreferrer` also suppresses the referrer header.

Do not add `target="_blank"` merely because a link is external. The destination type and
window behavior are separate choices.

## Input safety and accessibility

- HTML-escape dynamic button labels and attribute values before insertion.
- Reject active-content schemes such as `javascript:`, `data:`, and `vbscript:`.
- Accept only a confirmed site-relative path or an expected URL scheme such as `https:`,
  `http:`, `mailto:`, or `tel:`.
- Prefer HTTPS for external web destinations.
- Require a concise, descriptive label that communicates the result of activating the button.
  Avoid labels such as "Click here."
- Do not add `role="button"` to an anchor with a real `href`; its native link semantics are
  correct for navigation.
- Do not add an empty `aria-label`. If visible text cannot describe the destination, gather
  an accessible label and add a nonempty `aria-label`.
- Do not nest interactive elements inside the anchor.

## Editing an existing button

The calling skill must identify one existing button before changing it. Locate candidates
only in the selected localized file and report each candidate's section, column, visible
label, `href`, classes, and nearby text. If more than one candidate could match, require
the user to select one; do not edit every matching label or URL.

Treat the selected `<a>` element as the edit boundary. Depending on the approved request,
the editable properties are:

- anchor text for the label;
- `href` for the destination;
- `target` and `rel` for window behavior;
- the observed button style class;
- a nonempty `aria-label` when the visible label is insufficient.

Preserve `btn`, all unrelated classes, unknown attributes, surrounding section/column
markup, sibling components, whitespace convention, and attribute order where practical.
Apply the same destination validation and escaping rules used for a newly added button.

When changing window behavior:

- current window: remove `target="_blank"` and remove only the
  `noopener noreferrer` tokens that were present solely for that target; preserve any
  unrelated `rel` tokens;
- new window: add `target="_blank"` and merge `noopener noreferrer` into `rel` without
  deleting existing tokens.

Do not silently convert legacy `<button onclick="...">` markup to an anchor during an
unrelated label or style edit. Treat legacy conversion as a separate approved change and
show the full replacement markup before applying it.

After editing, verify that exactly one intended button changed. If the new destination,
label, or behavior makes an existing attribute obsolete, remove only that attribute and
explain it in the preview.

## Verification checklist

After editing:

1. Re-read the exact localized `.webpage.copy.html` file and confirm that all previous content
   remains.
2. Confirm the new anchor is inside a `.columnBlockLayout`.
3. Confirm its classes include `btn` and the intended site button style.
4. Confirm the label and `href` are correctly escaped.
5. Confirm an internal link starts with `/`, or an external link includes its scheme.
6. Confirm new-window links contain both `target="_blank"` and
   `rel="noopener noreferrer"`; current-window links must not contain `target="_blank"`.
7. For an edit, confirm exactly one selected button changed and all unedited attributes
   and sibling components remain.
8. Confirm no other locale or page-level copy file changed.
9. Review the local diff before any `pac pages upload`.

Editing the downloaded files changes only the local copy. The change reaches Dataverse only
after the user deliberately uploads the site with PAC CLI. A skill that only adds the button
must not upload or deploy unless the user separately requests and approves that action.

## Microsoft documentation

- [Add a button](https://learn.microsoft.com/power-pages/getting-started/add-button)
- [Enhanced link creation in Design Studio](https://learn.microsoft.com/power-pages/important-changes-deprecations#enhanced-link-creation-in-design-studio)
