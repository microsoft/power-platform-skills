# Design Studio Webpage Authoring

Canonical reference for workflows that create or modify webpages in a PAC CLI-downloaded
declarative Power Pages site. This reference applies to sites with a root-level
`.portalconfig` directory and `web-pages/` content. It does not apply to Power Pages code
sites built with React, Angular, Vue, or Astro.

Creating a webpage requires one root webpage record, one localized webpage record per
configured site language, localized content files, and optional navigation records. Apply
the complete workflow below so the local files preserve the relationships expected by
Power Pages and remain compatible with PAC CLI upload and download.

## Webpage creation workflow

Create a webpage in this order:

1. Resolve `<SITE_ROOT>` by following
   `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`, requiring
   `web-pages/`.
2. Load existing webpages, page templates, portal languages, website languages, web link
   sets, and web links.
3. Resolve the webpage name, parent page, and page template.
4. Generate one root webpage UUID with
   `${PLUGIN_ROOT}/scripts/generate-uuid.js`.
5. Write the root `<Page>.webpage.yml`.
6. Iterate every configured portal language, map it to the corresponding website
   language record, generate a distinct localized webpage UUID, and write:
   - `<Page>.<locale>.webpage.yml`;
   - an empty `<Page>.<locale>.webpage.copy.html`.
7. If navigation is part of the request, follow **Navigation links** to add the
   language-specific web-link records.

Use these webpage defaults unless the user's request or an existing site-local convention
requires a different value:

| Field | Default value |
|---|---|
| `adx_enablerating` | `false` |
| `adx_enabletracking` | `false` |
| `adx_excludefromsearch` | `false` |
| `adx_hiddenfromsitemap` | `true` |
| `adx_sharedpageconfiguration` | `false` |
| `adx_name` | Supplied webpage name |
| `adx_title` | Supplied webpage name |
| `adx_partialurl` | Supplied webpage name |

`adx_displayorder` is not required in the minimum webpage YAML, but PAC CLI downloads can
serialize it on both root and localized records. Follow the downloaded sibling-page
convention and keep the root and localized values synchronized when the field is present.

## Webpage record model

A webpage is not represented by one file. It consists of:

1. One **root webpage record** that owns the stable page identity.
2. One **localized webpage record** for each configured site language.
3. Localized content files that contain the visitor-facing page body.
4. Optional navigation records in the site's web link sets.

The root and localized records use different `adx_webpageid` values. Every localized
record points back to the root record through `adx_rootwebpageid`.

| Property | Root record | Localized record |
|---|---|---|
| `adx_webpageid` | One generated root UUID | A different generated UUID per language |
| `adx_isroot` | `true` | `false` |
| `adx_rootwebpageid` | Omitted | Root record's `adx_webpageid` |
| `adx_webpagelanguageid` | Omitted | Existing website-language record ID |
| Visitor-facing body | Do not assume this is the rendered body | Locale-specific `.webpage.copy.html` |

Treat the IDs and relationships as the authoritative identity. Folder and file names are
serialization details and must not be used as substitutes for record validation.

`adx_sharedpageconfiguration` determines whether a localized content page uses
configuration from its root page. The creation examples and localized-file rules below
assume `false`. If an existing page sets it to `true`, inspect that page's root and
localized records plus its page template before changing configuration-bearing fields.
Do not assume the same edit boundary as a non-shared page, and do not change this flag as
incidental cleanup.

## PAC download structure

A complete PAC CLI webpage download can use this shape:

```text
<site-root>/
├── .portalconfig/
├── website.yml
└── web-pages/
    └── <page-directory>/
        ├── <Page>.webpage.yml
        ├── <Page>.webpage.copy.html
        ├── <Page>.webpage.summary.html
        ├── <Page>.webpage.custom_css.css
        ├── <Page>.webpage.custom_javascript.js
        └── content-pages/
            ├── <Page>.<locale>.webpage.yml
            ├── <Page>.<locale>.webpage.copy.html
            ├── <Page>.<locale>.webpage.summary.html
            ├── <Page>.<locale>.webpage.custom_css.css
            └── <Page>.<locale>.webpage.custom_javascript.js
```

The minimum webpage file set is:

