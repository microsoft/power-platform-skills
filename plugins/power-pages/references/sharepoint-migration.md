# SharePoint discovery and backend reference

For source inspection or branding, read **Source discovery and branding**.
For virtual-list or document integration, read the matching branch under **Backend paths**.
Recheck the linked Microsoft documentation before relying on feature availability, permissions, or runtime contracts.
Record results using the **requirements**, **discovery**, **plan**, and **progress** aliases defined in `${PLUGIN_ROOT}/references/sharepoint-artifacts.md`.

## Source discovery and branding

### Browser-only boundary

Inspect SharePoint through the user-visible browser and the user's normal site access.
This avoids making discovery depend on tenant-specific application-permission grants.
Normal SharePoint permissions still apply; browser access is not a way around an access denial.

Drive the UI and read rendered content.
Do not use Azure CLI tokens, Graph/SharePoint REST clients, command-line HTTP tools, or `WebFetch` to retrieve private SharePoint source data.
Do not call `fetch`/XHR or service endpoints from browser evaluation, capture/replay network requests, or extract cookies/tokens from storage or traffic.
SharePoint may make its normal internal requests while rendering the UI; the agent interacts with that UI rather than issuing those requests itself.
Browser evaluation is limited to rendered DOM text, visible element links/styles, and visual navigation such as scrolling.
Hidden bootstrap payloads and client data caches are not a substitute for visible UI evidence.

This boundary applies to source inspection and branding extraction.
Public documentation lookup, approved Dataverse provisioning, and Power Pages runtime integration remain separate workflows under **Backend paths**.
The maker's SharePoint browser session must never be transferred into the generated SPA.

### Open sign-in and wait for the user

Keep the running local preview in its own tab/panel while the user signs in to SharePoint in the inspection tab.

1. Navigate to the approved SharePoint URL in the same browser context that will inspect it.
2. If SharePoint redirects to sign-in or shows a Sign in control, open that page in a user-visible window.
   Use the site's own flow so its tenant and return location are preserved, rather than constructing an authentication URL.
3. Fire the main skill's `4.browser-sign-in` Approval Gate and ask the user to complete sign-in, account selection, and MFA in that window.
   The user enters credentials; the agent neither collects them nor answers authentication challenges.
4. After the user chooses Continue, return to the selected resource and take a fresh snapshot.
   Confirm the expected site/list/document content is visible, not merely that the login page disappeared.
5. If access is still denied, record the visible outcome and wait for the user/source owner to resolve it, or use explicitly supplied information for an unverified preview.

Signing in to another browser profile does not authenticate the inspection session.
If the automation browser cannot be shown to the user, pause until an interactive/shared browser is available; do not bridge sessions by exporting credentials.
Keep the user's session unchanged on cancellation.

**Access established when:** The approved resource is visibly accessible in the inspection browser after any required user sign-in.
Otherwise record the source as blocked/unverified, not empty.

### Inspect the approved resources

Start with the selected site's navigation or resource URL and use ordinary read-only browser controls.
For a list scenario, complete the inventory and selection branch below before inspecting list contents.
Use existing views and details panes; keep edit/save/delete/share actions and persistent view changes outside discovery.

| Resource | Inspect through the UI | Record and qualify |
|---|---|---|
| Site and pages | Approved navigation, page sections, headings, links, and rendered web parts | Selected page structure and content summaries; distinguish visible behavior from functionality that still needs implementation. |
| Lists | Selected view, displayed columns, item details, existing filters/sorts, and accessible column/settings information | Observed labels, types/options only where shown, candidate mappings, and the visible row/sample coverage. |
| Libraries and folders | Approved library/folder view and file details | Names, metadata, hierarchy, and selected file references; no bulk downloads. |
| Documents | The approved document's browser preview and details pane | Only the sections/metadata needed for the agreed scenario; use supplied excerpts when the viewer cannot expose them safely. |

Wait for loading to finish and use UI pagination or scrolling for the approved scope.
Virtualized lists show only part of their contents in the DOM.
Record the active view, filters, inspected pages/rows, and whether the UI provides an authoritative total.
Visible rows are a sample unless complete coverage is established; a view count is not automatically the whole-list count.
Record internal names, data types, relationships, and hidden columns as unverified when the authorized UI does not expose them.
Never infer an internal schema name from a display label.

Follow only the selected resource's required sign-in/preview transitions.
For unrelated links or resources outside the approved scope, ask before proceeding.
When the UI cannot provide required information, document the gap and request user-supplied metadata or a scoped preview decision rather than switching to APIs.

