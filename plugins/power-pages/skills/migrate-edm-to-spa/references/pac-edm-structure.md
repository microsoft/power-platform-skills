# PAC EDM Website Data Structure

Use this reference during `/migrate-edm-to-spa` Phase 2 and Phase 3 to locate and classify records in a PAC-downloaded classic EDM Power Pages site. The structure is based on observed Community Portal V2, Customer Portal V2, Employee Self-Service Portal V2, and FAQ V2 website-data patterns and should be treated as guidance, not as a fixed schema.

## Expected Root Shape

A downloaded EDM website-data root commonly contains these files and folders:

| Path | Purpose | Migration use |
|------|---------|---------------|
| `website.yml` | Website metadata such as name, language, header/footer templates | Site identity, default language, shell templates |
| `web-pages/` | Page records, localized content pages, copy, CSS, JavaScript sidecars | SPA routes, page content, route hierarchy |
| `web-templates/` | Web template records plus Liquid/HTML source sidecars | Layouts, reusable components, Liquid intent |
| `content-snippets/` | Reusable content fragments | Content constants, layout text, localized strings |
| `page-templates/` | Page-to-template mappings | Route layout selection |
| `web-files/` | Uploaded assets and static files | Public assets and imports |
| `weblink-sets/` | Navigation structures | Header/footer/sidebar navigation |
| `lists/` | Entity list configuration and custom JavaScript | Data grids, list pages, read actions, filters |
| `basic-forms/` | Entity form configuration, metadata, and custom JavaScript | Create/edit/detail forms and validation |
| `advanced-forms/` | Multistep web form records when present | Advanced form flow, authentication, progress, and session behavior |
| `table-permissions/` | Table permission records | Server-side security and Web API permission planning |
| `webrole.yml` | Web role records | Role mapping and auth UX |
| `sitesetting.yml` | Site settings | Auth, search, profile, knowledge, Web API, feature flags |
| `sitemarker.yml` | Named route markers | Route aliases and special pages |
| `webpagerule.yml` | Page rules and redirects | Redirects and access behavior |
| `websiteaccess.yml` | Website access records | Administrative/security context |
| `locale/`, `websitelanguage.yml` | Locale and language records | Localization scope |
| `blogs/`, `forums/`, `polls/`, `poll-placements/` | Portal feature records | Usually manual-gap candidates unless explicitly in scope |

## Observed Template Variants

Use these variants to avoid overfitting to one portal shape:

| Template family | Observed characteristics | Static-analysis implications |
|-----------------|--------------------------|------------------------------|
| Community/customer support portals | Case routes, knowledge-base routes, forums, case forms, case lists, contact/account table-permission scopes | Treat cases, activities, portal comments, notes, knowledge articles, and product filtering as likely Dataverse/security-heavy areas |
| Employee self-service portal | Similar support records plus `advanced-forms/` for event registration | Inspect advanced form authentication/session/progress settings and treat multistep form behavior as high-risk |
| FAQ portal | Admin route families such as article/topic management, FAQ tables, Web API site settings, rich text file access, custom Web API wrapper templates | Inspect admin routes separately from public FAQ routes and map FAQ tables, Web API settings, safe AJAX wrappers, and rich-text attachments |

## Nested Record and Sidecar Patterns

Records are often stored as folders containing a YAML record plus sidecar files. The analyzer should inspect all sidecars, not just YAML.

### Web Pages

Typical page folder:

```text
web-pages/<page-slug>/
  <Page>.webpage.yml
  <Page>.webpage.copy.html
  <Page>.webpage.summary.html
  <Page>.webpage.custom_css.css
  <Page>.webpage.custom_javascript.js
  content-pages/
```

Important fields and sidecars:

| Source | Inspect for |
|--------|-------------|
| `.webpage.yml` | `adx_name`, `adx_partialurl`, parent page references, page template ID, publishing state, hidden-from-sitemap flag |
| `.copy.html` | Main body content, embedded Liquid, HTML structure |
| `.summary.html` | Card/list summaries and metadata |
| `.custom_css.css` | Page-scoped styling to port or replace |
| `.custom_javascript.js` | Page behavior, jQuery selectors, validators, redirects, API calls |
| `content-pages/` | Localized variants and language-specific content |

### Web Templates

Typical template folder:

```text
web-templates/<template-name>/
  <Template>.webtemplate.yml
  <Template>.webtemplate.source.html
```

Inspect source files for:

- `{% include %}` and template dependencies.
- `{% assign %}`, `{% if %}`, `{% for %}`, filters, and variables.
- `sitemarkers`, `settings`, `snippets`, `user`, `request`, and table/entity references.
- FetchXML blocks or data-driven Liquid.
- Header/footer/layout responsibilities that should become SPA shell components.

