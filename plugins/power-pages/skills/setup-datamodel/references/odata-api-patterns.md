# OData API Patterns for Dataverse Table Creation

Reference document for the `setup-datamodel` skill. Contains full JSON body templates for creating tables, columns, and relationships via the Dataverse OData Web API (v9.2).

> **Authentication, error handling, and retry patterns** are in the shared reference: `${CLAUDE_PLUGIN_ROOT}/references/odata-common.md`. Read that file first for headers, token refresh, HTTP status codes, and retry logic.

---

## Create Table with Columns (Deep Insert)

Create a table and its columns in a single POST using deep insert. This is the preferred approach — it avoids multiple round-trips.

**Endpoint:** `POST {envUrl}/api/data/v9.2/EntityDefinitions`

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
  "SchemaName": "<Prefix>_<TableName>",
  "DisplayName": {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    "LocalizedLabels": [
      {
        "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
        "Label": "<Display Name>",
        "LanguageCode": 1033
      }
    ]
  },
  "DisplayCollectionName": {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    "LocalizedLabels": [
      {
        "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
        "Label": "<Display Name Plural>",
        "LanguageCode": 1033
      }
    ]
  },
  "Description": {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    "LocalizedLabels": [
      {
        "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
        "Label": "<Description>",
        "LanguageCode": 1033
      }
    ]
  },
  "HasActivities": false,
  "HasNotes": false,
  "OwnershipType": "UserOwned",
  "IsActivity": false,
  "Attributes": [
    {
      "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
      "SchemaName": "<Prefix>_Name",
      "DisplayName": {
        "@odata.type": "Microsoft.Dynamics.CRM.Label",
        "LocalizedLabels": [
          {
            "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
            "Label": "Name",
            "LanguageCode": 1033
          }
        ]
      },
      "IsPrimaryName": true,
      "RequiredLevel": { "Value": "ApplicationRequired" },
      "MaxLength": 200,
      "FormatName": { "Value": "Text" }
    }
  ]
}
```

**Important notes:**
- `SchemaName` uses PascalCase with prefix: `Cr123_ProjectName`
- `LogicalName` is auto-generated as lowercase: `cr123_projectname`
- Every table must have exactly one column with `"IsPrimaryName": true`
- `OwnershipType` can be `"UserOwned"` (supports security roles) or `"OrganizationOwned"` (shared across org)

---

## Column Type Mapping

Each Dataverse column type requires a specific `@odata.type` and set of properties. Below is the mapping from the data-model-architect's type names to OData metadata types.

### SingleLine.Text (String)

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
  "SchemaName": "<Prefix>_<ColumnName>",
  "DisplayName": {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Display Name>", "LanguageCode": 1033 }]
  },
  "RequiredLevel": { "Value": "None" },
  "MaxLength": 200,
  "FormatName": { "Value": "Text" }
}
```

`FormatName` values: `Text`, `Email`, `Url`, `Phone`, `TextArea`

### MultiLine.Text (Memo)

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.MemoAttributeMetadata",
  "SchemaName": "<Prefix>_<ColumnName>",
  "DisplayName": {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Display Name>", "LanguageCode": 1033 }]
  },
  "RequiredLevel": { "Value": "None" },
  "MaxLength": 10000,
  "Format": "TextArea"
}
```

### WholeNumber (Integer)

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
  "SchemaName": "<Prefix>_<ColumnName>",
  "DisplayName": {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Display Name>", "LanguageCode": 1033 }]
  },
  "RequiredLevel": { "Value": "None" },
  "MinValue": -2147483648,
  "MaxValue": 2147483647,
  "Format": "None"
}
```

### Decimal

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
  "SchemaName": "<Prefix>_<ColumnName>",
  "DisplayName": {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Display Name>", "LanguageCode": 1033 }]
  },
  "RequiredLevel": { "Value": "None" },
  "MinValue": -100000000000,
  "MaxValue": 100000000000,
  "Precision": 2
}
```

### Currency (Money)

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.MoneyAttributeMetadata",
  "SchemaName": "<Prefix>_<ColumnName>",
  "DisplayName": {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Display Name>", "LanguageCode": 1033 }]
  },
  "RequiredLevel": { "Value": "None" },
  "MinValue": 0,
  "MaxValue": 1000000000,
  "Precision": 2,
  "PrecisionSource": 2
}
```

### DateTime

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
  "SchemaName": "<Prefix>_<ColumnName>",
  "DisplayName": {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Display Name>", "LanguageCode": 1033 }]
  },
  "RequiredLevel": { "Value": "None" },
  "Format": "DateAndTime",
  "DateTimeBehavior": { "Value": "UserLocal" }
}
```

`Format` values: `DateAndTime`, `DateOnly`

### Boolean

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
  "SchemaName": "<Prefix>_<ColumnName>",
  "DisplayName": {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Display Name>", "LanguageCode": 1033 }]
  },
  "RequiredLevel": { "Value": "None" },
  "DefaultValue": false,
  "OptionSet": {
    "TrueOption": {
      "Value": 1,
      "Label": {
        "@odata.type": "Microsoft.Dynamics.CRM.Label",
        "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "Yes", "LanguageCode": 1033 }]
      }
    },
    "FalseOption": {
      "Value": 0,
      "Label": {
        "@odata.type": "Microsoft.Dynamics.CRM.Label",
        "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "No", "LanguageCode": 1033 }]
      }
    }
  }
}
```

