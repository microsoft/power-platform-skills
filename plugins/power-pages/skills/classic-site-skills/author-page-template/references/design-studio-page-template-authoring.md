# Design Studio Page Template Authoring

Canonical reference for workflows that create or modify page templates in a PAC
CLI-downloaded declarative Power Pages site. This reference applies to sites with a
root-level `.portalconfig` directory, `website.yml`, `page-templates/`, and
`web-templates/` content. It does not apply to Power Pages code sites built with React,
Angular, Vue, or Astro.

A page template is the rendering contract selected by a webpage. It determines whether
Power Pages renders through a web template or a supported ASP.NET rewrite target, which
content table the layout supports, and whether the website header and footer wrap the
rendered output.

## Page template creation workflow

Create a page template in this order:

1. Resolve `<SITE_ROOT>` by following
   `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`, requiring
   `page-templates/`. Also require `web-templates/` when the requested or existing
   rendering type uses a web template.
2. Read every existing `*.pagetemplate.yml`, web-template metadata record, and webpage
   reference to understand the site's conventions and dependencies.
3. Resolve:
   - page-template name;
   - rendering type;
   - target web template or supported rewrite URL;
   - target table, normally `adx_webpage`;
   - whether to use the website header and footer;
   - whether the page template should be the default choice;
   - optional description;
   - which webpages, if any, should use it.
4. Generate one UUID with `${PLUGIN_ROOT}/scripts/generate-uuid.js`.
5. Create one YAML file directly under `page-templates/`.
6. If webpage assignment was approved, update the root and localized webpage records
   together.
7. Verify the page-template, rendering-target, and webpage dependency graph.

Creating a page template does not create its web template and does not assign it to
existing webpages automatically. Treat those as separate, explicit component changes.

## End-to-end custom page layout

When the requested outcome is a complete custom page layout rather than an isolated
metadata record, implement the components in dependency order:

1. Create and verify the web-template metadata/source pair by following
   `${PLUGIN_ROOT}/skills/classic-site-skills/author-web-template/references/design-studio-web-template-authoring.md`.
2. Inspect existing page templates for a compatible record before creating another one.
3. Reuse or rebind an existing record only when its target table, header/footer
   boundary, default behavior, layout purpose, and all current webpage dependencies are
   compatible with the requested change.
4. If no safe existing record fits, create a new Web Template-type page-template record
   and bind `adx_webtemplateid` to the web template's stable UUID.
5. If assignment is part of the request, update `adx_pagetemplateid` on the selected
   root webpage and every localized webpage record together.

Do not reverse this order by creating a page template that points to an absent web
template. Do not assign webpages before the page-template record and its rendering
source are valid. Assignment remains optional when the request is only to make the new
layout available for later use.

A request for a new web template alone is not a request for a page template. Web
templates used as includes, inherited layouts, header/footer templates, or future
reusable source do not require a new page-template record.

## PAC download structure

Page templates are single YAML records stored directly under `page-templates/`:

```text
<site-root>/
├── .portalconfig/
├── website.yml
├── page-templates/
│   └── <Page-Template-Name>.pagetemplate.yml
├── web-templates/
│   └── <web-template-directory>/
│       ├── <Web-Template>.webtemplate.yml
│       └── <Web-Template>.webtemplate.source.html
└── web-pages/
    └── ... (see the author-webpage reference)
```

For the webpage structure, use
`${PLUGIN_ROOT}/skills/classic-site-skills/author-webpage/references/design-studio-webpage-authoring.md`.

A page template has no companion source file. Its rendering source belongs to the
referenced web template or the selected rewrite target.

## Naming convention

Preserve the naming convention already used by the downloaded site. When creating a page
template with no stronger site-local convention:

- keep `adx_name` human-readable;
- derive the file stem by splitting the name on spaces and `/`, capitalizing the first
  character of each segment, and joining the segments with `-`;
- append `.pagetemplate.yml`;
- store the file directly under `page-templates/`.

For example:

```text
Product Details
→ page-templates/Product-Details.pagetemplate.yml
```

Reject a new name that duplicates another page template name. Do not rename existing
files merely to normalize casing or punctuation.

Page-template references from webpages use `adx_pagetemplateid`, not the file name or
`adx_name`. Preserve the ID during a normal rename or metadata edit.

## Rendering types

Choose one intended rendering type before writing the record.

### Web Template

Use this type for a custom layout rendered by a Power Pages web template. This is the
standard choice for new declarative layouts.

```yaml
adx_description: <optional-description>
adx_entityname: adx_webpage
adx_isdefault: false
adx_name: <page-template-name>
adx_pagetemplateid: <new-page-template-id>
adx_type: 756150001
adx_usewebsiteheaderandfooter: true
adx_webtemplateid: <existing-web-template-id>
```

Rules:

- `adx_type: 756150001` identifies a web-template-backed page template in the PAC
  structure.
