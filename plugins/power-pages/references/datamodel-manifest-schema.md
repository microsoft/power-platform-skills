# Data Model Manifest Schema

Shared reference for the `.datamodel-manifest.json` file format. This manifest is written by the `setup-datamodel` skill and read by `add-sample-data` and the `validate-datamodel.js` hook.

---

## Location

`<PROJECT_ROOT>/.datamodel-manifest.json`

## Schema

```json
{
  "environmentUrl": "https://org12345.crm.dynamics.com",
  "tables": [
    {
      "logicalName": "cr123_project",
      "displayName": "Project",
      "status": "new",
      "columns": [
        { "logicalName": "cr123_name", "type": "String" },
        { "logicalName": "cr123_description", "type": "Memo" },
        { "logicalName": "cr123_startdate", "type": "DateTime" },
        { "logicalName": "cr123_budget", "type": "Money" },
        { "logicalName": "cr123_isactive", "type": "Boolean" },
        { "logicalName": "cr123_status", "type": "Picklist" }
      ]
    }
  ]
}
```

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `environmentUrl` | string | The Dataverse environment URL |
| `tables` | array | List of tables in the data model |
| `tables[].logicalName` | string | Dataverse logical name (e.g., `cr123_project`) |
| `tables[].displayName` | string | Human-readable display name |
| `tables[].status` | string | `new`, `modified`, or `reused` |
| `tables[].columns` | array | List of columns on the table |
| `tables[].columns[].logicalName` | string | Column logical name |
| `tables[].columns[].type` | string | Column type: `String`, `Memo`, `Integer`, `Decimal`, `Money`, `DateTime`, `Boolean`, `Picklist`, `Lookup` |

## Usage

- **Written by**: `setup-datamodel` skill (Step 8.3) — only includes tables and columns confirmed to exist
- **Read by**: `add-sample-data` skill (Step 2, Path A) — preferred source for table discovery
- **Validated by**: `validate-datamodel.js` hook — queries OData API to verify each table/column exists