- the page-level root `.webpage.yml`;
- one localized `.webpage.yml` per configured language; and
- one localized `.webpage.copy.html` per configured language.

The initial localized copy file can be empty. It is a placeholder for later page
authoring, not a prebuilt section layout.

When creating a page in an existing PAC download, follow that site's local convention.
If sibling pages contain the summary, custom CSS, custom JavaScript, or page-level copy
files, create the corresponding empty or baseline files for the new page. Do not populate
optional files with invented content.

The localized file under `content-pages/` is the editable page body for that language:

```text
web-pages/<page-directory>/content-pages/<Page>.<locale>.webpage.copy.html
```

The page-level `<Page>.webpage.copy.html` belongs to the root record. It can be empty or
differ from the localized page body, and it can be absent in a minimally generated site.
For a non-shared page, never fall back to it when a workflow intends to modify
visitor-facing localized content.

## Naming convention

Preserve the naming convention already used by the downloaded site. When creating a page
with no stronger page-local convention, derive names as follows:

- page directory: replace spaces and `/` with `-`, then lowercase;
- file stem: split on spaces and `/`, capitalize each segment's first character, and join
  the segments with `-`;
- localized file suffix: append `.<locale>` before `.webpage.*`.

For example, `Contact Us` becomes:

```text
web-pages/contact-us/Contact-Us.webpage.yml
web-pages/contact-us/content-pages/Contact-Us.en-US.webpage.yml
web-pages/contact-us/content-pages/Contact-Us.en-US.webpage.copy.html
```

Reject names that would collide with an existing page directory, file stem, or sibling
`adx_partialurl`. Do not rename an existing directory or file set merely because it does
not match this convention.

## Creation inputs and dependencies

Before writing a new webpage:

1. Read all existing page-level `.webpage.yml` files.
2. Resolve the requested parent to an existing root webpage record.
3. Resolve the requested page template to an existing page-template record.
4. Resolve the publishing state from existing site metadata. Prefer the Home page's
   publishing state; if it cannot be resolved, use the selected parent page's publishing
   state rather than inventing an ID.
5. Enumerate the configured website languages and map each locale to its existing website
   language ID. Never invent or reuse a language ID from another site.
6. Inspect sibling pages under the chosen parent to determine route uniqueness,
   companion-file conventions, page-local HTML formatting, and whether PAC has serialized
   `adx_displayorder` on webpage records.
7. Determine whether the request includes navigation. Webpage creation and navigation
   are separate component changes.

The required creation inputs are:

- webpage name and title;
- partial URL;
- parent page;
- page template;
- initial localized content or the selected blank-page baseline;
- search and sitemap visibility;
- whether navigation links should be created.

Use `${PLUGIN_ROOT}/scripts/generate-uuid.js` for every new UUID. Generate one UUID for the
root record and a different UUID for each localized record.

## Root webpage YAML

Create the page-level YAML with the root UUID:

```yaml
adx_displayorder: <display-order>
adx_enablerating: false
adx_enabletracking: false
adx_excludefromsearch: <true-or-false>
adx_hiddenfromsitemap: <true-or-false>
adx_isroot: true
adx_name: <page-name>
adx_pagetemplateid: <existing-page-template-id>
adx_parentpageid: <existing-parent-root-webpage-id>
adx_partialurl: <partial-url>
adx_publishingstateid: <existing-publishing-state-id>
adx_sharedpageconfiguration: false
adx_title: <page-title>
adx_webpageid: <new-root-webpage-id>
```

Rules:

- Omit `adx_displayorder` only when the existing downloaded sibling records also omit it.
  When present, choose the value deliberately and keep it synchronized across the root
  and localized records.
- `adx_parentpageid` must reference the parent page's root `adx_webpageid`.
- `adx_pagetemplateid` and `adx_publishingstateid` must reference records already present
  in the downloaded site.
- `adx_partialurl` must be unique among pages under the same parent.
- Choose `adx_displayorder` deliberately after inspecting siblings; do not copy an order
  blindly when that creates a duplicate.