- `adx_webtemplateid` must reference an existing web template record.
- Do not use a web template name where a UUID is required.
- `adx_rewriteurl` is not required for a new web-template-backed page template.
- Use `${PLUGIN_ROOT}/skills/classic-site-skills/author-web-template/references/design-studio-web-template-authoring.md` when creating or
  modifying the referenced web template.

### Rewrite

Rewrite page templates render a supported physical ASP.NET `.aspx` page:

```yaml
adx_entityname: adx_webpage
adx_isdefault: false
adx_name: <page-template-name>
adx_pagetemplateid: <new-page-template-id>
adx_rewriteurl: ~/Pages/<SupportedPage>.aspx
adx_usewebsiteheaderandfooter: true
```

Rules:

- Use Rewrite only for an existing, supported Power Pages `.aspx` target.
- Do not invent an `.aspx` path or upload a custom physical page.
- Preserve the site's PAC serialization for the Rewrite type. Existing downloaded
  records can omit `adx_type` and can retain an `adx_webtemplateid`; do not delete such
  fields merely because they are inactive for the selected rendering path.
- When creating a new custom layout, prefer a web-template-backed page template instead
  of introducing a rewrite target.

Do not infer the active type solely from the presence of `adx_webtemplateid` or
`adx_rewriteurl`. Read `adx_type`, inspect the complete existing record, and preserve
legacy fields unless the user explicitly requested a type migration.

## Field contract

| Field | Purpose | Authoring rule |
|---|---|---|
| `adx_pagetemplateid` | Stable page-template identity | Generate once; preserve during edits and renames |
| `adx_name` | Human-readable template name | Required and unique within the site |
| `adx_description` | Maker-facing purpose and usage guidance | Optional; preserve if present |
| `adx_type` | Selects the rendering mechanism | Use the web-template value only for a web-template-backed record; do not guess other enum values |
| `adx_webtemplateid` | Web template used for rendering | Must resolve to an existing web template when the Web Template type is active |
| `adx_rewriteurl` | Supported physical `.aspx` rendering target | Use only for Rewrite templates |
| `adx_usewebsiteheaderandfooter` | Controls global website chrome | Decide deliberately; changing it alters the entire response boundary |
| `adx_isdefault` | Default choice in page-authoring tools | Set deliberately after inspecting other defaults |
| `adx_entityname` | Table type the template is intended to render | Normally `adx_webpage`; use another table only for an established portal scenario |

The standard PAC file can omit fields that have no serialized value. Do not add unrelated
metadata simply to make every page-template YAML look identical.

## Web template binding

For a web-template-backed page template:

1. Enumerate `web-templates/*/*.webtemplate.yml`.
2. Resolve the selected web template by `adx_webtemplateid`.
3. Confirm the matching `.webtemplate.source.html` exists.
4. Inspect the source to determine its layout contract, includes, inherited blocks,
   editable regions, and expected variables.
5. Set the page template's `adx_webtemplateid` to that exact UUID.

The binding is ID-based. Renaming the web template does not require changing the page
template when its ID remains stable. Replacing the ID can change every webpage that uses
the page template.

Do not create a page template that points to an absent, duplicate, or newly regenerated
web template ID.

## Website header and footer behavior

`adx_usewebsiteheaderandfooter` defines the response boundary:

### `true`

- The web template renders the page content between the global website header and footer.
- The site's `website.yml` header and footer bindings remain responsible for global
  navigation, authentication links, language selection, search, and footer content.
- The web template should not emit a duplicate document root, global header, or global
  footer.

### `false`

- The web template owns the complete response.
- For HTML, it must provide the full document structure required by the response.
- For another text-based format, verify the associated web template's MIME type.
- Global header/footer behavior, scripts, styles, accessibility landmarks, and shared
  navigation are not added automatically.

Changing this field on an existing page template affects every webpage that references
it. Inventory those webpages and require explicit approval before changing the value.

## Default and table applicability

### Default page template

`adx_isdefault: true` makes the page template the default choice in page-authoring tools.
It does not reassign existing webpages.

Before making a template default:

1. Find every page template with the same `adx_entityname`.
2. Identify any existing default.
3. Confirm replacing that default is intended.
4. Update only the approved records so the applicable template set does not contain
   conflicting defaults.

### Target table

`adx_entityname` controls which content table the front-side editing system considers
compatible with the template. For ordinary webpages, use:

```yaml
adx_entityname: adx_webpage
```

Do not copy another table name such as a forum, blog, or blog-post table unless the
template is explicitly designed for that record type.

If an existing record omits `adx_entityname`, preserve that omission during unrelated
edits. Add or change the field only when the template's applicability is part of the
request.

## Assigning a page template to webpages

Webpage records reference the page template by UUID:

```yaml
adx_pagetemplateid: <page-template-id>
```

For each selected webpage:

1. Resolve and validate the complete root/localized record set by following
   `${PLUGIN_ROOT}/skills/classic-site-skills/author-webpage/references/design-studio-webpage-authoring.md`.
2. Update `adx_pagetemplateid` on the root and every localized record in one logical
   operation.
3. Preserve all unrelated webpage metadata and content.

