# Design Studio Iframe Component

Canonical reference for skills that add or edit an Iframe component on a Power Pages
Design Studio page in a PAC CLI-downloaded non-SPA site.

First follow
`${PLUGIN_ROOT}/skills/author-webpage-content/references/design-studio-component-authoring.md`:
derive the page, locale, target iframe or insertion point, URL, accessible title, sizing,
and alignment from the user's prompt and existing markup. This reference supplies the
iframe-specific serialization, safety, preservation, and verification rules.

Microsoft Learn documents that the Design Studio Iframe component embeds another webpage,
accepts a target URL, and supports alignment, duplication, movement, and deletion. Power Fx
can set component values, but its PAC-exported representation is not documented; do not
invent a Power Fx serialization without a downloaded example.

## Target file contract

Edit only the selected localized content file:

```text
web-pages/<page-directory>/content-pages/<Page>.<locale>.webpage.copy.html
```

Do not substitute the page-level `<Page>.webpage.copy.html`. The calling workflow owns page
and locale selection and approval of the exact insertion point.

When the iframe needs a new section, use the approved layout from:

```text
${PLUGIN_ROOT}/skills/author-webpage-content/references/design-studio-section-layouts.md
```

Replace the selected layout's `<!-- COMPONENT_HTML -->` marker with only the approved
iframe markup. When inserting into an existing section, add only the iframe to the selected
`.columnBlockLayout`.

## Component contract

Use a non-self-closing iframe with `frameborder="0"`, a target `src`, and inline sizing:

```html
<iframe frameborder="0" src="https://example.com/" style="width: 100%; height: 450px; max-width: 100%; margin-left: auto; margin-right: auto;"></iframe>
```

`https://example.com/` is only a neutral placeholder. Replace it with the user's approved
target URL.

Choose the section layout, column, position, sizing, and alignment from the user's request
and the target site's verified Bootstrap conventions. Do not impose a fixed wrapper.

For a completed accessible component, add a concise localized `title` while retaining the
same component boundary:

```html
<iframe frameborder="0" src="https://example.com/embedded-content" title="Embedded service status" style="width: 100%; height: 450px; max-width: 100%; margin-left: auto; margin-right: auto;"></iframe>
```

- Preserve `frameborder="0"` when creating or editing this PAC-observed component form.
- Preserve the non-self-closing `<iframe></iframe>` structure.
- Do not add `data-componentname="Video"`; that marker belongs to the video component.
- HTML-escape the URL and title before inserting them.
- Do not accept raw user-supplied iframe markup. Construct the element from approved values.

## URL and embedding safety

- Require an absolute HTTPS URL or a verified site-root-relative path.
- Reject `javascript:`, `data:`, `vbscript:`, `file:`, protocol-relative URLs, embedded
  credentials, and malformed URLs.
- Do not place credentials, access tokens, private sharing keys, or sensitive query values in
  committed iframe URLs.
- Treat a different origin as third-party content. Surface its privacy, cookie, tracking, and
  authentication implications before writing when they are material to the request.
- Do not add broad `allow` permissions or a permissive `sandbox` value without a verified need.
  If the target requires capabilities such as fullscreen, clipboard, camera, or microphone,
  gather and approve the minimum required policy explicitly.
- A valid URL can still refuse framing. The target can block embedding through
  `X-Frame-Options` or CSP `frame-ancestors`; the Power Pages site's CSP can also restrict the
  target through `frame-src`. A blocked frame is not evidence that the local HTML is malformed.
- Do not weaken site security headers automatically. Report the exact browser policy failure
  and route a separately approved header change through the owning security-header workflow.

## Sizing and alignment

```css
width: 100%; height: 450px; max-width: 100%;
```

- Use positive finite dimensions.
- Keep `max-width: 100%` so the iframe does not overflow its column.
- For centered alignment, add
  `margin-left: auto; margin-right: auto;`.
- For right alignment, add
  `margin-left: auto; margin-right: 0;`.
- For normal-flow or left placement, omit both horizontal margin declarations.
- Preserve a different verified site-local form when editing it.
- Reuse an existing site-local iframe's verified sizing or alignment when the user asks to
  match it.
- Do not add borders, shadows, scrolling rules, or responsive wrappers unless requested.
- A fixed height may need an approved responsive adjustment for narrow screens or unusually
  tall embedded content; do not guess the target document's required height.

## Accessibility

- Every iframe must have a concise, meaningful, localized `title` describing the embedded
  content or task.
- Do not use a URL, filename, “Iframe,” or “Embedded content” as the title when a more useful
  description is available.
- Do not add an empty `title` or `aria-label`.
- Ensure essential information and actions are not available only inside an inaccessible
  third-party frame.

## Editing an existing iframe

The calling skill must identify one generic iframe before editing it. Exclude
`<iframe data-componentname="Video">` candidates, which are owned by the video component
reference. Report each candidate's section, column, source, title, dimensions, alignment,
policy attributes, and nearby content. If multiple candidates could match, require explicit
selection; never replace every occurrence of a repeated URL.

Treat the selected `<iframe>...</iframe>` element as the edit boundary. Change only approved
properties:

- `src`;
- localized `title`;
- width, height, max-width, and alignment;
- narrowly approved `sandbox`, `allow`, `loading`, or `referrerpolicy` attributes.

Preserve `frameborder`, unrelated attributes, surrounding section and column markup, sibling
components, indentation, and line endings. Removing or broadening a security-policy attribute
is a separate material change and must not happen as incidental cleanup.

Moving an iframe between columns or sections is a separate structural edit. Inventory the
source and destination boundaries, preserve every sibling component, and use the approved
layout contract rather than rebuilding the page around the iframe.

## Preserve the existing page

- Read the complete target `.webpage.copy.html` before editing.
- Make the smallest possible insertion or replacement.
- Preserve Liquid, sections, columns, classes, `data-*` attributes, inline styles, comments,
  indentation, and line endings outside the selected boundary.
- Insert the iframe only at the exact approved position.
- Apply the localized title only to the selected locale.
- Do not reformat unrelated markup.

## Verification checklist

After editing:

1. Re-read the complete localized `.webpage.copy.html` file.
2. Confirm all previous content remains.
3. Confirm the iframe is inside the approved `.columnBlockLayout`.
4. Confirm `frameborder="0"` and the non-self-closing element form are preserved.
5. Confirm `src` is nonempty and is an approved HTTPS URL or verified root-relative path.
6. Confirm the localized `title` is nonempty and meaningfully describes the frame.
7. Confirm width, height, max-width, and alignment match the approved values.
8. Confirm no unapproved `allow`, `sandbox`, event-handler, or active-content attribute exists.
9. Confirm a generic iframe was not mislabeled as a Video component.
10. For an edit, confirm exactly one selected iframe boundary changed.
11. Confirm no other locale or page-level copy file changed.
12. Review the local diff before any `pac pages upload`.

Editing the downloaded file changes only the local copy. A skill using this reference must
not upload or deploy unless the user separately requests and approves that action.

## Microsoft documentation

- [Add an Iframe](https://learn.microsoft.com/power-pages/getting-started/add-iframe)