### Lists

Typical list files:

```text
lists/<List>.list.yml
lists/<List>.list.custom_javascript.js
```

Inspect:

- `adx_entityname`
- `adx_entitypermissionsenabled`
- `adx_pagesize`
- `adx_searchenabled`
- `adx_filter_enabled`
- `adx_odata_enabled`
- Embedded JSON in `adx_settings`
- View actions, item actions, create/detail/edit targets, redirect page IDs, button labels, modal settings
- Custom JavaScript sidecars that alter list behavior

### Basic Forms

Typical form folder:

```text
basic-forms/<form-slug>/
  <Form>.basicform.yml
  <Form>.basicformmetadata.yml
  <Form>.basicform.custom_javascript.js
```

Inspect:

- `adx_entityname`
- `adx_mode`
- `adx_formname`
- `adx_entitypermissionsenabled`
- Redirect settings and query-string behavior
- Attachment settings
- CAPTCHA and required-field flags
- Embedded JSON in `adx_settings`
- Metadata records for field behavior
- Custom JavaScript, especially `Page_Validators`, DOM selectors, dependent fields, and portal runtime globals

### Advanced Forms

Advanced forms may appear as:

```text
advanced-forms/<form-slug>/
  <Form>.advancedform.yml
```

Inspect:

- `adx_name`
- `adx_webformid`
- `adx_authenticationrequired`
- `adx_multiplerecordsperuserpermitted`
- `adx_editexistingrecordpermitted`
- `adx_startnewsessiononload`
- Progress indicator settings
- Localized messages embedded as YAML arrays
- Related page templates that rewrite to web form runtime pages

Advanced forms usually represent multistep or portal-managed flows. Treat them as high-risk unless runtime discovery confirms a simple one-step equivalent.

### Table Permissions

Typical file:

```text
table-permissions/<Permission>.tablepermission.yml
```

Inspect:

- `adx_entitylogicalname`
- `adx_scope`
- CRUD flags: `adx_read`, `adx_create`, `adx_write`, `adx_delete`, `adx_append`, `adx_appendto`
- Relationship fields such as contact, account, or parent relationship names
- `adx_entitypermission_webrole`
- Parent permission references

Use these records to decide whether migrated data access needs `/integrate-webapi`, `/create-webroles`, and `/audit-permissions`.

## Static Research Checklist

During static analysis, produce counts and representative findings for each area:

| Area | Required checks |
|------|-----------------|
| Routes | Page hierarchy, partial URLs, hidden pages, access denied/not found/profile/search routes |
| Layout | Header/footer templates, page templates, navigation sets, snippets |
| Liquid | Includes, conditionals, loops, settings/snippets/sitemarkers/user/request usage, FetchXML |
| Content | Page copy, summaries, snippets, localized content |
| Assets | Images, CSS, JavaScript, downloadable files |
| Lists | Table, actions, filters, search, pagination, custom JavaScript |
| Forms | Basic and advanced forms, table, mode, redirects, attachments, validation, metadata, custom JavaScript, progress/session behavior |
| Data | Tables, relationships, operations, FetchXML/OData/Web API references |
| Security | Web roles, table permissions, website access, page rules |
| Auth/settings | Registration, identity providers, profile redirects, search, knowledge, product filtering |
| Manual features | Blogs, forums, polls, knowledge facets, comments, bots, portal-specific widgets |

## High-Risk Indicators

Flag these early in the readiness phase:

- Many web templates with nested includes or data-driven Liquid.
- Liquid FetchXML or entity access that controls page output.
- Custom JavaScript that depends on jQuery, `Page_Validators`, or portal runtime globals.
- Entity lists/forms with complex `adx_settings` JSON actions.
- Advanced forms, multistep form runtime pages, or progress/session settings.
- Admin route families that manage records such as FAQ articles/topics.
- Contact, Account, Parent, or Self table-permission scopes that require careful server-side security mapping.
- Auth provider, registration, invitation, or profile behavior that affects user journeys.
- Search, knowledge management, forums, blogs, polls, case deflection, or bot integrations.
- Web API wrapper templates using `shell.getTokenDeferred`, `validateLoginSession`, or custom `safeAjax` helpers.
- Site settings that enable Web API table access or use wildcard field access, such as `Webapi/<table>/fields` set to `*`.
- Runtime-only behavior found in JavaScript but not represented by YAML.

## Output Expectations

The static analyzer should save:

- `edm-source-inventory.json`: counts, file paths, and record categories.
- `static-analysis.json`: structured findings by route, template, data, security, and behavior.
- `static-analysis-summary.md`: human-readable readiness and findings summary.

Every finding that influences generated SPA code should include evidence paths and confidence.