### Choice (OptionSet / Picklist)

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
  "SchemaName": "<Prefix>_<ColumnName>",
  "DisplayName": {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Display Name>", "LanguageCode": 1033 }]
  },
  "RequiredLevel": { "Value": "None" },
  "OptionSet": {
    "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
    "IsGlobal": false,
    "OptionSetType": "Picklist",
    "Options": [
      {
        "Value": 100000000,
        "Label": {
          "@odata.type": "Microsoft.Dynamics.CRM.Label",
          "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "Option 1", "LanguageCode": 1033 }]
        }
      },
      {
        "Value": 100000001,
        "Label": {
          "@odata.type": "Microsoft.Dynamics.CRM.Label",
          "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "Option 2", "LanguageCode": 1033 }]
        }
      }
    ]
  }
}
```

**Choice option values** start at `100000000` and increment by 1 for each option.

### Lookup

Lookups are NOT created as standalone columns. They are created as part of a relationship definition. See the Relationships section below.

---

## Add Column to Existing Table

**Endpoint:** `POST {envUrl}/api/data/v9.2/EntityDefinitions(LogicalName='<table>')/Attributes`

Use the same column JSON bodies as above. The column is added to the specified table.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> POST "api/data/v9.2/EntityDefinitions(LogicalName='cr123_project')/Attributes" --body '<column JSON>'
```

---

## Relationships

### One-to-Many (1:N) Relationship

Creates a lookup column on the "many" side that references the "one" side.

**Endpoint:** `POST {envUrl}/api/data/v9.2/RelationshipDefinitions`

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
  "SchemaName": "<prefix>_<ReferencedTable>_<ReferencingTable>",
  "ReferencedEntity": "<referenced_table_logical_name>",
  "ReferencingEntity": "<referencing_table_logical_name>",
  "CascadeConfiguration": {
    "Assign": "NoCascade",
    "Delete": "RemoveLink",
    "Merge": "NoCascade",
    "Reparent": "NoCascade",
    "Share": "NoCascade",
    "Unshare": "NoCascade",
    "RollupView": "NoCascade"
  },
  "Lookup": {
    "@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
    "SchemaName": "<Prefix>_<ReferencedTable>Id",
    "DisplayName": {
      "@odata.type": "Microsoft.Dynamics.CRM.Label",
      "LocalizedLabels": [
        {
          "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
          "Label": "<Referenced Table Display Name>",
          "LanguageCode": 1033
        }
      ]
    },
    "RequiredLevel": { "Value": "None" }
  }
}
```

**Example:** Contact (one) → Orders (many):
- `ReferencedEntity`: `contact`
- `ReferencingEntity`: `cr123_order`
- `Lookup.SchemaName`: `Cr123_ContactId`

### Many-to-Many (M:N) Relationship

**Endpoint:** `POST {envUrl}/api/data/v9.2/RelationshipDefinitions`

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata",
  "SchemaName": "<prefix>_<Table1>_<Table2>",
  "Entity1LogicalName": "<table1_logical_name>",
  "Entity2LogicalName": "<table2_logical_name>",
  "IntersectEntityName": "<prefix>_<table1>_<table2>",
  "Entity1AssociatedMenuConfiguration": {
    "Behavior": "UseLabel",
    "Group": "Details",
    "Label": {
      "@odata.type": "Microsoft.Dynamics.CRM.Label",
      "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Table2 Plural>", "LanguageCode": 1033 }]
    },
    "Order": 10000
  },
  "Entity2AssociatedMenuConfiguration": {
    "Behavior": "UseLabel",
    "Group": "Details",
    "Label": {
      "@odata.type": "Microsoft.Dynamics.CRM.Label",
      "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Table1 Plural>", "LanguageCode": 1033 }]
    },
    "Order": 10000
  }
}
```

---

## Publish Customizations

After creating tables, columns, and relationships, publish them so they become available in the environment.

**Endpoint:** `POST {envUrl}/api/data/v9.2/PublishXml`

### Publish Specific Tables

```json
{
  "ParameterXml": "<importexportxml><entities><entity>cr123_project</entity><entity>cr123_task</entity></entities></importexportxml>"
}
```

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> POST "api/data/v9.2/PublishXml" --body '{"ParameterXml":"<importexportxml><entities><entity>cr123_project</entity><entity>cr123_task</entity></entities></importexportxml>"}'
```

### Publish All Customizations (Fallback)

If publishing specific tables fails, publish everything:

```json
{
  "ParameterXml": "<importexportxml><entities><entity>all</entity></entities></importexportxml>"
}
```

---

## RequiredLevel Values

| Value | Meaning |
|-------|---------|
| `None` | Optional column |
| `ApplicationRequired` | Required by the application (shows asterisk in forms) |
| `SystemRequired` | Required by the system (cannot be changed) |

---

## Error Handling

See `${CLAUDE_PLUGIN_ROOT}/references/odata-common.md` for HTTP status codes, error response format, Dataverse error codes, and retry patterns.