- Do not add `adx_rootwebpageid` or `adx_webpagelanguageid` to the root record.
- The root `adx_name` identifies the base page record in administration and discovery.
  Templates commonly use Name as the page title when `adx_title` is absent, so do not
  treat a root-name change as a file-system-only rename.

## Localized webpage YAML

For each configured site language, create a localized record under `content-pages/`:

```yaml
adx_displayorder: <display-order>
adx_enablerating: false
adx_enabletracking: false
adx_excludefromsearch: <true-or-false>
adx_hiddenfromsitemap: <true-or-false>
adx_isroot: false
adx_name: <localized-page-name>
adx_pagetemplateid: <existing-page-template-id>
adx_parentpageid: <existing-parent-root-webpage-id>
adx_partialurl: <partial-url>
adx_publishingstateid: <existing-publishing-state-id>
adx_rootwebpageid: <new-root-webpage-id>
adx_sharedpageconfiguration: false
adx_title: <localized-page-title>
adx_webpageid: <new-localized-webpage-id>
adx_webpagelanguageid: <existing-website-language-id>
```

Rules:

- Apply the same local-convention rule to localized `adx_displayorder`.
- `adx_webpageid` must be unique and must not equal the root ID or another locale's ID.
- `adx_rootwebpageid` must exactly equal the new root record's `adx_webpageid`.
- `adx_webpagelanguageid` must match the locale in the filename.
- Parent, template, publishing state, partial URL, display order, and behavioral flags
  should remain synchronized with the root record unless the platform contract or an
  existing site-local pattern explicitly requires otherwise.
- Localized names, titles, summaries, body content, and accessibility text may differ by
  language.

Create localized records for every configured site language by default. If a workflow
intentionally creates only a subset, it must surface that the page will be unavailable or
incomplete in omitted languages.

## Initial page content

Create the visitor-facing body file only at each localized
`content-pages/<Page>.<locale>.webpage.copy.html`.

- Always create the localized copy file with the localized webpage record.
- Leave it empty when no initial content was requested.
- When initial content was requested, create the webpage metadata and empty copy file
  first, then invoke `author-webpage-content` with one resolved composition per locale.
- If the site consistently uses a blank-page baseline and the request selects that
  convention, pass that baseline and its preservation requirements to the content skill.
- Do not copy business content from an unrelated page as a shortcut.
- Preserve locale boundaries. Do not duplicate one language's text into other locales
  unless the request supplies that content for those locales.
- Keep custom CSS and JavaScript empty unless the requested page separately requires them.
- Keep summary files empty unless a localized summary was supplied or requested.

The composition contract and page-element markup are owned by:

```text
${PLUGIN_ROOT}/skills/classic-site-skills/author-webpage-content/references/webpage-content-composition.md
```

`author-webpage` owns all directories, metadata, companion-file creation, localized
identity, and the resolved handoff. `author-webpage-content` only generates and fills
the visitor-facing HTML in the exact existing localized copy file it receives.

## Navigation links

Creating the webpage record does not by itself define the intended navigation experience.
When navigation is requested, add a web link for the root webpage to each selected
language's web link set, using:

- a new web link UUID;
- `adx_pageid` set to the root webpage ID;
- `adx_name` set to the localized navigation label;
- the selected publishing state;
- the language's corresponding web link set;
- one greater than the highest existing web link display order, or `1` when no existing
  link has an order;
- page validation, image-only display, child-link display, and new-window behavior set
  to `false`;
- robots-follow-link set to `true`.

Only create or modify web links when navigation placement is part of the request.
Do not add the page to every menu automatically, and do not remove or reorder unrelated
links. If the page should remain hidden from navigation, leave web link sets unchanged.

## Modifying an existing webpage

Resolve the root record first, then validate every selected localized record through
`adx_rootwebpageid`. Apply the smallest change that satisfies the request.

The **Metadata synchronization** list below is authoritative for deciding whether a
property is shared. This table adds operation-specific file and dependency handling; it
is not a second field catalog.

