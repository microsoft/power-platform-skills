# Design Studio Web Template Authoring

Canonical reference for workflows that create or modify web templates in a PAC
CLI-downloaded declarative Power Pages site. This reference applies to sites with a
root-level `.portalconfig` directory, `website.yml`, and `web-templates/` content. It does
not apply to Power Pages code sites built with React, Angular, Vue, or Astro.

A web template is a reusable Power Pages metadata record whose source can contain HTML,
Liquid, text, or another text-based response format. Web templates can serve as reusable
fragments, inherited layouts, complete page layouts, or the site's global header and
footer.

## Web template creation workflow

Create a web template in this order:

1. Resolve `<SITE_ROOT>` by following
   `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`, requiring
   `web-templates/`.
2. Read all existing `*.webtemplate.yml` files and their matching
   `*.webtemplate.source.html` files.
3. Resolve the template's name, purpose, callers, input variables, output context, and
   whether it will be used as:
   - an included reusable fragment;
   - a base layout with overridable blocks;
   - a derived template that extends a base layout;
   - a page layout referenced by a page template;
   - the website header or footer;
   - a complete non-HTML or standalone response.
4. Confirm the name is unique and does not conflict with an existing Liquid
   `{% include %}` or `{% extends %}` target.
5. Generate one UUID with `${PLUGIN_ROOT}/scripts/generate-uuid.js`.
6. Create the metadata and source file pair under `web-templates/`.
7. Write the smallest valid source for the approved purpose.
8. Create or update any separately approved callers, page-template binding, or website
   header/footer binding.
9. Verify the complete dependency graph before deployment.

Creating the web template record alone does not make it render. Depending on its purpose,
it can be consumed by a Liquid `include` or `extends`, a website header/footer binding,
or a page template. It can also remain intentionally unused for later work.

Do not create a page template merely because a new web template was requested. A page
template is needed only when the web template must directly render webpages as a page
layout.

## End-to-end custom page layout

A complete custom page layout normally consists of separate components resolved in this
order:

1. Create and verify the web-template metadata/source pair.
2. Inspect existing page templates for a record that is intended for the same layout
   role and can safely use this web template.
3. Reuse or deliberately rebind that record only when doing so matches the request and
   is safe for every webpage already referencing it. Otherwise, create a new Web
   Template-type page-template record that references the stable `adx_webtemplateid`.
4. Optionally assign the page-template UUID to the intended root and localized webpage
   records.

Keep the component identities separate. The web template owns Liquid and response
source, the page template owns the rendering contract, and webpages own the layout
assignment. Creating the first component must not silently rebind existing page
templates or webpages.

An existing page template is not compatible merely because its name is similar or it
targets `adx_webpage`. Rebinding changes the layout of every webpage that references
that page template. Confirm its current dependencies, response boundary, default status,
and intended layout role before reuse.

Use `${PLUGIN_ROOT}/skills/classic-site-skills/author-page-template/references/design-studio-page-template-authoring.md` for the
page-template record and assignment sequence.

## PAC download structure

Each web template is stored in its own directory:

```text
<site-root>/
├── .portalconfig/
├── website.yml
└── web-templates/
    └── <template-directory>/
        ├── <Template-File-Stem>.webtemplate.yml
        └── <Template-File-Stem>.webtemplate.source.html
```

Both files are required:

- `.webtemplate.yml` stores the record metadata and stable identity.
- `.webtemplate.source.html` stores the complete template source.

The `.source.html` suffix is used even when the source is primarily Liquid or returns
another text-based format. Do not infer the response MIME type from the local filename.

## Naming convention

Preserve the naming convention already used by the downloaded site. When creating a
template with no stronger site-local convention:

- directory name: replace spaces and `/` with `-`, then lowercase;
- file stem: split on spaces and `/`, capitalize each segment's first character, and join
  the segments with `-`;
- metadata name: preserve the intended human-readable name.

For example, `Product Details` becomes:

```text
web-templates/product-details/
├── Product-Details.webtemplate.yml
└── Product-Details.webtemplate.source.html
```

