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
