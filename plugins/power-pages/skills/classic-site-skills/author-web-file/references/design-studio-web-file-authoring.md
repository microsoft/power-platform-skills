# Design Studio Web File Authoring

Canonical reference for workflows that create or modify web files in a PAC CLI-downloaded
declarative Power Pages site. This reference applies to sites with a root-level
`.portalconfig` directory, `website.yml`, `web-pages/`, and `web-files/` content. It does
not apply to Power Pages code sites built with React, Angular, Vue, or Astro.

A web file represents a site-served asset such as an image, stylesheet, script, document,
or text file. The local PAC representation contains both the asset and an adjacent YAML
record that describes the web file and its Dataverse note attachment.

## Web file creation workflow

Create a web file in this order:

1. Resolve `<SITE_ROOT>` by following
   `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`, requiring
   `web-pages/` and `web-files/`.
2. Resolve and validate the source file. Use only its basename; never reproduce an
   external directory path under `web-files/`.
3. Resolve the parent root webpage. For a new ordinary web-file record, also resolve
   the publishing state to inherit from that page.
4. Determine the final filename, partial URL, MIME type, visibility, search behavior,
   content disposition, and optional display order.
5. Check for collisions with existing web-file names, binary filenames, and URLs under
   the selected parent.
6. Generate separate web-file and annotation UUIDs with
   `${PLUGIN_ROOT}/scripts/generate-uuid.js`.
7. Copy the asset without changing its bytes.
8. Create the adjacent `.webfile.yml` metadata record.
9. Update only the separately approved page, template, CSS, JavaScript, or content
   references that should consume the file.
10. Verify the asset, metadata, URL, MIME type, permissions boundary, and callers.

Creating a web file does not automatically add it to a webpage, stylesheet, script,
header, footer, or navigation element.

## PAC download structure

Web files are stored directly under `web-files/`:

```text
<site-root>/
├── .portalconfig/
├── website.yml
├── web-pages/
└── web-files/
    ├── <filename>
    └── <filename>.webfile.yml
```

Examples:

```text
web-files/
├── Product-Guide.pdf
├── Product-Guide.pdf.webfile.yml
├── Site-Logo.png
├── Site-Logo.png.webfile.yml
├── custom-theme.css
└── custom-theme.css.webfile.yml
```

The asset filename and the YAML's `filename` value must match exactly, including casing
and extension. Keep both files directly under `web-files/`; the standard PAC shape does
not create one subdirectory per asset.

## Filename and URL convention

Preserve the site's existing conventions. When importing a new external file with no
stronger site-local convention:

- remove surrounding quote characters from the supplied path;
- use only the source basename;
- replace spaces with `-`;
- uppercase the first character of each space-separated segment;
- preserve the extension;
- use the resulting filename for `adx_name`, `adx_partialurl`, `filename`, the asset
  filename, and the `.webfile.yml` prefix.

For example:

```text
C:\assets\product guide.pdf
→ Product-Guide.pdf
→ web-files/Product-Guide.pdf
→ web-files/Product-Guide.pdf.webfile.yml
```

Do not apply this normalization to an existing web file as incidental cleanup. Changing
the filename or partial URL changes its public URL and requires dependency migration.

Downloaded sites can legitimately contain lowercase, mixed-case, underscore, dotted,
or otherwise site-specific filenames. Treat this normalization as a creation fallback,
not a reason to rename existing assets.

`adx_partialurl` is a URL path segment. Reject values containing query strings,
fragments, slashes, path traversal, or characters that are invalid for URL paths. Prefer
letters, numbers, hyphens, underscores, and the required file extension.

## Web file and attachment YAML

Create the metadata record adjacent to the asset:

```yaml
adx_enabletracking: false
adx_excludefromsearch: false
adx_hiddenfromsitemap: false
adx_name: <filename>
adx_parentpageid: <existing-parent-root-webpage-id>
adx_partialurl: <filename>
adx_publishingstateid: <existing-publishing-state-id>
adx_webfileid: <new-web-file-id>
annotationid: <new-annotation-id>
filename: <filename>
isdocument: true
mimetype: <detected-mime-type>
objectid: <new-web-file-id>
objecttypecode: adx_webfile
```

The first group describes the web-file record. The second group describes the note
attachment that stores the file content in Dataverse.