| Requested change | Required files |
|---|---|
| Edit body on a non-shared page | Only the selected locale's matching `.webpage.copy.html` |
| Edit summary, CSS, or JavaScript | The matching root or localized companion file established by the page's existing serialization and `adx_sharedpageconfiguration` |
| Edit localized title or name | Only the selected localized `.webpage.yml` unless a root-level rename was also requested |
| Change route | Root YAML and every localized YAML; inspect links and references for the old route |
| Change parent | Root YAML and every localized YAML |
| Change page template | Root YAML and every localized YAML |
| Change display order | Root YAML and every localized YAML; update navigation separately only if requested |
| Change another shared metadata property | Root YAML and every localized YAML, as defined by **Metadata synchronization** |
| Change navigation label, order, target, or window behavior | The selected web link set record, not webpage body metadata |

### Identity preservation

Do not regenerate or replace these values during a normal modification:

- root `adx_webpageid`;
- localized `adx_webpageid`;
- localized `adx_rootwebpageid`;
- localized `adx_webpagelanguageid`.

Changing an identity field can orphan localized content or create a second Dataverse
record rather than editing the intended page.

### Content preservation

For localized HTML, CSS, JavaScript, and summary edits:

- read the complete target file before editing;
- modify only the selected locale;
- preserve Liquid, code components, HTML entities, classes, inline styles, indentation,
  line endings, and unrelated content;
- do not reformat the complete file for a local edit;
- never replace a localized file with the page-level companion file;
- verify exactly one intended target changed unless the request explicitly describes a
  batch edit.

For pages with `adx_sharedpageconfiguration: true`, first establish whether the requested
property is inherited from the root record or stored on the localized record. Never
redirect an edit to the root companion merely because the localized companion is empty.

### Metadata synchronization

When changing a shared property, update the root record and all localized records in one
logical operation. Before writing, inventory the current values and report unexpected
drift rather than silently choosing one record as authoritative.

Shared properties normally include:

- `adx_displayorder`;
- `adx_enablerating`;
- `adx_enabletracking`;
- `adx_excludefromsearch`;
- `adx_hiddenfromsitemap`;
- `adx_pagetemplateid`;
- `adx_parentpageid`;
- `adx_partialurl`;
- `adx_publishingstateid`;
- `adx_sharedpageconfiguration`.

Do not synchronize localized content fields merely because they differ. Names, titles,
summaries, body markup, custom CSS, and custom JavaScript can be locale-specific.

## Verification checklist

After creating or modifying a webpage:

1. Confirm every changed YAML file parses successfully.
2. Confirm the root record has `adx_isroot: true` and no root/language relationship fields.
3. Confirm every localized record has `adx_isroot: false`.
4. Confirm every localized `adx_rootwebpageid` equals the root `adx_webpageid`.
5. Confirm all new `adx_webpageid` values are valid, unique UUIDs.
6. Confirm every filename locale maps to the record's `adx_webpagelanguageid`.
7. Confirm parent, page-template, publishing-state, and language IDs exist in the site.
8. Confirm the partial URL does not collide with a sibling page.
9. Confirm shared metadata is synchronized across the root and localized records.
10. Confirm each localized YAML has its matching `.webpage.copy.html`.
11. Confirm companion files match the existing site's serialization convention.
12. Confirm visitor-facing content changed only in the intended localized files.
13. If navigation changed, confirm each web link targets the root webpage ID and only the
    requested web link sets changed.
14. Review the final diff for unrelated metadata, formatting, or content changes.

## Microsoft documentation

- [Manage web pages](https://learn.microsoft.com/power-pages/configure/web-page)
- [Enable multiple-language website support](https://learn.microsoft.com/power-pages/configure/enable-multiple-language-support)
- [Web Page common data model attributes](https://learn.microsoft.com/common-data-model/schema/core/applicationcommon/foundationcommon/crmcommon/solutions/portals/webpage#attributes)

## Prohibited shortcuts

- Do not represent a multilingual webpage with only one root YAML file.
- Do not reuse the root UUID for a localized record.
- Do not guess parent, template, publishing-state, language, or web-link-set IDs.
- Do not use filename matching alone to establish root/localized relationships.
- Do not edit the page-level copy when localized visitor content was requested.
- Do not update all locales for a content-only request unless the request includes them.
- Do not create navigation links merely because a webpage was created.
- Do not rename existing folders and files as incidental cleanup.
- Do not regenerate stable IDs during an ordinary metadata or content edit.
