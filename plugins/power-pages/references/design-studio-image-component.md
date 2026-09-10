# Design Studio Image Component

Shared reference for skills that add or edit an image on a Power Pages Design Studio page
in a PAC CLI-downloaded declarative site. This reference applies to localized webpage
content under `web-pages/`.

First follow `${PLUGIN_ROOT}/references/design-studio-component-authoring.md`: derive the
page, locale, target image or insertion point, source, alternative text, sizing,
alignment, and optional link from the user's prompt and existing markup; use engineering
judgment for safe mechanical details; ask only about material ambiguity. This reference
supplies image-specific markup, edit boundaries, safety, preservation, and verification
rules.

Microsoft Learn documents that Design Studio can use an uploaded image, an external URL,
or an available template image. It also supports alignment, links, width, height, and
alternative text. The exact HTML below comes from PAC-downloaded Design Studio samples;
Microsoft Learn does not specify the serialized markup.

## Target file contract

Edit only the selected localized content file:

```text
web-pages/<page-directory>/content-pages/<Page>.<locale>.webpage.copy.html
```

Do not substitute the page-level `<Page>.webpage.copy.html`. The calling skill is
responsible for selecting the page and language and obtaining approval for the exact
insertion point.

When the image needs a new section, use the approved layout from:

```text
${PLUGIN_ROOT}/references/design-studio-section-layouts.md
```

Replace the selected layout's `<!-- COMPONENT_HTML -->` marker with only the approved
`<img>` element or linked-image markup. When inserting into an existing section, preserve
its structure and add only the image component to the selected `.columnBlockLayout`.

## Baseline image contract

The supplied PAC examples use this responsive sizing:

```html
<img src="/Example.png" alt="Description of the image" name="Example.png" style="width: 100%; height: auto; max-width: 100%;" />
```

- `src` identifies the image resource.
- `alt` provides the text alternative.
- `name` records the uploaded web-file name in the observed local-image markup.
- `width: 100%` fills the selected column.
- `height: auto` preserves the source aspect ratio.
- `max-width: 100%` prevents overflow beyond the column.

Use the user's image and alternative text; `Example.png` and the sample description are
placeholders only.

## Image source types

### Design Studio placeholder

Before an image is selected, Design Studio can serialize a generated SVG placeholder as
a base64 data URI:

```html
<img src="data:image/svg+xml;base64,<DESIGN_STUDIO_PLACEHOLDER_DATA>" style="width: 100%; height: auto; max-width: 100%;" />
```

Treat the base64 payload as opaque. Preserve an existing placeholder if the user wants
to leave it unchanged, but do not generate, decode, edit, or copy a placeholder payload
into a new component. Do not accept an arbitrary user-provided data URI as an image
source.

For a finished image component, replace the placeholder with an approved uploaded image
or HTTPS image URL and apply the appropriate alternative text.

### Uploaded or existing site image

An uploaded image is referenced by its site-root-relative web-file path:

```html
<img src="/PWALogo.png" alt="Power Apps logo" name="PWALogo.png" style="width: 100%; height: auto; max-width: 100%;" />
```

Before using a local path:

1. Confirm the binary exists under `<PROJECT_ROOT>/web-files/`.
2. Confirm its adjacent `.webfile.yml` record exists.
3. Confirm the YAML `adx_partialurl` matches the root-relative `src`.
4. Preserve the exact filename casing used by the web-file record.
5. Set `name` to the observed filename when matching the Design Studio upload form.

Adding an image reference does not upload a new image. If the requested image is not
already represented as a PAC web file, the calling skill must handle that separate
workflow or stop and explain the missing prerequisite.

### External image

Microsoft Learn requires external image URLs to use HTTPS:

```html
<img src="https://cdn.example.com/images/banner.jpg" alt="Team collaborating in an office" style="width: 100%; height: auto; max-width: 100%;" />
```

- Require an absolute `https://` URL.
- Reject `http://`, protocol-relative URLs, active-content schemes, and data URIs.
- Confirm the URL identifies an image resource, not an ordinary webpage. A marketplace
  or gallery page URL is not necessarily a directly renderable image.
- Do not add a `name` attribute unless that attribute is present in an observed
  Design Studio serialization for the selected source.
- Warn that externally hosted images depend on the remote host's availability,
  permissions, hotlink policy, and response headers.

## Section layout examples

The image component works in any of the five shared OOB layouts:

- one column (`12`);
- two equal columns (`6+6`);
- three equal columns (`4+4+4`);
- one-third left (`4+8`);
- one-third right (`8+4`).

For example, an uploaded image in the left column of a two-column section is:

