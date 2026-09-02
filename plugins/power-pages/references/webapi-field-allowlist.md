# Web API field allowlist

Use this contract whenever an instruction creates, audits, or migrates a
`Webapi/<table>/fields` value.

For every required Dataverse attribute, query metadata for both `LogicalName`
and `SchemaName`, then add both values exactly as returned. If the two values
are identical, keep one entry after deduplication.

Lookup, Customer, and Owner attributes require a third entry for reads:
`_<LogicalName>_value`. For example, metadata with
`LogicalName = cr87b_productcategoryid` and
`SchemaName = Cr87b_ProductCategoryId` produces:

```text
Cr87b_ProductCategoryId,_cr87b_productcategoryid_value,cr87b_productcategoryid
```

Build the final fields value as a sorted, comma-separated set with no wildcard.
Adding both metadata names to the fields setting does not change request
syntax: `$select`, `$filter`, request bodies, and `@odata.bind` must still use
the API property name required by that operation.

The allowlist is complete only when every required non-lookup attribute has its
LogicalName and SchemaName, and every required lookup has those two names plus
its `_<LogicalName>_value` read property.
