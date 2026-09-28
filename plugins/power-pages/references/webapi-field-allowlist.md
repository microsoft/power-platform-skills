# Web API field allowlist

Use this contract whenever an instruction creates, audits, or migrates a
`Webapi/<table>/fields` value.

Add the exact identifier used by each operation:

| Operation | Fields-setting identifier |
|-----------|---------------------------|
| Ordinary read, filter, order, aggregate, or scalar write | Dataverse attribute `LogicalName` |
| Lookup read or filter | `_<LogicalName>_value` |
| Lookup relationship set by POST/PATCH | The exact case-sensitive Navigation Property before `@odata.bind` |

For example, a lookup with `LogicalName = cr87b_categoryid` that is read as
`_cr87b_categoryid_value` and written as
`Cr87b_Category@odata.bind` contributes both identifiers:

```text
Cr87b_Category,_cr87b_categoryid_value
```

The Navigation Property can use schema-style casing, but it must come from the
request payload or Dataverse relationship metadata
(`ReferencingEntityNavigationPropertyName`). Do not substitute the attribute
`SchemaName` unless it is the actual property used before `@odata.bind`.

Build the final value as a sorted, comma-separated set with no wildcard. The
allowlist is complete only when every operation has its exact identifier.
