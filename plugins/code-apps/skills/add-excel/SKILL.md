---
name: add-excel
description: Adds Excel Online (Business) connector to a Power Apps code app. Use when reading or writing Excel workbook data from OneDrive or SharePoint.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add Excel Online

## Workflow

1. Check Memory Bank → 2. Gather → 3. Add Connector → 4. Configure → 5. Build → 6. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Gather

Ask the user:

1. Where is the workbook? (OneDrive or SharePoint)
2. Workbook file name
3. Which table(s) in the workbook to access

### Step 3: Add Connector

**First, find the connection ID** (see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md)):

Run the `/list-connections` skill. Find the Excel Online (Business) connection in the output. If none exists, direct the user to create one using the environment-specific Connections URL — construct it from the active environment ID in context (from `power.config.json` or a prior step): `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** → search for the connector → Create.

Excel Online is a tabular datasource -- requires `-c` (connection ID), `-d` (drive), and `-t` (table name in workbook):

```bash
# OneDrive workbook
pwsh -NoProfile -Command "pac code add-data-source -a excelonlinebusiness -c <connection-id> -d 'me' -t 'Table1'"

# SharePoint workbook -- dataset is the document library path
pwsh -NoProfile -Command "pac code add-data-source -a excelonlinebusiness -c <connection-id> -d 'sites/your-site' -t 'Table1'"
```

Run for each table the user needs.

### Step 4: Configure

**AddRowIntoTable** -- adds a row to an Excel table:

```typescript
// OneDrive workbook
await ExcelOnlineBusinessService.AddRowIntoTable({
  source: "me",
  drive: "me",
  file: "MyWorkbook.xlsx",
  table: "Table1",
  body: { column1: "value1", column2: "value2" } // Flat object, NO "items" wrapper
});

// SharePoint workbook
await ExcelOnlineBusinessService.AddRowIntoTable({
  source: "sites/your-site",
  drive: "drive-id",
  file: "SharedWorkbook.xlsx",
  table: "Table1",
  body: { column1: "value1", column2: "value2" }
});
```

**Key points:**

- `source: "me"` and `drive: "me"` for OneDrive personal files
- For SharePoint, use the site path and drive ID
- The `body` is a flat key-value object matching column headers -- do NOT wrap in `{ items: ... }`

Use `Grep` to find specific methods in `src/generated/services/ExcelOnlineBusinessService.ts` (generated files can be very large -- see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)).

### Step 5: Build

```powershell
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 6: Update Memory Bank

Update `memory-bank.md` with: connector added, workbook/table configured, build status.
