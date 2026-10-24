# SharePoint Reference

Critical patterns for working with SharePoint lists in Power Apps code apps. **Read this before writing any SharePoint code.**

## Column Name Encoding - CRITICAL

SharePoint internal column names encode special characters. The generated TypeScript services use these **internal names**, not display names.

| Display Name | Internal Name                      | Rule                                    |
| ------------ | ---------------------------------- | --------------------------------------- |
| `My Column`  | `My_x0020_Column`                  | Spaces become `_x0020_`                 |
| `Cost ($)`   | `Cost_x0020__x0028__x0024__x0029_` | Special chars each get `_xHHHH_`        |
| `% Complete` | `_x0025__x0020_Complete`           | Leading special char                    |
| `Title`      | `Title`                            | No encoding needed                      |
| `Created By` | `Author`                           | System column (different name entirely) |

Common encodings:
- Space: `_x0020_`
- `(`: `_x0028_`
- `)`: `_x0029_`
- `/`: `_x002f_`
- `&`: `_x0026_`
- `#`: `_x0023_`
- `%`: `_x0025_`

**Best practice:** Use simple column names without spaces or special characters (e.g., `ProjectStatus` instead of `Project Status`) to avoid encoding issues.

## Choice Columns - Key Difference from Dataverse

SharePoint choice fields store **string values**, not integer picklist codes. This is fundamentally different from Dataverse.

```typescript
// CORRECT - SharePoint choices are string values
const item = {
  Title: "My Item",
  Status: "Active",           // String value, not a number
  Priority: "High",           // String value, not a number
  Category: "Engineering"     // String value, not a number
};

// CORRECT - Filter by string value
const activeItems = items.filter(i => i.Status === "Active");

// CORRECT - Use in select dropdown
<select value={formData.Status}>
  <option value="Active">Active</option>
  <option value="Inactive">Inactive</option>
  <option value="Pending">Pending</option>
</select>

// WRONG - Don't use numeric values like Dataverse
{ Status: 0 }      // SharePoint expects "Active", not 0
{ Priority: 1 }    // SharePoint expects "High", not 1
```

**Multi-select choice columns** return a semicolon-delimited string from the connector:

```typescript
// Multi-select choice value
const categories = item.Categories;  // "Engineering;Design;Marketing"
const categoryArray = categories?.split(";") || [];
```

## Lookup Columns - How They Appear

Lookup columns in SharePoint reference items from another list. In the generated services, they appear as objects with `Id` and `Value`:

```typescript
// Reading a lookup column with the connector action GetItem(dataset, table, id):
// dataset is the site URL, and SharePoint item IDs are integers
const result = await SharePointService.GetItem(dataset, "Tasks", itemId);
// result.data.AssignedTo = { Id: 5, Value: "John Smith" }
// result.data.Project = { Id: 12, Value: "Website Redesign" }

// Creating/updating with a lookup -- use the ID
await SharePointService.PatchItem(dataset, "Tasks", itemId, {
  AssignedToId: 5,         // Use the Id suffix
  ProjectId: 12            // Use the Id suffix
});
```

**Person/Group columns** are special lookup columns that reference the site's User Information List:

```typescript
// Person column appears as lookup with user info
// item.AssignedTo = { Id: 15, Value: "<person-display-name>" }
// To set: use AssignedToId with the user's site user ID
```

## Common SharePoint API Errors

| Error                                             | Cause                                        | Fix                                                                                                |
| ------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `"Column 'X' does not exist"`                     | Using display name instead of internal name  | Check generated model for actual property name; may need `_x0020_` encoding                        |
| `"The list 'X' does not exist"`                   | List name doesn't match exactly              | Verify list display name via `pa connection list-tables`; names are case-sensitive |
| `"Value does not fall within the expected range"` | Invalid choice value or column type mismatch | Verify the exact choice option strings; SharePoint choices are case-sensitive                      |
| `"Item does not exist"`                           | Using wrong ID format or deleted item        | SharePoint list item IDs are sequential integers, not GUIDs                                        |
| `"Access denied"`                                 | Insufficient SharePoint permissions          | User needs at least Edit permission on the list                                                    |
| `"Throttled"` / 429 status                        | Too many API requests                        | SharePoint throttles at ~600 requests/min; add retry logic                                         |

## Column Type Quick Reference

| Need             | SharePoint Type        | API Property          | Notes                               |
| ---------------- | ---------------------- | --------------------- | ----------------------------------- |
| Short text       | Single line of text    | `text`                | Max 255 chars                       |
| Long text        | Multiple lines of text | `text` (multiline)    | Rich text or plain text             |
| Number           | Number                 | `number`              | Decimals configurable               |
| Currency         | Currency               | `currency`            | Number with currency format         |
| Yes/No           | Yes/No                 | `boolean`             | Boolean                             |
| Date + time      | Date and Time          | `dateTime`            | UTC stored, local displayed         |
| Date only        | Date and Time          | `dateTime` (dateOnly) | Date without time                   |
| Single select    | Choice                 | `choice`              | String values (not integers)        |
| Multi select     | Choice (multi)         | `choice` (multi)      | Semicolon-delimited strings         |
| Related item     | Lookup                 | `lookup`              | References another list             |
| Person           | Person or Group        | `personOrGroup`       | Special lookup to User Info List    |
| Hyperlink        | Hyperlink or Picture   | `text` (URL format)   | Stored as `url, description`        |
| Calculated       | Calculated             | Read-only             | Server-computed, cannot set via API |
| Managed Metadata | Managed Metadata       | `term`                | Requires term store setup           |

## Generated Service Patterns

What `pa app add data-source` generates depends on how SharePoint was added (CLI 1.3.0):

**Lists added as tables** (`--table '<list>'`): one service per list, named after it, with typed `<List>Read` / `<List>Write` models:

```typescript
import { ProjectMilestonesService } from "../generated/services/ProjectMilestonesService";

const result = await ProjectMilestonesService.getAll({ top: 50 });
const items = result.data ?? [];
const one = await ProjectMilestonesService.get(id);
const created = await ProjectMilestonesService.create({ Title: "New Item" });
await ProjectMilestonesService.update(id, { Title: "Updated" });
await ProjectMilestonesService.delete(id);
```

**Connector actions** (`--as action`): `SharePointService`, whose methods take positional parameters. The `dataset` (site URL) and `table` (list name) arguments select the list:

```typescript
import { SharePointService } from "../generated/services/SharePointService";

const dataset = "https://contoso.sharepoint.com/sites/mysite";   // the site URL
const list = await SharePointService.GetItems(dataset, "My List");   // optional: $filter, $orderby, $top, ...
const item = await SharePointService.GetItem(dataset, "My List", 42);  // SharePoint item IDs are integers
const newItem = await SharePointService.PostItem(dataset, "My List", { Title: "New Item", Status: "Active" });
await SharePointService.PatchItem(dataset, "My List", 42, { Status: "Completed" });
await SharePointService.DeleteItem(dataset, "My List", 42);
```

These examples were verified against CLI 1.3.0. Use `Grep` on `src/generated/services/` to confirm service names and exact signatures, especially in projects created with an older CLI (generated files can be very large -- see [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)).