Never update only the root or only one localized record for a shared page-template
assignment.

Assigning the new page template is optional. If the user asked only to create the
template, leave existing webpages unchanged.

## Modifying an existing page template

Resolve exactly one page template by `adx_pagetemplateid`, then inventory every webpage
that references it before changing rendering behavior.

| Requested change | Required file and dependency handling |
|---|---|
| Edit name or description | Change the selected page-template YAML; preserve ID and webpage references |
| Rebind to another web template | Change `adx_webtemplateid`; verify the new source contract against every referencing webpage |
| Change Rewrite target | Change `adx_rewriteurl` only to a supported existing `.aspx` path |
| Migrate Rewrite to Web Template | Set the Web Template type and binding; preserve legacy fields only when required by the site's PAC serialization |
| Migrate Web Template to Rewrite | Set the Rewrite rendering contract; do not invent a rewrite URL |
| Change header/footer usage | Inventory every referencing webpage and verify full-response responsibilities |
| Change default status | Inspect all templates for the same entity and avoid conflicting defaults |
| Change target table | Verify the rendering source and every assigned record are compatible with the new table |

### Identity preservation

Never regenerate `adx_pagetemplateid` during a normal modification. A new ID represents a
new Dataverse record and disconnects every webpage that references the old ID.

### Rebinding safety

Before changing `adx_webtemplateid`:

1. Read the current and proposed web-template source files.
2. Compare their required variables, inherited blocks, included templates, editable
   regions, response format, and header/footer assumptions.
3. Inventory all root and localized webpages that use the page template.
4. Confirm the new layout is valid for their content and components.
5. Apply only the page-template binding change unless webpage content changes were also
   approved.

Do not reformat or rewrite webpage content merely because a new page layout was selected.

### Rename safety

Page-template bindings are ID-based, so an `adx_name` change does not require updating
webpage records when the ID remains stable. If the site's naming convention requires the
filename to follow the new name, rename only the one YAML file and preserve
`adx_pagetemplateid`.

Search for documentation, automation, or configuration that refers to the old name
before completing the rename. Do not perform a broad text replacement across unrelated
content.

## Deletion rules

Do not delete a page template until all dependencies have been removed or migrated:

1. Search every root and localized `.webpage.yml` for its `adx_pagetemplateid`.
2. Confirm it is not the required page template for a system page.
3. Confirm it is not the current default for its target table, or establish the approved
   replacement.
4. Reassign or remove every dependent webpage explicitly.
5. Preserve the referenced web template unless its own dependency analysis confirms it
   is unused.

Deleting a page template does not imply that its web template should also be deleted.
Never cascade-delete components based only on directory proximity or similar names.

## Verification checklist

After creating or modifying a page template:

1. Confirm the YAML parses successfully.
2. Confirm the file is directly under `page-templates/` and has the
   `.pagetemplate.yml` suffix.
3. Confirm `adx_name` is present and unique.
4. Confirm `adx_pagetemplateid` is a valid, unique UUID.
5. Confirm an existing page template retained its original ID.
6. Confirm the active rendering type is unambiguous.
7. For Web Template type, confirm `adx_type: 756150001` and
   `adx_webtemplateid` resolves to an existing web template.
8. For Rewrite type, confirm `adx_rewriteurl` points to a supported existing `.aspx`
   target and no enum value was guessed.
9. Confirm `adx_usewebsiteheaderandfooter` matches the rendering source's response
   responsibilities.
10. Confirm `adx_entityname`, when present, matches the intended content table.
11. Confirm default status does not conflict with another applicable page template.
12. Confirm every referencing root and localized webpage still points to a valid
    page-template ID.
13. If webpages were reassigned, confirm all locales changed together.
14. If the web-template binding changed, confirm the new source's dependencies and
    editable regions are valid.
15. Review the final diff for unrelated page-template, webpage, or web-template changes.

## Microsoft documentation

- [Create and manage page templates](https://learn.microsoft.com/power-pages/configure/page-templates)
- [Web templates](https://learn.microsoft.com/power-pages/configure/web-templates)
- [Create a custom page layout](https://learn.microsoft.com/power-pages/configure/custom-page-layouts)

## Prohibited shortcuts

- Do not create a page template without selecting a rendering type.
- Do not reuse an existing page-template UUID.
- Do not point to a web template by name where `adx_webtemplateid` requires its UUID.
- Do not invent a rewrite URL or use a custom uploaded `.aspx` page.
- Do not assume `adx_webtemplateid` and `adx_rewriteurl` are mutually absent in legacy
  PAC records; preserve unrelated fields during edits.
- Do not regenerate the page-template ID during a rename or rebind.
- Do not update only the root or only one localized webpage when changing an assignment.
- Do not make a template default without checking the existing default for its target
  table.
- Do not change `adx_usewebsiteheaderandfooter` without evaluating every referencing
  webpage.
- Do not delete a page template while any webpage still references it.
- Do not delete the associated web template automatically.
- Do not modify `.portalconfig` manifests as part of routine page-template authoring.
