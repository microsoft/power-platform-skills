# SharePoint discovery and backend reference

For source inspection or branding, read **Source discovery and branding**.
For virtual-table or document integration, read the matching branch under **Backend paths**.
Recheck the linked Microsoft documentation before relying on feature availability, permissions, or runtime contracts.
Record results using the **requirements**, **discovery**, **plan**, **sharing**, and **progress** aliases defined in `${PLUGIN_ROOT}/references/sharepoint-artifacts.md`.

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
| Documents | The approved document's browser preview and details pane | Only the sections/metadata needed for the agreed scenario; use supplied excerpts when the viewer cannot share them safely. |

Wait for loading to finish and use UI pagination or scrolling for the approved scope.
Virtualized lists show only part of their contents in the DOM.
Record the active view, filters, inspected pages/rows, and whether the UI provides an authoritative total.
Visible rows are a sample unless complete coverage is established; a view count is not automatically the whole-list count.
Record internal names, data types, relationships, and hidden columns as unverified when the authorized UI does not share them.
Never infer an internal schema name from a display label.

Follow only the selected resource's required sign-in/preview transitions.
For unrelated links or resources outside the approved scope, ask before proceeding.
When the UI cannot provide required information, document the gap and request user-supplied metadata or a scoped preview decision rather than switching to APIs.

**Discovery complete when:** Each approved resource has a recorded browsing outcome and coverage, useful findings have provenance, and missing/partial evidence is explicit.

### List inventory and selection

For each approved SharePoint site, open **Site contents** through the browser UI and inventory all accessible lists before asking which to share.
Scope means those sites, not every site in the tenant; expanding to another site or subsite requires approval.
Inventory reads names and available metadata, not every list's item contents.

Follow Site contents pagination, loading, and scrolling until all entries in the authorized view are accounted for.
Use the visible item type to distinguish lists from document libraries and other site resources.
For each list, record its site, name, description when shown, browser URL, and list ID only when it is shared in a normal visible link/settings URL.
Use site plus URL/ID as identity so duplicate display names cannot be merged accidentally.
Preserve provider-incompatible lists in the inventory with the known restriction; do not silently omit them.

Show the inventory in **discovery**, then fire `4.select-lists` in the main skill.
Allow multiple selections and confirm the exact set.
Selection determines which lists get a virtual table and portal integration; remaining lists stay excluded.
When the UI cannot establish complete inventory, mark coverage partial and let the user choose whether to proceed with the known subset or resolve access.

After selection, inspect only those lists for the mapping and access plan.
For each selected list, record a candidate **text** column for the virtual table's primary field; provisioning needs one and only string columns qualify.
Record any column whose type the provider cannot carry across, so the sharing plan never depends on content that will be absent.
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
If that needs a separate page-content copy operation, approve it explicitly; virtual tables over lists do not perform it.
If rich text must be retained, sanitize it with a maintained allowlist sanitizer and restrict links/media to approved protocols and destinations.
Remove scripts, event handlers, embedded frames, unsafe URLs, source tracking code, and internal navigation.
Do not use unsanitized `dangerouslySetInnerHTML`.

Confirm external reuse rights for logos, photographs, fonts, and documents.
Copy only approved non-sensitive branding into the shell; keep private assets behind runtime access rather than hotlinking a maker-session URL.

## Backend paths

These paths configure the destination after source discovery.
Browser-only discovery does not remove their own connector, administrator-consent, identity, or table-permission prerequisites.
Power Pages session-authenticated runtime APIs are not a fallback for inspecting SharePoint with maker credentials.

### A. SharePoint lists stay in SharePoint behind virtual tables

A virtual table is a live view of one SharePoint list, not a copy of it.
Dataverse holds the table definition; every read goes to SharePoint at request time through the [virtual connector provider](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/create-virtual-tables-using-connectors).
There is no ingestion to wait for, no second copy to keep fresh, and no refresh schedule to own.
The trade is that source availability, provider limits, and the connection identity become runtime concerns for every page that reads the list.

Provision **one virtual table per selected list**, then share each table through Power Pages table permissions and Web API site settings exactly as the plugin does for any other Dataverse table.

#### One wizard pass establishes the site, then scripts repeat it

A SharePoint connection is an interactive OAuth grant, and the connection, connection reference, and data source it produces have no public creation API.
So the maker creates the **first** table for a SharePoint site in the browser, and the scripts reuse the provider and data source ids the platform wrote for it.