```html
<div class="row sectionBlockLayout text-start" style="display: flex; flex-wrap: wrap; margin: 0px; min-height: auto; padding: 8px;">
  <div class="container" style="padding: 0px; display: flex; flex-wrap: wrap;">
    <div class="col-lg-6 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px;"><img src="/PWALogo.png" alt="Power Apps logo" name="PWALogo.png" style="width: 100%; height: auto; max-width: 100%;" /></div>
    <div class="col-lg-6 columnBlockLayout" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 250px;"></div>
  </div>
</div>
```

For a different layout or target column, use the shared section template rather than
manually changing widths.

## Sizing and alignment

Use the observed responsive style unless the user explicitly requests dimensions:

```css
width: 100%; height: auto; max-width: 100%;
```

When reproducing an existing fixed-size Design Studio image, preserve its observed
dimensions and alignment, for example:

```html
<img src="/Example.png" alt="" name="Example.png" style="width: 200px; height: 161px; margin-left: auto; margin-right: auto;" />
```

- Use positive finite dimensions.
- Preserve aspect ratio unless the user explicitly requests cropping or distortion.
- Do not combine conflicting fixed and responsive dimensions.
- Reuse observed alignment styles from the target site rather than inventing
  platform-specific classes.
- Do not add border radius, shadows, or other decoration unless requested.

## Alternative text

- For an informative image, require concise `alt` text that communicates the image's
  purpose or equivalent information.
- For a purely decorative image, use `alt=""`.
- Do not derive alternative text only from the filename.
- Do not omit `alt` from the finished component.
- Localize alternative text in each language-specific page; never copy one language's
  text to every locale automatically.

## Linked images

Microsoft Learn supports linking an image to a URL or page in the same site. Wrap the
image in an anchor:

```html
<a href="/application-guide">
  <img src="/GuideCover.png" alt="Open the application guide" name="GuideCover.png" style="width: 100%; height: auto; max-width: 100%;" />
</a>
```

- Use a confirmed root-relative path for an internal page.
- Require HTTPS for an external destination.
- Reject `javascript:`, `data:`, and `vbscript:` destinations.
- Add `target="_blank" rel="noopener noreferrer"` only when the user explicitly chooses
  new-window behavior.
- Make the image's `alt` text describe the linked purpose, not only its appearance.

## Editing an existing image

The calling skill must identify one existing `<img>` before editing it. Report each
candidate's section, column, `src`, `alt`, `name`, dimensions, surrounding link, and
nearby content. If multiple images could match, require explicit selection; do not replace
every occurrence of a filename or URL.

Treat the selected `<img>` and, when present, its immediate link wrapper as the edit
boundary. Editable properties include:

- image source;
- `alt` text and observed `name`;
- width, height, max-width, and alignment styles;
- optional link destination and window behavior.

For a source replacement:

1. Validate the new local web file or HTTPS URL before changing `src`.
2. Update `name` only when the selected source form uses it; remove a stale local filename
   when changing to an external source unless page-local generated markup shows otherwise.
3. Reassess `alt`; do not retain text that describes the old image.
4. Preserve unrelated styles, classes, and attributes.

To add a link, wrap only the selected image in an anchor. To remove a link, unwrap the
image but keep the `<img>` at the same sibling position. To edit a link, change only the
wrapper's navigation attributes and preserve unrelated `rel` tokens.

Do not overwrite or delete the old binary or `.webfile.yml` merely because the page now
uses another image; that web file can be shared elsewhere. Do not replace an existing
base64 placeholder across the page globally. If changing fixed dimensions to responsive
sizing or vice versa, show the complete old and new `style` values for approval.

## Preserve the existing page

- Read the complete target `.webpage.copy.html` before editing.
- Make the smallest possible insertion.
- Preserve existing Liquid, sections, columns, classes, `data-*` attributes, inline
  styles, indentation, and line endings.
- Do not reformat unrelated markup.
- Insert the image only at the exact approved position.
- Apply localized alternative text only to the selected locale.

## Verification checklist

After editing:

1. Re-read the complete localized `.webpage.copy.html` file.
2. Confirm all previous content remains.
3. Confirm the image is inside the approved `.columnBlockLayout`.
4. Confirm `src` is the selected site-root-relative web file or absolute HTTPS URL.
5. For a local image, confirm the binary and `.webfile.yml` exist and match the path.
6. Confirm `alt` is present and appropriate for informative or decorative use.
7. Confirm dimensions preserve the approved behavior and do not overflow the column.
8. Confirm any image link uses an approved safe destination and window behavior.
9. Confirm no placeholder base64 remains unless the user explicitly retained it.
10. For an edit, confirm exactly one selected image/link boundary changed and the old
    image resource was not deleted.
11. Confirm no other locale or page-level copy changed.
12. Review the local diff before any `pac pages upload`.

Editing the downloaded file changes only the local copy. A skill using this reference
must not upload or deploy unless the user separately requests and approves that action.

## Microsoft documentation

- [Add an image](https://learn.microsoft.com/power-pages/getting-started/add-image)
