# Genpage Plan

## User Requirements

Build a page listing documents from our SharePoint team site.

## Working Directory

sharepoint-team-docs/

## Plugin Root

D:\Projects\power-platform-skills\plugins\model-apps

## Environment

- Active Profile: maker@contoso.onmicrosoft.com
- Environment URL: https://contoso-dev.crm10.dynamics.com/
- App: Operations Hub (aa112233-1122-1122-1122-aabbccdd1234)
- Solution: Default
- Publisher Prefix: new

## Pages

| Page | File | Purpose | Entities |
|------|------|---------|----------|
| SharePoint Documents | sharepoint-docs.tsx | Lists documents from SharePoint team site via connector binding | (connector: new_uxtest_sharepoint) |

## Entity Creation Required

No entity creation required — all entities already exist.

## Existing Entities

(none — connector-only page)

## Connector Bindings

| Logical Name | Connector Id | Dataset | Tables (GUIDs) | Table Display Names | Operations | Fields | Parameters | Response |
|--------------|--------------|---------|----------------|---------------------|------------|--------|------------|----------|
| new_uxtest_sharepoint | /providers/Microsoft.PowerApps/apis/shared_sharepointonline | https://contoso.sharepoint.com/sites/team | 5709dd6f-c73e-4079-ad23-2334e45e0e13 | Documents | | ID (number), Title (string), Author (string), FileType ({Value:string}), Created (string), Modified (string) | | |

## Design Preferences

- Clean card list layout for document browsing
- Document icon, title, author, file type badge, and modified date per row
- Search input to filter by title
- Responsive flex layout (no 100vh / 100vw)
- Graceful loading spinner and error/fallback state
- Icons: DocumentRegular, OpenRegular (unsized, from verified-icons.txt)

## Relevant Samples

| Page | Sample | Reason |
|------|--------|--------|
| SharePoint Documents | 7-responsive-cards.tsx | Card list layout for displaying items with metadata |

## Per-Page Specifications

### SharePoint Documents

- **File:** sharepoint-docs.tsx
- **Connector:** new_uxtest_sharepoint (SharePoint Online)
- **Dataset:** https://contoso.sharepoint.com/sites/team
- **Table GUID:** 5709dd6f-c73e-4079-ad23-2334e45e0e13 (Documents list)
- **Fields (all OPTIONAL):** ID (number), Title (string), Author (string), FileType ({Value:string}), Created (string), Modified (string)
- **Components:**
  - Search input for client-side title filtering
  - Card list of documents with DocumentRegular icon, title, author, file-type badge, modified date
  - OpenRegular icon as visual affordance on each card
  - Spinner while loading; MessageBar on error; empty-state text when no matches
- **Connector pattern:** cast dataApi to optional queryConnectorTable shape, presence-check, wrap in try/catch, fall back to FALLBACK_DOCS inline array on error or when method unavailable
- **Styling:** makeStyles with tokens; no inline styles for static values; no 100vh/100vw
