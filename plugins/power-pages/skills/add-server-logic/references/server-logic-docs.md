# Server Logic Documentation Discovery

Power Pages Server Logic is a preview feature with documentation that may expand or change at any time. **Never rely on a hardcoded list of URLs.** Always search Microsoft Learn dynamically to discover all available pages.

## Discovery Strategy

### Step 1: Search to discover pages

```
mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search("Power Pages Server Logic")
```

### Step 2: Collect unique page URLs

From all search results, extract unique `contentUrl` values. Keep pages that match:
- `learn.microsoft.com/.../power-pages/configure/server-logic*`
- `learn.microsoft.com/.../power-pages/configure/server-objects*`
- `learn.microsoft.com/.../power-pages/configure/author-server-logic*`

Discard: release-plan announcements, blog posts, unrelated configuration pages.

### Step 3: Classify and fetch

Classify each discovered page into one of these categories:

| Category | Always fetch? | How to identify |
|----------|:------------:|----------------|
| **Core reference** | Yes | Overview page, authoring guide, SDK/server objects reference |
| **How-to guide** | If relevant | Tutorials for specific scenarios (Dataverse, external APIs, Azure Functions, Graph, etc.) |
| **New/unknown** | If relevant | Any page not matching known patterns — read it to learn about new capabilities |

### Step 4: Fetch in parallel

Fetch all core reference pages plus relevant how-to guides in parallel using `mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch`.

## Known Pages (as of March 2026)

These are pages that existed when this reference was last updated. They serve as a baseline — the search step above will discover these plus any new ones:

| Page | URL |
|------|-----|
| Overview | `https://learn.microsoft.com/en-us/power-pages/configure/server-logic-overview` |
| Author server logic | `https://learn.microsoft.com/en-us/power-pages/configure/author-server-logic` |
| Server objects (SDK) | `https://learn.microsoft.com/en-us/power-pages/configure/server-objects` |
| Dataverse operations | `https://learn.microsoft.com/en-us/power-pages/configure/server-logic-operations` |
| External services | `https://learn.microsoft.com/en-us/power-pages/configure/server-logic-external-services` |
| Azure Function | `https://learn.microsoft.com/en-us/power-pages/configure/server-logic-azure-function` |
| Graph & SharePoint | `https://learn.microsoft.com/en-us/power-pages/configure/server-logic-graph-sharepoint` |

If the search discovers pages not in this table, those are new additions — fetch and use them.

## What to Extract from the Docs

For the current task, capture:

- All SDK method signatures, parameter types, and return types
- Supported HTTP methods and function signatures
- Site settings and their defaults
- Security model details (web roles, table permissions, CSRF)
- Client-side calling patterns and response formats
- Any new methods, changed behaviors, or breaking changes

## Use-Case Mapping

When the user's requirements are known, fetch any additional pages that match the scenario:

| User needs | Look for pages about |
|-----------|---------------------|
| Dataverse CRUD | Dataverse operations, table interactions |
| External API calls | External services, HttpClient |
| Azure Functions | Azure Function HTTP trigger |
| Microsoft Graph / SharePoint | Graph API, SharePoint integration |
| Any other scenario | Any matching tutorial or how-to page |

If the search results contain unfamiliar but relevant pages, read them — they may document new capabilities.

## Code Samples

Also search for current samples:

```
mcp__plugin_power-pages_microsoft-learn__microsoft_code_sample_search("Power Pages server logic")
```

## Known SDK Baseline

Use this as a baseline only. If Microsoft Learn differs, Microsoft Learn wins.

- **Server.Logger**: `Log(message)`, `Warn(message)`, `Error(message)`
- **Server.Context**: `QueryParameters["key"]`, `Headers["key"]`, `Body`, `HttpMethod`, `Url`, `ActivityId`, `FunctionName`, `ServerLogicName`
- **Server.Connector.HttpClient**: `GetAsync(url, headers?)`, `PostAsync(url, jsonBody, headers?, contentType?)`, `PatchAsync(url, jsonBody, headers?, contentType?)`, `PutAsync(url, jsonBody, headers?, contentType?)`, `DeleteAsync(url, headers?)`
- **Server.Connector.Dataverse**: `CreateRecord(entitySetName, payload)`, `RetrieveRecord(entitySetName, id, options)`, `RetrieveMultipleRecords(entitySetName, options)`, `UpdateRecord(entitySetName, id, payload)`, `DeleteRecord(entitySetName, id)`, `InvokeCustomApi(httpMethod, url, payload)`
- **Server.User**: `fullname`, `firstname`, `lastname`, `emailaddress1`, `contactid`, `Roles`, `Token`, and many other contact properties
- **Server.Website**: `adx_websiteid`, `adx_name`, `adx_primarydomainname`, `adx_defaultlanguage`, etc.
- **Server.Sitesetting**: `Get(name)`
- **Server.EnvironmentVariable**: `get(name)` — reads Dataverse environment variable values directly (alternative to reading via site settings with `envvar_schema`)

When new SDK members or changed patterns are discovered, use them and record the differences in the implementation plan.