The metadata `adx_name` is the functional Liquid lookup name. Liquid
`{% include %}` and `{% extends %}` references use this value, not the directory name or
file stem. Keep its spelling stable and treat a name change as a dependency migration.

Reject a new name that duplicates another web template name. Do not rename existing
directories or file stems merely to normalize casing or punctuation.

## Web template YAML

The minimum metadata record is:

```yaml
adx_name: <template-name>
adx_webtemplateid: <new-web-template-id>
```

Rules:

- Generate `adx_webtemplateid` with `${PLUGIN_ROOT}/scripts/generate-uuid.js`.
- The ID must be unique across the site.
- Never copy an existing web template ID.
- Preserve the ID during source edits, renames, or refactoring.
- Keep `adx_name` unique because Liquid resolves included and extended templates by name.
- Follow existing sibling metadata when PAC CLI has serialized optional fields.
- Do not add a website ID merely because the template belongs to the current download;
  the standard local record can consist only of `adx_name` and `adx_webtemplateid`.

An optional MIME type can be relevant when a page template renders the web template as
the complete response without the website header and footer. If the requested scenario
requires a non-HTML response, configure the MIME type through the metadata shape already
used by the site and verify the associated page template. If no MIME type is provided,
Power Pages assumes `text/html`.

## Source file

Create the source at:

```text
web-templates/<template-directory>/<Template-File-Stem>.webtemplate.source.html
```

An empty source file is valid as an initial placeholder, but a template intended for
immediate use must contain the approved implementation. Do not insert sample business
content, placeholder navigation, data queries, scripts, or styling that the user did not
request.

Read the complete source before modifying it. Preserve unrelated Liquid, HTML, comments,
whitespace-sensitive text, scripts, styles, and formatting. Apply the smallest change
that satisfies the request.

## Composition patterns

Choose one primary composition pattern and keep its contract clear to callers.

### Reusable fragment

Use a fragment for markup or logic shared by other templates:

```liquid
{% include 'Product Details' %}
```

An included template can access variables from its caller. Callers can also pass named
parameters:

```liquid
{% include 'Product Details' product: product, show_price: true %}
```

Document or make obvious which parameters are required, which are optional, and their
defaults. Do not rely on undeclared caller variables when an explicit parameter would
make the dependency safer.

### Base layout

A base layout defines named blocks that derived templates can override:

```liquid
<main class="container">
  {% block title %}
    {% include 'Page Header' %}
  {% endblock %}

  {% block main %}
    {% include 'Page Copy' %}
  {% endblock %}
</main>
```

Choose stable, descriptive block names. Renaming or removing a block is a breaking change
for every template that overrides it.

### Derived template

Use `extends` with `block` to inherit a base layout:

```liquid
{% extends 'Base Product Layout' %}

{% block main %}
  <div>Custom content</div>
{% endblock %}
```

Rules:

- `{% extends %}` must be the first content in the source.
- Only block definitions may follow an `extends` declaration.
- Override only blocks defined by the parent.
- A parent block renders its default content when the child does not override it.
- Do not combine unrelated top-level output with template inheritance.

### Editable page content

To render the current page's localized Copy field:

```liquid
<div class="page-copy">
  {% editable page 'adx_copy' type: 'html', liquid: true %}
</div>
```

To render an editable page title:

```liquid
<h1>{% editable page 'adx_title' type: 'html', liquid: true %}</h1>
```

Use editable tags only for fields intended to remain editable by site makers. Preserve
the `liquid: true` behavior when the page field is expected to evaluate embedded Liquid.

### Header and footer dynamic regions

Header and footer output caching is enabled by default for new websites. Wrap request-,
page-, language-, user-, or date-dependent output in a substitution block so cached
output does not leak stale request context:

```liquid
{% substitution %}
  <!-- request-specific or user-specific output -->
{% endsubstitution %}
```

Do not wrap the entire header or footer in substitution when only a small region is
dynamic; keep the uncached region as narrow as possible. On an upgraded site where output
caching is disabled, preserve substitution-safe markup so enabling caching later does not
break request-specific behavior.