### Identity invariants

- `adx_webfileid` and `annotationid` must be different, valid UUIDs.
- `objectid` must exactly equal `adx_webfileid`.
- `objecttypecode` must be `adx_webfile`.
- `isdocument` must be `true`.
- `filename` must exactly match the adjacent asset filename.
- `adx_name` and `adx_partialurl` normally match that filename for a new asset.
- Never copy IDs from another web file.
- Preserve all IDs when replacing the bytes of an existing asset.
- The declarative site root supplies website context; do not add `adx_websiteid` merely
  because the Dataverse record has a Website relationship.

Do not add `documentbody` to the YAML. PAC stores the file bytes in the adjacent asset
file and uses the annotation metadata to reconstruct the note attachment.

Power Pages serves the attachment from the newest note associated with the web-file
record. The PAC file pair should represent the intended active attachment. Investigate
unexpected additional annotations rather than assuming older bytes will render.

## Parent page, URL, and permissions

`adx_parentpageid` should reference an existing root webpage record, not a localized
content-page record.

Power Pages technically supports specialized web files without a parent page, such as
files related through another portal content type. For ordinary site assets, require a
parent root webpage because it establishes the URL hierarchy and inherited page
permissions. Do not omit the parent merely to place a file at the site root; parent it to
the Home page instead.

The public URL is built from the parent page path and `adx_partialurl`:

```text
/<parent-page-path>/<web-file-partial-url>
```

A file parented to the Home page is commonly available at:

```text
/<web-file-partial-url>
```

Before selecting a parent:

1. Resolve the page-level `.webpage.yml`.
2. Confirm `adx_isroot: true`.
3. Use its `adx_webpageid`.
4. Identify the Home page structurally by `adx_partialurl: /`, not by assuming its
   `adx_name` is the English word `Home`.
5. Reuse its `adx_publishingstateid` unless another existing publishing state was
   explicitly selected.
6. Check for a sibling page or web file with the same partial URL.

Web-file access is controlled by the parent page's permissions. Moving a file to another
parent can change both its URL and who can access it. Treat a parent change as a
security-sensitive migration and review all references and permissions.

## MIME type

Set `mimetype` from the final asset filename and verify it agrees with the file content.
Common examples include:

| Extension | MIME type |
|---|---|
| `.css` | `text/css` |
| `.js` | `text/javascript` or the site-local JavaScript MIME convention |
| `.txt` | `text/plain` |
| `.json` | `application/json` |
| `.pdf` | `application/pdf` |
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.svg` | `image/svg+xml` |
| `.woff` | `font/woff` |
| `.woff2` | `font/woff2` |

Do not silently use `application/octet-stream` for a known browser asset. If the
extension is unknown or the detected type conflicts with the file content, stop and
resolve the type before creating the metadata.

Changing an extension requires updating the asset filename, metadata filename, name,
partial URL, MIME type, and every caller. Do not change only `mimetype` to disguise a
different file type.

## Visibility and delivery fields

### Publishing state

`adx_publishingstateid` records the file's publishing workflow state and can determine
whether the file is publicly visible. Resolve an existing publishing-state ID from the
selected parent or site metadata. Never invent an ID.

For a new ordinary web file, include the selected parent page's publishing state.
Existing PAC downloads can omit `adx_publishingstateid`, particularly on some image
assets. Preserve an existing omission during unrelated edits. Do not add a guessed state
as normalization; resolve and add one only when creating a new ordinary record or when
the requested change explicitly establishes publishing behavior.

### Search and sitemap

- `adx_excludefromsearch` controls search indexing.
- `adx_hiddenfromsitemap` controls inclusion in sitemap-driven navigation; it does not
  prevent direct access to the URL.
- A valid creation baseline is `false` for both fields, but downloaded sites commonly
  override one or both for CSS, images, and other assets.
- Prefer the nearest comparable site asset and the requested behavior over applying one
  blanket value by extension.
- Static implementation assets are commonly excluded from search. User-facing
  documents and images require a deliberate decision based on how the site exposes
  them.

### Tracking

`adx_enabletracking` is deprecated and no longer functional. Preserve an existing value
during unrelated edits. Use `false` for new files.

### Content disposition

Content disposition determines whether the browser attempts to display the file inline
or immediately treats it as a download:

```yaml
adx_contentdisposition: 756150000
```

- `756150000` means inline.
- `756150001` means attachment.

Add this field only when delivery behavior is intentional. Images, stylesheets, scripts,
and browser-rendered text normally need inline behavior. Downloadable documents may use
attachment when the user experience explicitly requires it.

### Optional metadata

PAC downloads can contain fields such as:

```yaml
adx_title: <optional-title>
adx_summary: <optional-summary>
adx_displayorder: <optional-order>
adx_displaydate: <optional-display-date>
adx_releasedate: <optional-release-date>
adx_expirationdate: <optional-expiration-date>
```

Preserve existing optional metadata. Add it only when it has a defined user-facing or
ordering purpose.

- `adx_displaydate` is presentation metadata and does not itself control visibility.
- `adx_releasedate` and `adx_expirationdate` bound when the file is visible.

## CSS web files

CSS files can participate in the site's global style loading order through
`adx_displayorder`.

- Inspect all existing CSS web-file records before choosing an order.
- Keep display-order values deliberate and non-conflicting.
- Files loaded later have higher CSS precedence.
- Do not deactivate, delete, rename, or reorder the default site CSS files as incidental
  cleanup.
- Do not replace the site's Bootstrap version or base theme through a routine web-file
  change.
- Custom CSS uploaded through the Styling workspace has separate product constraints,
  including its supported file-size limit.

Changing a CSS order can alter the complete site. Treat it separately from changing the
stylesheet's contents.

## Referencing web files

Use the web file's resolved site URL in HTML, Liquid, CSS, or JavaScript:

```html
<img src="/Site-Logo.png" alt="Contoso">
<a href="/Product-Guide.pdf">Download the product guide</a>
<link rel="stylesheet" href="/custom-theme.css">
<script src="/site-behavior.js"></script>
```

These are shape examples only. Derive the actual URL from the selected parent hierarchy
and `adx_partialurl`.

When adding a reference:

- use a root-relative site URL or the established site-local Liquid pattern;
- HTML-escape attribute values;
- provide meaningful alternative text for informative images;
- use empty alternative text only for decorative images;
- use `defer` or another established loading pattern for noncritical scripts;
- preserve integrity, cross-origin, referrer, and CSP-related attributes when replacing
  an existing external asset;
- update all references when the parent or partial URL changes.

Do not embed a local filesystem path in page or template markup.

## File validation and security

Treat every imported file as untrusted:

- confirm it is a regular file, not a directory, link, or special file;
- reject path traversal and filenames that escape `web-files/`;
- validate the extension, detected MIME type, and file signature where practical;
- reject executable or unsupported content;
- inspect SVG, HTML, JavaScript, and other active content for unsafe behavior;
- do not commit secrets, tokens, private keys, connection strings, internal URLs, or
  customer data;
- preserve binary files byte-for-byte and never process them through a text editor;
- confirm the file size is within the Dataverse note-attachment limit for every target
  environment.

Dataverse can block attachment extensions at the environment level. JavaScript, CSS, and
other required extensions can cause upload or solution-import failure when included in
the target environment's blocked-attachments setting. Check the target environment before
deployment. Do not weaken the environment policy without explicit approval.

## Modifying an existing web file

Resolve exactly one asset/YAML pair, confirm their filenames agree, and apply the smallest
change required.

| Requested change | Required files and checks |
|---|---|
| Replace file content with the same type | Replace only the asset bytes; preserve IDs and metadata unless a property also changed |
| Edit a text asset | Change only the asset file; preserve IDs and unrelated metadata |
| Rename the file | Rename the asset and YAML pair; update name, filename, partial URL, MIME type if needed, and every URL reference |
| Change extension or media type | Validate new content; update asset/YAML names, `mimetype`, name, partial URL, and every caller |
| Move under another parent page | Update `adx_parentpageid`; recalculate the URL; review page permissions and every reference |
| Change publishing state | Update only `adx_publishingstateid` after resolving an existing state |
| Add or change release/expiration dates | Update only the requested scheduling fields and verify the intended visibility window |
| Change search or sitemap behavior | Update the selected flag only |
| Change inline/download behavior | Update `adx_contentdisposition` only |
| Change CSS precedence | Update `adx_displayorder` after reviewing the full CSS order |

### Identity preservation

Do not regenerate these fields during a normal modification:

- `adx_webfileid`;
- `annotationid`;
- `objectid`.

`objectid` must continue to equal `adx_webfileid`. Regenerating either record ID can
create a second record, orphan the attachment, or disconnect existing references.

### Replacing content

When replacing the asset:

1. Confirm the existing file is the intended target.
2. Preserve its basename unless a rename was requested.
3. Preserve `adx_webfileid`, `annotationid`, and `objectid`.
4. Recalculate `mimetype` and compare it with the existing value.
5. If the MIME type or extension changes, treat the operation as a rename/type migration
   and update every caller.
6. Verify the final file is non-empty unless an empty text asset was explicitly intended.

Do not overwrite an unrelated asset merely because it has the same extension or similar
name.

### Rename and move safety

A rename, partial-URL change, or parent-page change alters the public URL:

1. Compute the old and new URLs.
2. Search webpages, web templates, content snippets, CSS, JavaScript, site settings, and
   other text assets for the old URL or filename.
3. Update only confirmed references.
4. Preserve record and annotation IDs.
5. Verify the old URL is no longer required.

Do not perform a broad replacement for a common filename or short URL segment.

## Deletion rules

Do not delete a web file until all dependencies are understood:

1. Search page content, web templates, content snippets, CSS, JavaScript, and metadata for
   its URL, partial URL, filename, and web-file ID.
2. Check whether the file is a default stylesheet, theme asset, logo, favicon, script,
   document, sitemap resource, or other site-wide dependency.
3. Confirm no page or component still requires the asset.
4. Remove or migrate approved references first.
5. Delete the binary and its `.webfile.yml` together.

Never delete a web file merely because one page stopped referencing it; assets can be
shared across the entire site.

## Verification checklist

After creating or modifying a web file:

1. Confirm the YAML parses successfully.
2. Confirm the asset and `<filename>.webfile.yml` both exist directly under `web-files/`.
3. Confirm the asset filename, YAML prefix, `adx_name`, `adx_partialurl`, and `filename`
   agree exactly unless an established site-local exception exists.
4. Confirm `adx_webfileid` and `annotationid` are valid, different UUIDs.
5. Confirm `objectid` equals `adx_webfileid`.
6. Confirm `objecttypecode: adx_webfile` and `isdocument: true`.
7. Confirm `mimetype` matches the final asset extension and content.
8. Confirm `adx_parentpageid` resolves to the intended root webpage.
9. For a new ordinary record, confirm `adx_publishingstateid` resolves to the intended
   existing state. For an existing record where the field is absent, confirm the
   omission was intentionally preserved.
10. Confirm the resulting URL does not collide with a sibling page or web file.
11. Confirm search, sitemap, content-disposition, and display-order behavior match the
    approved intent.
12. Confirm release and expiration dates form a valid visibility window when present.
13. Confirm the file is within target-environment attachment-size and extension
    policies.
14. Confirm all new or changed references resolve to the final URL.
15. For CSS, confirm ordering and precedence against every site stylesheet.
16. Confirm existing IDs were preserved during replacement, rename, or move operations.
17. Review the final diff for unrelated binary, metadata, or caller changes.

## Microsoft documentation

- [Create and manage web files](https://learn.microsoft.com/power-pages/configure/web-files)
- [Manage CSS files](https://learn.microsoft.com/power-pages/configure/manage-css)
- [Manage page permissions](https://learn.microsoft.com/power-pages/security/page-security)

## Prohibited shortcuts

- Do not create only the asset or only the `.webfile.yml`.
- Do not reuse another web file's record or annotation UUID.
- Do not let `objectid` differ from `adx_webfileid`.
- Do not guess a MIME type when extension or content is ambiguous.
- Do not copy an external directory path into `web-files/`.
- Do not parent a file to a localized webpage record.
- Do not identify the Home parent only by the display name `Home`.
- Do not add a missing publishing-state field to an existing record as incidental
  normalization.
- Do not change the parent or partial URL without updating confirmed callers.
- Do not edit binary content with text replacement tools.
- Do not delete or reorder default CSS files as incidental cleanup.
- Do not weaken blocked-attachment policy without explicit approval.
- Do not delete an asset before checking site-wide references.
- Do not modify `.portalconfig` manifests during routine web-file authoring.