**Discovery complete when:** Each approved resource has a recorded browsing outcome and coverage, useful findings have provenance, and missing/partial evidence is explicit.

### List inventory and selection

For each approved SharePoint site, open **Site contents** through the browser UI and inventory all accessible lists before asking which to expose.
Scope means those sites, not every site in the tenant; expanding to another site or subsite requires approval.
Inventory reads names and available metadata, not every list's item contents.

Follow Site contents pagination, loading, and scrolling until all entries in the authorized view are accounted for.
Use the visible item type to distinguish lists from document libraries and other site resources.
For each list, record its site, name, description when shown, browser URL, and list ID only when it is exposed in a normal visible link/settings URL.
Use site plus URL/ID as identity so duplicate display names cannot be merged accidentally.
Preserve provider-incompatible lists in the inventory with the known restriction; do not silently omit them.

Show the inventory in **discovery**, then fire `4.select-lists` in the main skill.
Allow multiple selections and confirm the exact set.
Selection determines which lists get a virtual table and portal integration; remaining lists stay excluded.
When the UI cannot establish complete inventory, mark coverage partial and let the user choose whether to proceed with the known subset or resolve access.

After selection, inspect only those lists for the mapping and access plan.
A visible SharePoint view/filter is not a virtual-table security boundary and does not restrict every portal query to that subset.
Any field or row exclusions must be enforceable through the destination design before enabling Web API access.

**Selection complete when:** The site-scoped inventory has explicit coverage, the user has chosen the exact list set, and each selected list has a stable source reference or a recorded identity-resolution dependency.

### Inspect branding

Use this branch only for an approved SharePoint theme source.
Read the rendered header, navigation, typography, colors, spacing, logo, and other selected brand elements.
Use snapshots for structure, computed styles for actual rendered values, and a screenshot only when visual details need it.
These are observations of the selected pages, not a complete tenant-theme export.

Propose a small set of reusable design tokens for the create-site plan, checking contrast and responsive behavior.
Record source URLs/elements and explain adaptations.
Obtain external reuse approval before copying an asset.
Use ordinary browser download controls for an approved asset when available; otherwise request the asset from the user rather than retrieving it through a service call.
For an inaccessible theme source, record the limitation and ask for supplied assets or a new-theme choice.

**Theme complete when:** The plan links observed styles/assets to their source, distinguishes adaptations and missing assets, and has user approval.

### Content and asset handling

Recreate approved layouts as React components and serve source text through an approved authenticated path, such as a permission-protected Dataverse content table.
If that needs a separate page-content copy operation, approve it explicitly; the SharePoint-list importer does not perform it.
If rich text must be retained, sanitize it with a maintained allowlist sanitizer and restrict links/media to approved protocols and destinations.
Remove scripts, event handlers, embedded frames, unsafe URLs, source tracking code, and internal navigation.
Do not use unsanitized `dangerouslySetInnerHTML`.

Confirm external reuse rights for logos, photographs, fonts, and documents.
Copy only approved non-sensitive branding into the shell; keep private assets behind runtime access rather than hotlinking a maker-session URL.

## Backend paths

These paths configure the destination after source discovery.
Browser-only discovery does not remove their own connector, administrator-consent, identity, or table-permission prerequisites.
Power Pages session-authenticated runtime APIs are not a fallback for inspecting SharePoint with maker credentials.

### A. SharePoint lists copied into Dataverse