## Liquid authoring rules

- Use `{% include '<template-name>' %}` for reusable template fragments.
- Use `{% extends '<template-name>' %}` and `{% block %}` for inheritance.
- Preserve exact referenced template names.
- Use `assign`, `if`, `unless`, `for`, and filters for clear presentation logic.
- Escape untrusted or user-controlled values in HTML text, attributes, and URLs with the
  appropriate Liquid escaping filter.
- Do not emit raw Dataverse values, query-string values, user properties, or snippet
  content into executable script or markup contexts without context-appropriate encoding.
- Keep accessibility semantics intact: landmarks, headings, labels, alternative text,
  keyboard behavior, and focus behavior must remain valid after edits.
- Prefer content snippets and localized page fields for maker-managed or translated
  content instead of hardcoding user-facing strings in a shared template.
- Use site settings, snippets, web links, site markers, and Power Pages Liquid objects
  through their established names; do not invent dependencies that are absent from the
  downloaded site.
- When using `fetchxml`, use explicit closing tags rather than self-closing FetchXML
  elements, request only required columns, and ensure the required table permissions
  exist.
- Keep complex reusable behavior in a dedicated included template rather than copying the
  same Liquid into multiple callers.

## Dependency types

Web templates have two different dependency mechanisms. Inspect both before creating,
renaming, replacing, or deleting a template.

### Name-based Liquid dependencies

Liquid references templates through `adx_name`:

```liquid
{% include 'Page Copy' %}
{% extends 'Layout 2 Column Wide Left' %}
```

Search every `.webtemplate.source.html` and localized webpage copy for `include` and
`extends` references to the template name. A rename must update every exact caller in the
same change.

### ID-based metadata dependencies

Other Power Pages records reference `adx_webtemplateid`:

- page-template YAML uses `adx_webtemplateid` to select a web template;
- `website.yml` uses `adx_headerwebtemplateid` and `adx_footerwebtemplateid` for global
  chrome;
- other downloaded metadata may contain the web template ID.

Search all downloaded YAML before changing or deleting a web template. Preserve the ID
for normal edits and renames so ID-based callers remain connected.

## Using a web template as a page layout

A web template becomes a page layout through a separate page-template record. The page
template must:

- use the web-template page-template type;
- reference the web template's `adx_webtemplateid`;
- target the appropriate entity, normally `adx_webpage`;
- explicitly choose whether the website header and footer wrap the output.

When the page template uses the website header and footer, the web template renders the
content between them. When it does not, the web template owns the complete response,
including document structure for HTML responses.

Creating a web template must not silently create or rebind a page template. Treat the
page-template record as a separate, approved component change.

## Using a web template as the website header or footer

The global bindings live in `website.yml`:

```yaml
adx_headerwebtemplateid: <header-web-template-id>
adx_footerwebtemplateid: <footer-web-template-id>
```

Changing either value affects the complete site. Require explicit approval before
rebinding it.

A custom header assumes responsibility for site-wide behavior normally supplied by the
existing header, including primary navigation, search, language selection, sign-in and
sign-out, responsive behavior, skip links, and accessible labeling. A custom footer must
preserve required site-wide links and accessibility behavior.

Do not replace a global header or footer merely to test a new template. Create the
template first, inspect its dependencies, and bind it only after the global impact is
approved.

## Modifying an existing web template

Resolve exactly one template through its metadata name and ID, then apply the smallest
change required.

| Requested change | Required files and checks |
|---|---|
| Edit Liquid, HTML, text, CSS, or script | Change only the matching `.webtemplate.source.html`; preserve metadata identity |
| Rename template | Update `adx_name`, directory and file pair when required by the site convention, and every name-based `include` or `extends` caller |
| Change page-layout binding | Update the selected page-template YAML; do not change the web template ID |
| Change website header or footer | Update the selected binding in `website.yml` only after explicit approval |
| Change response MIME type | Update the web template metadata and verify the associated page template renders the complete response |
| Refactor a base layout block | Inventory every extending template and update all affected block overrides |
| Replace an included fragment | Verify every caller's parameters and expected output context |