Read the environment first:

```bash
node "${PLUGIN_ROOT}/scripts/list-sharepoint-virtual-sources.js" --envUrl "<envUrl>"
```

It returns the connector data providers, the SharePoint data sources, the virtual tables already bound to them, a `seedTable` to copy ids from, and a `wizard` target.
This reads Dataverse only. It never contacts SharePoint, so it does not weaken the browser-only discovery boundary above.

`ready: true` means the wizard pass already happened; skip to provisioning with the returned `seedTable`.
`ready: false` means it has not, and `nextAction` names the missing piece: a provider, a data source, or a first table.

**Do not hand the maker a URL to go and find. Open the page for them.**
Fire the parent skill's `7.virtual-table-wizard` pause gate and drive the browser:

1. Open `wizard.url` in its own tab, leaving the live preview and any SharePoint inspection tab where they are.
   The script scopes the link to the approved environment when it can resolve the environment id, and falls back to the portal root when it cannot.
2. Snapshot the page and tell the user what actually loaded.
   Maker-portal routing below the host is product UI rather than a documented API, so a deep link can land somewhere else after a portal change; quote `wizard.breadcrumbs` and let the user navigate rather than insisting the link was correct.
3. Ask the user to create one virtual table for any single selected list, inside the approved unmanaged solution so it travels with the rest of the site's components.
   They sign in, choose or add the SharePoint connection, and save. The agent supplies no credentials and answers no consent prompt.
4. If the wizard reports a missing provider, have them install the **Virtual Connector Provider** solution from the commercial marketplace, then retry.
5. After the user continues, run the script again. **`ready: true` is the evidence, not the fact that the page opened.**
   While it is still false, report what the script found and offer the choice again; never start provisioning on the assumption that the wizard succeeded.

Wizard navigation, whichever surface the user prefers:

| Surface | Navigation |
|---|---|
| Power Apps maker portal | **Solutions > open the approved unmanaged solution > New > Table > Virtual table** |
| Power Pages design studio | **Data workspace > + Table > New table from external data > SharePoint** |