The requested [Easier than ever experience to import data from SharePoint List](https://www.microsoft.com/en-us/power-platform/blog/power-apps/easier-than-ever-experience-to-import-data-from-sharepoint-list/) describes a maker experience, not a callable migration utility.
The current table-authoring documentation provides a table-only route:

**Power Apps maker portal > select the approved environment > Tables > New table > Create with external data > SharePoint list.**

Use the SharePoint connection to select the approved site and list, review the inferred table/column names and types, then save the table.
Do not create an unrelated canvas app as part of this Power Pages workflow.
If the UI differs, consult the current documentation rather than calling a guessed endpoint.

The SharePoint import route is currently documented as **preview**, and its documentation warns that preview features are not intended for production.
Use it for the approved hackathon or development pilot only.
Before a production migration, recheck availability and use a currently supported import mechanism with a revised, approved mapping if the preview restriction remains.
Do not confuse the availability of Copilot features elsewhere on the page with the status of this importer.

**Prerequisites:** A Dataverse environment, the documented table-authoring permissions (System Customizer and an appropriate role with Create/Read/Write on the Entity table), data-write permission, and an authorized SharePoint connection.
Copilot is not required in every supported scenario; the FAQ permits import without it where Copilot is unavailable.
Do not invent a dedicated OAuth scope or undocumented API for the maker experience.

Before saving each import, fire the parent skill's per-action Approval Gate.
The source selection must match the approved copy scope, not merely the columns the SPA will display.
If this importer cannot filter rows or columns before ingestion, stop and propose a curated, approved input or a separately documented import mechanism.
Do not import the full list and delete or hide unapproved data afterward.
Do not modify the original SharePoint list to make the import work.

The first **20 rows are a preview**, not the complete import or a dataset limit.
After saving, wait for background ingestion to finish and inspect completion/errors before comparing counts.
This copies data once; it does not establish ongoing refresh, source deletions, or write-back to SharePoint.

#### Mapping and verification

| Concern | Required treatment |
|---|---|
| Explicit exclusions | This importer omits image, task outcome, external data, managed metadata, single/multiple attachments or images, SharePoint system columns, column-level numeric symbols (currency/prefix/postfix), and unique-value settings. Flag these before approval. |
| Complex fields | Verify person/group, lookup, calculated, choice, and other nontrivial mappings from the actual result; do not assume preservation or a complete conversion matrix. |
| Attachments | List attachments are not copied by this workflow. Do not pretend they become document-library locations; require a separately approved path or leave them excluded. |
| Stable identity | Do not assume the SharePoint system ID survives. If resumable import or refresh is required, explicitly map a permitted source identifier into an ordinary destination column using a supported path. Without a reliable key, stop before repeating an import that could duplicate rows. |
| Values | Check nulls, dates/time zones, Unicode, rich text, choices, relationships, and number precision against approved samples. |
| Completion | Compare approved source and destination counts after ingestion; surface rejected rows and schema loss. Save copy time, counts, and status in **progress**. |
| Solution ownership | Add created schema/components to the selected unmanaged solution using the existing solution workflow. Solution packaging does not transport the copied business records. |
| Ongoing operation | Record source of truth, refresh owner, stale-data behavior, and any separately approved refresh/deletion/conflict policy. A periodic Power Automate flow is additional work, not an import setting. |

Do not quote an undocumented row/column limit, the SharePoint list-view threshold, or an Excel-import limit as this importer's capacity.
Assess actual volume, supported limits, ingestion progress, and destination capacity.

Once mapping is verified, delegate frontend integration to `/power-pages:integrate-webapi` with the exact tables and operations.
Use `/_api/<EntitySetName>`, not the logical table name as an assumed plural.
Configure `Webapi/<logical-table-name>/enabled` and an explicit allowed-fields list plus table permissions on the destination tables.
The wildcard fields value `*` is deprecated; do not use it.
Use the shared Power Pages API client for session and anti-forgery handling, explicit projections, paging, and surfaced errors.
Do not put maker/Graph/SharePoint credentials in React.

Table permissions, relationships, and web roles enforce row access on the server.
A React filter or OData filter is not an authorization boundary.
If a table mixes audiences, use a verified Contact/Account/Parent relationship or another supported server-enforced design; never grant Global read and rely on the UI to hide other rows.
Assign permissions only to the approved authenticated web roles; never grant source-data access to an anonymous role.
Verify direct access under the skill's authenticated-only isolation checks.

**Import complete when:** Ingestion has finished, every mapping check has evidence, counts reconcile, and rejected or unsupported data is explicitly accounted for.
**Integration complete when:** The verified destination tables are accessed through the configured Power Pages API and the approved audience passes both allowed and denied access tests.

Sources: [create tables with external data](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/create-edit-entities-portal#create-with-external-data), [excluded SharePoint columns](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/create-edit-entities-portal#sharepoint-columns-not-used-in-dataverse-table-generation), [import FAQ](https://learn.microsoft.com/en-us/power-apps/maker/common/faqs-sharepoint-list-to-table-app), and [Power Pages Web API](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview).

The blog's older canvas-app link can lead to a **direct SharePoint-connected canvas app**, where edits update SharePoint.
That is not the copied-to-Dataverse architecture above.
[Programmable Dataverse import](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/import-data) is another mechanism; it is not a public API wrapper around this maker experience and requires its own approved design.

### B. Documents remain in SharePoint

Power Pages documents SharePoint document management through **basic or multistep forms**.
It does not document arbitrary external access to every source library.
The supported setup requires:

1. SharePoint Online with server-based integration, in the same Microsoft 365 tenant as the Dataverse integration.
2. Environment document management and the intended default SharePoint site record.
3. Power Pages SharePoint integration enabled by an authorized administrator.
4. Document management enabled for the parent Dataverse table.
5. A configured Dataverse form with a Document Locations subgrid and the corresponding basic/multistep form.
6. Web roles and related parent/document-location table permissions.

Enabling Power Pages SharePoint integration changes Entra application permissions and requires consent; the documented procedure calls for a Global Administrator.
Table-level document management requires System Administrator or equivalent permissions and the documented relationship support.
Guide the administrator through these steps with explicit approval rather than broadening roles or granting application permissions automatically.
Do not change the environment's default SharePoint site to accommodate one migration without assessing existing integrations.

For an existing library/folder, verify its association to the intended Dataverse parent record.
If it is not correctly related, report the mismatch and approve a supported mapping before proceeding.
A document location points to a library/folder; it does not copy document bytes into Dataverse.
Uploads require an existing parent record, not an unsaved create form.

#### Table permissions

Microsoft documents this permission combination:

| Operation | Parent-table permission | Related `sharepointdocumentlocation` permission |
|---|---|---|
| Read/download | Read and Append To | Read |
| Upload | Also Write | Also Create, Write, and Append |
| Delete | No additional parent privilege specified by this procedure | Also Delete |

Create the related child permission for each applicable parent permission.
Use an audience-specific web role and a verified Contact/Account-scoped parent relationship where appropriate.
Do not default document locations to Global access.
Grant only the operations approved by the user.

#### Direct SPA transport is a compatibility boundary

The requested `/_services/sharepoint.*` denotes an intended document transport, not a literal URL or a verified endpoint family.
The public document-management guide specifies form behavior, not a supported public SPA endpoint/request/response contract.
Do not derive list/download/upload/delete URLs or payloads from that shorthand.
Do not assume the Dataverse `/_api` client or its CSRF contract applies unchanged.

For a direct React integration:

1. First establish the documented document-management setup on the approved private pilot.
2. Confirm code-site compatibility and obtain the exact supported contract from current Microsoft documentation or Microsoft support.
3. If the user approves an experimental pilot, read-only browser inspection of the native control may establish observed list/download request shapes for that pilot only.
4. Isolate an observed transport in one document service, record its evidence and site version in **discovery**, and implement only verified operations.
5. Use the visitor's Power Pages session and required anti-forgery mechanism, keeping requests same-origin and constrained to authorized parent/location IDs.
6. Verify allowed and denied identities, out-of-scope record IDs, folder navigation, filenames, file downloads, and failure handling on the actual runtime.

Browser observation alone does not establish a supported production API.
If support or compatibility cannot be established, mark the custom SPA document integration blocked.
Offer the documented native form experience only as a separately approved change in scope; do not silently add Liquid or a server-rendered framework to the React code site.
Do not substitute direct browser Graph access, maker tokens, copied document binaries, or anonymous SharePoint links.

The document service must not accept arbitrary SharePoint URLs, library IDs, or unrestricted folder paths from the browser.
Server permissions must deny access outside the authorized parent/location even if an ID is changed manually.
Do not return inaccessible document titles in search results or log file contents.

For a verified native integration, the documented upload default is **10 MB**, configurable up to **50 MB**; Microsoft recommends individual downloads **250 MB or smaller** to reduce timeouts.
These are document-management constraints, not SharePoint-list import limits.

Sources: [Power Pages SharePoint document management](https://learn.microsoft.com/en-us/power-pages/configure/manage-sharepoint-documents), [server-based SharePoint integration](https://learn.microsoft.com/en-us/power-platform/admin/set-up-dynamics-365-online-to-use-sharepoint-online), [enable document management for tables](https://learn.microsoft.com/en-us/power-platform/admin/enable-sharepoint-document-management-specific-entities), [document-location table](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/sharepointdocumentlocation), and [Power Pages table permissions](https://learn.microsoft.com/en-us/power-pages/security/table-permissions).

**Document integration complete when:** Parent/location associations, permissions, and each approved operation have runtime evidence, including denied identities and out-of-scope IDs/folders.
Record an observed pilot transport as experimental; only an established supported contract qualifies it for production release.