### Identity preservation

Never regenerate `adx_webtemplateid` during a normal modification. A new ID represents a
new Dataverse record and can disconnect page templates, website header/footer bindings,
and other metadata references.

### Rename safety

A web template rename is both a file operation and a dependency migration:

1. Inventory all `include` and `extends` references to the old `adx_name`.
2. Confirm the new name is unique.
3. Update `adx_name`.
4. Rename the directory and both files only when needed to preserve the site's naming
   convention.
5. Update every name-based Liquid caller.
6. Preserve `adx_webtemplateid`.
7. Re-scan the site for the old name.

Do not perform a broad text replacement outside Liquid template references. The old name
can also appear as user-facing text, a content-snippet name, or unrelated data.

### Source preservation

- Read the complete source before editing.
- Preserve the file's line endings and unrelated formatting.
- Do not reformat a large Liquid template for a local change.
- Preserve comments that document platform behavior or caching constraints.
- Do not remove includes, blocks, editable regions, accessibility markup, or escaping
  merely because their output is not visible in the current preview.
- Do not move JavaScript or CSS between templates without tracing loading order and global
  side effects.
- For headers and footers, verify both authenticated and anonymous branches when either
  exists.

## Deletion rules

Do not delete a web template until all dependencies have been removed or migrated:

1. Search Liquid source and localized webpage copies for name-based references.
2. Search page-template YAML, `website.yml`, and other metadata for its ID.
3. Check whether another template extends it or overrides its blocks.
4. Check whether it provides the active website header or footer.
5. Check whether it is the rendering template for an active page template.

If any dependency remains, stop and report it. Never replace the ID with an unrelated
template merely to make validation pass.

## Verification checklist

After creating or modifying a web template:

1. Confirm the metadata YAML parses successfully.
2. Confirm the directory contains exactly one matching `.webtemplate.yml` and one
   `.webtemplate.source.html`.
3. Confirm `adx_name` is present and unique.
4. Confirm `adx_webtemplateid` is a valid, unique UUID.
5. Confirm an existing template retained its original ID.
6. Confirm the source contains no unfinished placeholders.
7. Confirm Liquid tags and output delimiters are balanced.
8. If `extends` is used, confirm it is the first content and only block definitions follow.
9. Confirm every `include` and `extends` target exists by `adx_name`.
10. Confirm named parameters supplied by callers match the included template's expected
    variables and defaults.
11. Confirm every page-template, header, and footer ID reference resolves to an existing
    web template.
12. Confirm all old name references were removed after a rename.
13. Confirm user-controlled output is escaped for its rendering context.
14. Confirm editable regions, localization, accessibility, and responsive behavior remain
    intact.
15. Confirm request- or user-specific header/footer output uses a narrowly scoped
    substitution block when caching can apply.
16. Review the final diff for unrelated source, metadata, or binding changes.

## Microsoft documentation

- [Web templates](https://learn.microsoft.com/power-pages/configure/web-templates)
- [Template tags](https://learn.microsoft.com/power-pages/configure/liquid/template-tags)
- [Liquid overview](https://learn.microsoft.com/power-pages/configure/liquid/liquid-overview)
- [Available Liquid tags](https://learn.microsoft.com/power-pages/configure/liquid/liquid-tags)
- [Header and footer output caching](https://learn.microsoft.com/power-pages/configure/enable-header-footer-output-caching)

## Prohibited shortcuts

- Do not create only the YAML or only the source file.
- Do not reuse an existing web template UUID.
- Do not assume the directory or filename is the Liquid lookup name.
- Do not rename `adx_name` without updating every name-based caller.
- Do not regenerate the ID during a source edit or rename.
- Do not create a page template or change the website header/footer binding implicitly.
- Do not delete a template while any name-based or ID-based dependency remains.
- Do not hardcode translated or maker-managed content when a localized page field or
  content snippet is the appropriate source.
- Do not output untrusted values without context-appropriate escaping.
- Do not place request- or user-specific header/footer output in a cached region.
- Do not modify `.portalconfig` manifests as part of routine web-template authoring.
