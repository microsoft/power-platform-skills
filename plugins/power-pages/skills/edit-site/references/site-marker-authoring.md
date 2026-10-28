# Site Marker Authoring

Canonical reference for creating or modifying named page bindings in a PAC CLI-downloaded
non-SPA Power Pages site. A site marker associates a unique name with a webpage in one
website. Liquid and platform features resolve that name instead of hard-coding a page URL.
It is not a web link, sitemap entry, URL redirect rule, or page-canvas component.

Authoring callers first follow [shared routing and execution](non-spa-site-authoring.md).
Resolve one site, the exact marker name and identity, its target page, and affected callers.
Work only in the local download; this reference does not upload or change Dataverse.

## Contents

- [Platform support](#platform-support)
- [Discover records and serialization](#discover-records-and-serialization)
- [Field contract](#field-contract)
- [Create a marker](#creation-workflow)
- [Retarget, rename, or delete](#modification-and-deletion)
- [Liquid consumers](#liquid-consumers)
- [Coordinated operations](#coordinated-operations)
- [Verify](#verification-checklist) and [prohibited shortcuts](#prohibited-shortcuts)
- [Public references](#public-references)

## Platform support

Site markers are supported website metadata, including on Standard and Enhanced data model
sites.

The documented general-purpose UI is the Portal Management app:

1. Select **Website -> Site markers**.
2. Select **New**, or open an existing record.
3. Set **Name**, **Website**, and **Page**, then **Save & Close**.

Offer those as instructions only when the user asks for a management-app workflow.
Do not automate that remote UI or call private services during local authoring.
Changing a marker alone does not enable site search, configure indexing, create a page,
alter page permissions, or add navigation.

## Discover records and serialization

Follow `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`, requiring `web-pages/`
and the root-level `sitemarker.yml` file. The verified PAC download layout is:

```text
<site-root>/
  .portalconfig/
  website.yml
  sitemarker.yml
  web-pages/
    ...
```

`sitemarker.yml` contains a YAML sequence of marker records, not one file per marker.
Edit that sequence in place; do not create a marker directory or per-record files.
Inspect the actual download before writing. Mixed, conflicting, or unrecognized storage is blocked
until the authoritative record set is established. If the file is missing, report the
missing prerequisite rather than inventing a storage layout.

Read all existing marker records, their target webpages, and the relevant Liquid,
templates, snippets, settings, and feature references. Match by exact name scoped to
the selected website and stable marker ID, not by list position alone.
Names must be unique within that website: runtime name lookup can return the first
matching record, so duplicates are not a safe way to override a built-in marker.

Preserve the downloaded field vocabulary and YAML list structure:

```yaml
- adx_name: <exact-marker-name>
  adx_pageid: <existing-webpage-id>
  adx_sitemarkerid: <site-marker-id>
```

Existing downloaded records may omit `adx_pageid`. Preserve those unrelated entries
without inventing a page binding. For a requested page binding, set `adx_pageid` to the
verified target webpage ID.

## Field contract

| Logical value | Observed YAML keys | Authoring rule |
|---|---|---|
| Marker identity | `adx_sitemarkerid` | Generate once for creation; preserve during retargeting and renaming |
| Lookup name | `adx_name` | Required, nonempty, exact caller contract, unique within the selected website |
| Target webpage | `adx_pageid` | For a requested binding, a verified webpage UUID in the same website, never a route, display name, or template ID; preserve unrelated entries that omit this field |
| Website scope | Containing PAC site and any downloaded website relationship | Preserve explicit relationships and validate them against `website.yml`; do not add an API binding field |

Preserve unknown PAC fields, existing state/status, ordering, quoting, and unrelated
records. Reject conflicting identities or aliases rather than silently preferring one.

Resolve the target's root/localized relationship through [webpages](webpage-authoring.md).
For a new site-wide page binding, use the verified root webpage ID rather than a guessed
localized ID. Preserve an existing localized target unless changing it is explicitly
requested and its caller/language behavior is understood. Do not create one marker per
language under the same name. Localized pages and runtime URL behavior need separate checks.

## Creation workflow

1. Resolve the selected site, marker storage and field convention, and same-site page identity.
2. Establish the exact name and intended behavior. Reuse an existing matching marker when
   its binding already satisfies the request; report a no-change result without a new UUID.
   An existing name with a different target is a retargeting decision, not a new record.
3. If the page does not exist, stop unless the request also authorizes page creation.
   When authorized, execute the [webpage workflow](webpage-authoring.md) first, including
   its localization and navigation rules. A marker-only request does not authorize
   creating a page, changing its layout, or inventing a route.
4. Generate one UUID through `${PLUGIN_ROOT}/scripts/generate-uuid.js`.
5. Append one record to the YAML sequence in the existing root-level `sitemarker.yml`,
   preserving unrelated entries, field conventions, and ordering. Do not create a
   separate marker file or directory.
6. Bind the exact name to the verified page ID using the observed field vocabulary.
   Quote names safely as YAML data; do not interpolate a name into executable Liquid.
7. Change consumers only if the request includes them, using their owning references.
   Creating a marker alone does not insert a link into webpage body HTML.
8. Complete the independent verification below before reporting success.

## Modification and deletion

Retargeting preserves the marker ID and name and changes only the page relationship.
Inventory every known caller and platform dependency first: a site-wide marker can affect
more than the page where the request originated. Existing markers such as `Home`, `Search`,
`Profile`, `Access Denied`, and `Page Not Found` may have platform consumers that a local
text search cannot enumerate. Do not infer that an unused-looking built-in is disposable.

For a rename, preserve the ID, reject duplicate names, and resolve all old-name consumers.
Literal `sitemarkers['Name']` and `sitemarkers["Name"]` references, dynamically computed
lookups, settings, and platform-owned names are separate dependencies. Do not treat a
literal-only search as proof that all consumers are known. Do not rename a built-in
contract merely for branding or filename consistency.

For a page move or route rename that preserves page identity, the marker normally needs
no metadata change. Inspect the existing binding rather than rewriting it to a URL.

Deletion requires an explicit request and a resolved dependency/removal plan. Removing
the selected sequence entry does not prove that the remote Dataverse record will
be deleted by a later upload. Report local removal separately and leave remote deletion
to an explicitly authorized, verified deployment/management workflow. Never claim a
cloud marker was deleted after a local edit.

Stop before writing if platform impact, dynamic callers, target identity, or a required
caller migration is unresolved. Use the coordinator's existing plan approval when the
change requires wider scope or additional approval; do not add a separate approval gate.

## Liquid consumers

The supported lookup is `sitemarkers["<exact-name>"].url`. Missing names return null.
For example, in a Liquid-capable source:

```liquid
{% assign help_page = sitemarkers["Help"] %}
{% if help_page and help_page.url %}
  <a href="{{ help_page.url | escape }}">Help</a>
{% endif %}
```

Use quoted attributes and context-appropriate escaping. Do not fall back silently to
`#`, an invented URL, or an unrelated page when a required marker is missing; report
the missing binding during verification. A conditional display is not proof of setup.

Route template changes through [web templates](web-template-authoring.md), reusable
values through [content snippets](content-snippet-authoring.md), and localized body
HTML through the resolved `author-webpage-content` handoff. Inspect the actual rendering
context; a marker's Liquid expression is not automatically evaluated in a static JavaScript file.
Marker bindings do not bypass page visibility or access-control rules.

## Coordinated operations

`author-site-marker` is a reference operation identifier, not a registered skill.
Keep the existing plan schema and approval/receipt rules. Resolve names, marker IDs,
metadata paths, same-site page IDs, and impact in the operation's normal `target`,
`inputs`, and `preserve` fields.

If the target page is created in the same plan, use its verified output ID through the
existing dependency mechanism.
After rereading the written metadata, report only verified outputs declared by the operation.
Do not return a deleted record as a successfully resolved binding.

## Verification checklist

1. Re-read and parse every changed YAML file; confirm unchanged siblings and unknown fields.
2. Confirm the marker ID is a UUID and is preserved on edits; reject duplicate IDs or names.
3. For each created or retargeted page binding, resolve the page UUID to exactly one same-site
   webpage and inspect its root/localized relationship, publishing/visibility state, and requested
   locale availability. Preserve unrelated records that omit `adx_pageid`.
4. Confirm the root-level `sitemarker.yml` sequence and field vocabulary were preserved.
5. Compare the diff with the requested create/retarget/rename/remove scope, including callers.
6. For renamed or removed markers, account for old-name references and unresolved platform
   consumers. Verify no required caller points to a missing record.
7. Keep the `Search` marker and search-configuration work outside ordinary search-component
   body edits. A marker operation does not prove indexing or search readiness.
8. Verify approved dependency outputs and record only actual results in coordinated execution.
9. Report local completion, changed files, marker name/ID, page ID, and unresolved evidence.
   Runtime URLs, language resolution, and access control remain unverified unless separately
   observed. Do not invoke deployment or cache clearing.

## Prohibited shortcuts

- No hard-coded page URL in the marker's page-ID field.
- No duplicate marker names as an override mechanism or filename-based identity selection.
- No regeneration of IDs for a rename or retarget.
- No guessed Standard/Enhanced API fields or private API calls.
- No automatic page creation, navigation changes, search enabling, or permission changes.
- No replacement of `sitemarker.yml` with a marker directory or per-record files.
- No built-in marker rename/deletion justified only by an empty local search result.
- No claim that local file removal deletes the remote record.
- No new skill registration, independent preview notice, or reference-read tracking event.

## Public references

- [Configure site markers](https://learn.microsoft.com/power-pages/configure/configure-site-markers)
- [Liquid sitemarkers object](https://learn.microsoft.com/power-pages/configure/liquid/liquid-objects#sitemarkers)
- [Power Platform CLI for Power Pages](https://learn.microsoft.com/power-pages/configure/power-platform-cli)
