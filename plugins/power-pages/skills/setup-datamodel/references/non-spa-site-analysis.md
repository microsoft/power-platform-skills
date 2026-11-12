# Non-SPA Site Data Analysis

Use this workflow whenever `detect-project-context.js` returns `siteType: "non-spa"`. A
non-SPA PAC export is read-only evidence of the schema the site currently uses. It is not
authorization to edit site components, and a reference alone does not prove that a new table or
column is required.

## Inventory Primary Data Evidence

Build an inventory under `siteRoot` and inspect:

- `basic-forms/` — bound table, Dataverse form, create/edit/read mode, and relationships
- `advanced-forms/` — every multistep form and step, bound tables, modes, and parent/child flow
- `lists/` — bound table, saved view, and enabled create/edit/delete/detail actions
- `table-permissions/` — existing table use, CRUD posture, scope, and parent relationships
- `site-settings/` — only data-relevant settings, especially `Webapi/<table>/enabled` and
  `Webapi/<table>/fields`
- `web-pages/**/*.webpage.copy.html`
- `web-templates/**/*.webtemplate.source.html`
- JavaScript assets under `web-files/`

Extract:

- Liquid `{% fetchxml %}` tables, attributes, linked entities, filters, and relationships
- Liquid entity access and table logical names
- `/_api/` entity sets, HTTP methods, request bodies, and OData query options
- JavaScript `webapi.safeAjax`, `shell.getTokenDeferred`, `fetch`, `$.ajax`, and
  `XMLHttpRequest` usage
- Dataverse fields rendered, edited, filtered, ordered, grouped, or expanded
- Existing native Forms and Lists that already satisfy the capability

## Follow Active References

Build the active source graph:

```text
Webpage
  -> Page Template
    -> Web Template
      -> included Web Templates
        -> referenced Content Snippets
        -> referenced JavaScript Web Files
```

Use:

- `page-templates/` to resolve which Web Templates are active
- `{% include %}` references to follow nested templates
- `content-snippets/` only when reachable content contains Liquid, FetchXML, API calls, or
  Dataverse logical names
- `web-link-sets/` only as weak navigation or reachability evidence

Do not infer schema from plain text snippets, navigation labels, CSS, images, fonts, web roles,
ad placements, poll placements, bot consumers, or publishing-state rules. Inspect
`cloud-flow-definitions/` only when an active site feature invokes the flow and its contract
contains table or field evidence.

## Resolve Indirect Bindings Through Dataverse

Non-SPA YAML often contains a form or saved-view identifier rather than a full field list.
Query the exact target Dataverse environment to resolve:

- Basic Form and Advanced Form step form definitions
- Saved views and their FetchXML for Lists
- Exact table and column `LogicalName` values
- Existing relationships and navigation properties

Treat Dataverse metadata as the source of truth for those bindings. Do not propose duplicate
tables merely because a component references a standard table such as Contact, Account, or Case.

## Classify Evidence and Choose an Action

For each candidate table, column, or relationship, retain its active source evidence and classify
it as:

- **Existing and already used**
- **Existing but needs extension**
- **New table required**
- **Needs clarification**
- **Unused or unreachable reference**

Only the first three categories may become `reused`, `modified`, or `new` proposals. Map them to:

- **Reuse** when the existing Dataverse schema already supports the active site capability
- **Extend** when active evidence requires fields or relationships absent from an existing table
- **Create** only when active evidence or the user's explicit requirement cannot be satisfied by
  an existing table

Plain text, navigation labels, styling assets, and unused templates are not schema evidence. A
non-SPA site with a complete existing schema may legitimately produce no Dataverse changes;
the workflow may still verify that schema and write `.datamodel-manifest.json`.

## Required Proposal Evidence

Include an evidence-to-action matrix in the proposal:

| Requirement | Active site evidence | Dataverse status | Proposed action |
|-------------|----------------------|------------------|-----------------|
| Customer identity | Basic Form bound to Contact | Exists | Reuse |
| Registration workflow | Advanced Form steps and resolved form fields | Missing required relationship | Extend |

Identify references that were ignored because they were unreachable, presentational only, or
insufficient to justify schema creation. State the exact PAC-authenticated target environment and
the analyzed site identity.

## Read-Only Boundary

Do not create or modify Forms, Advanced Forms, Lists, pages, templates, snippets, table
permissions, site settings, Web Files, cloud flows, navigation, or any other non-SPA site
component. This analysis authorizes only a proposed Dataverse schema. Dataverse writes remain
blocked until the main skill presents the complete proposal and receives explicit user approval.
