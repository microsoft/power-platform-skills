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
// Reading a lookup column
const item = await SharePointOnlineService.GetItem({
  dataset: siteUrl,
  table: "Tasks",
  id: itemId
});
// item.AssignedTo = { Id: 5, Value: "John Smith" }
// item.Project = { Id: 12, Value: "Website Redesign" }

// Creating/updating with a lookup -- use the ID
await SharePointOnlineService.PatchItem({
  dataset: siteUrl,
  table: "Tasks",
  id: itemId,
  item: {
    AssignedToId: 5,         // Use the Id suffix
    ProjectId: 12            // Use the Id suffix
  }
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
| `"The list 'X' does not exist"`                   | List name doesn't match exactly              | Verify list display name via `pac code list-tables`; names are case-sensitive |
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

After running `pac code add-data-source -a sharepointonline`, the generated `SharePointOnlineService.ts` provides methods that work across all connected lists. The `dataset` (site URL) and `table` (list name) parameters select which list to operate on:

```typescript
import { SharePointOnlineService } from "../generated/services/SharePointOnlineService";

// List all items
const result = await SharePointOnlineService.GetItems({
  dataset: "https://contoso.sharepoint.com/sites/mysite",
  table: "My List"
});
const items = result.value || [];

// Get single item by ID (SharePoint IDs are integers)
const item = await SharePointOnlineService.GetItem({
  dataset: siteUrl,
  table: "My List",
  id: 42
});

// Create item
const newItem = await SharePointOnlineService.PostItem({
  dataset: siteUrl,
  table: "My List",
  item: { Title: "New Item", Status: "Active" }
});

// Update item
await SharePointOnlineService.PatchItem({
  dataset: siteUrl,
  table: "My List",
  id: 42,
  item: { Status: "Completed" }
});

// Delete item
await SharePointOnlineService.DeleteItem({
  dataset: siteUrl,
  table: "My List",
  id: 42
});
```

Use `Grep` to find specific methods in `src/generated/services/SharePointOnlineService.ts` (generated files can be very large -- see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)).