Sources: [create virtual tables using virtual connectors](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/create-virtual-tables-using-connectors) and [Data workspace virtual tables](https://learn.microsoft.com/en-us/power-pages/configure/data-workspace-virtual-tables).

#### Provision the remaining lists

For each remaining selected list, fire the parent skill's per-action Approval Gate, then run:

```bash
node "${PLUGIN_ROOT}/scripts/create-virtual-table.js" \
  --envUrl "<envUrl>" --projectRoot "<PROJECT_ROOT>" \
  --seedTable "<logical name from list-sharepoint-virtual-sources>" \
  --externalName "<SharePoint list title>" \
  --schemaName "<prefix>_<Name>" --displayName "<Name>" --pluralName "<Names>" \
  --primaryColumnSchemaName "<prefix>_<Column>" --primaryColumnExternalName "<SharePoint column>" \
  --primaryColumnDisplayName "<Column>" \
  --site "<site URL>" --listUrl "<list URL>" \
  --solutionUniqueName "<solution>"
```

Add `--dry-run` to show the exact table definition before anything is written.
Choose the primary column from a **text** column the list actually has; only string columns qualify, and the list must have one.
The script creates the table, waits for the provider's column-generation job, reads the generated columns back, publishes the table, and records the result in `<PROJECT_ROOT>/.sharepoint-sharing.json`.

Read its `status` rather than its exit code:

| `status` | Meaning | Next step |
|---|---|---|
| `created` | The table exists and the provider generated its columns. | Continue to permissions and site settings. |
| `adopted` | The table already existed on the same data source and was re-verified. | Continue; a repeated run is not a second table. |
| `created-unverified` | The table exists but no generated column appeared in time. | Inspect the column-generation job in System Jobs, then re-create that list through the wizard. Do not configure access for it. |

A `created-unverified` table is not a working integration.
Record it as blocked and keep it out of the Web API settings until its columns exist.

#### What the provider cannot carry across

| Concern | Required treatment |
|---|---|
| Unsupported column types | Person or Group, Image, Managed metadata, Location coordinates, and Attachment columns are not projected into the table. Content held only in one of these is absent, not hidden. Confirm the sharing plan does not depend on them. |
| Required source shape | The list needs at least one text column for the primary field. SharePoint's hidden numeric `ID` supplies the key. |
| Provider columns | The generated table carries `ID` (the external key) and `ComplianceAssetId` (SharePoint bookkeeping). Keep both out of the field allowlist unless the maker asks for them. |
| Text length | A virtual text column carries at most 4,000 characters; a longer source value fails validation on write. |
| Result size | A virtual-table query is limited to 1,000 records, and a query that crosses a relationship past that limit fails with an error. Filter server-side and page. |
| Negative filters | `Does Not Equal` and `Does Not Contain` can page incorrectly past the first page. Build queries from positive filters. |
| Views | A SharePoint view is not a security boundary and the provider cannot select an **All** view. Enforce every row and column exclusion through the destination design. |
| Solution ownership | Create the table into the approved unmanaged solution with `--solutionUniqueName`, or adopt it afterwards through the existing solution workflow. |

Source: [limitations and troubleshooting virtual tables](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/limits-tshoot-virtual-tables).

#### Share each verified table through Power Pages

Delegate frontend integration to `/power-pages:integrate-webapi` with the exact tables and operations, exactly as for a native Dataverse table.
Use `/_api/<EntitySetName>` from the create script's output, not the logical name with an assumed plural.
Configure `Webapi/<logical-table-name>/enabled` and an explicit `Webapi/<logical-table-name>/fields` list built from the verified generated columns.
The wildcard fields value `*` is deprecated; do not use it.
Use the shared Power Pages API client for session and anti-forgery handling, explicit projections, paging, and surfaced errors.
Do not put maker, Graph, or SharePoint credentials in React.

Table permissions, relationships, and web roles enforce row access on the server.
A React filter or an OData filter is not an authorization boundary.
Assign permissions only to the approved authenticated web roles; never grant source data to an anonymous role.

Two properties of virtual tables decide the access design, so settle them before granting anything:

- **The connection identity reads the whole list.** SharePoint item-level permissions do not travel with the data. Whatever the connection owner can see, the table can return.
- **Row scoping needs a relationship the source has to provide.** Contact, Account, and Parent scope all resolve through a lookup column on the table, and a SharePoint list rarely carries Dataverse record ids. When no verified relationship exists, Global scope is the honest description of what the permission grants, and the sharing decision is which **audience** gets the whole list, not which rows they get.

If one list mixes audiences and no server-enforced relationship can be established, split the source, restrict the shared columns, or leave that list excluded.
Never grant Global read and rely on the UI to hide the rest.

#### Publish the sharing map

After each table's permissions and site settings exist, regenerate the **sharing** record:

```bash
node "${PLUGIN_ROOT}/scripts/build-sharing-map.js" --projectRoot "<PROJECT_ROOT>"
```

It joins `.sharepoint-sharing.json` with the site's committed `.powerpages-site` web roles, table permissions, and site settings, then writes `docs/sharepoint-sharing-map.html`.
Because it is derived from the shipped configuration, it reports the access that is actually enforced rather than the access that was planned.
Treat a `danger` finding as a release blocker and a `warning` as a decision the maker has to confirm.
Add `--data-only` to inspect the model without writing the page.
Run it again after any permission, role, field, or table change, and read the result before claiming the integration is complete.

**Provisioning complete when:** Every selected list has a verified virtual table whose generated columns were read back from Dataverse, and any unverified list is recorded as blocked rather than integrated.
**Integration complete when:** Each verified table is reached through the configured Power Pages Web API, the approved audience passes both allowed and denied access tests, and the sharing map reports no outstanding `danger` finding.

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
These are document-management constraints, not virtual-table limits.

Sources: [Power Pages SharePoint document management](https://learn.microsoft.com/en-us/power-pages/configure/manage-sharepoint-documents), [server-based SharePoint integration](https://learn.microsoft.com/en-us/power-platform/admin/set-up-dynamics-365-online-to-use-sharepoint-online), [enable document management for tables](https://learn.microsoft.com/en-us/power-platform/admin/enable-sharepoint-document-management-specific-entities), [document-location table](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/sharepointdocumentlocation), and [Power Pages table permissions](https://learn.microsoft.com/en-us/power-pages/security/table-permissions).

**Document integration complete when:** Parent/location associations, permissions, and each approved operation have runtime evidence, including denied identities and out-of-scope IDs/folders.
Record an observed pilot transport as experimental; only an established supported contract qualifies it for production release.
