# Troubleshooting

## Existing Table Detection Issues

### Tables not found

- Ensure the filter `IsCustomEntity eq true` is correct for your needs
- Some tables may be managed or system tables that don't appear in custom entity queries

### Wrong publisher prefix

Tables may have different prefixes depending on the solution. **Always use `Initialize-DataverseApi` to fetch the correct prefix dynamically:**

```powershell
# Get the default publisher prefix
$api = Initialize-DataverseApi -EnvironmentUrl $envUrl
$publisherPrefix = $api.PublisherPrefix  # e.g., "cr", "contoso", "new"

# Search for tables with any custom prefix
$allCustomTables = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions?`$filter=IsCustomEntity eq true" -Headers $headers
$allCustomTables.value | ForEach-Object { Write-Host $_.SchemaName }
```

Common prefixes: `cr_`, `new_`, `contoso_`, `msft_` - but always fetch dynamically to ensure consistency.

### System tables included

Add additional filters to exclude system tables:

```powershell
$filter = "IsCustomEntity eq true and IsManaged eq false"
```

### Case sensitivity

Table logical names are case-insensitive but schema names preserve case. Always use lowercase for logical names in API calls.

## Table Reuse Issues

### Existing table has different schema

If the existing table's schema is too different:

- Consider creating a new table with a unique name (e.g., `${publisherPrefix}_site_category` instead of `${publisherPrefix}_category`)
- Or extend the existing table and use only the columns you need

### Column type mismatch

Cannot change column types after creation. Options:

- Create a new column with a different name
- Use the existing column type if compatible
- Create an entirely new table

### Relationship conflicts

Verify existing relationships don't prevent your intended lookups:

```powershell
Get-TableRelationships -TableLogicalName "${publisherPrefix}_product"
```

### Missing required columns on reused table

Use `Add-DataverseColumnIfNotExists` to add only missing columns without errors.

## Dataverse Web API Errors

### Authentication errors

```text
Error: 401 Unauthorized
```

**Solutions:**

1. Verify Azure CLI is logged in: `az login`
2. Check access token is valid: `az account get-access-token --resource <env-url>`
3. Token may have expired (tokens last ~1 hour), get a fresh one
4. Ensure you're using the correct environment URL

### Permission errors

```text
Error: 403 Forbidden
```

**Solutions:**

Ensure you have appropriate Dataverse permissions:

- **System Administrator** - Full access
- **System Customizer** - Can create and modify tables

### Rate limiting

```text
Error: 429 Too Many Requests
```

**Solutions:**

- Add delays between API calls
- Batch operations where possible
- Retry with exponential backoff

```powershell
function Invoke-WithRetry {
    param(
        [scriptblock]$ScriptBlock,
        [int]$MaxRetries = 3
    )

    $retryCount = 0
    while ($retryCount -lt $MaxRetries) {
        try {
            return & $ScriptBlock
        } catch {
            if ($_.Exception.Response.StatusCode -eq 429) {
                $retryCount++
                $waitTime = [math]::Pow(2, $retryCount)
                Write-Host "Rate limited. Waiting $waitTime seconds..." -ForegroundColor Yellow
                Start-Sleep -Seconds $waitTime
            } else {
                throw
            }
        }
    }
    throw "Max retries exceeded"
}
```

## Table Creation Fails

### Invalid schema name

```text
Error: "The schema name is invalid"
```

**Solutions:**

- Verify schema name uses the correct publisher prefix from `Initialize-DataverseApi` (e.g., `${publisherPrefix}_tablename`)
- Schema names must start with a letter
- Only alphanumeric characters and underscores allowed
- Maximum 128 characters

### Table already exists

```text
Error: "Entity with this name already exists"
```

**Solutions:**

- Use `Test-TableExists` before creating
- Use `New-DataverseTableIfNotExists` helper function
- Choose a unique schema name

### Missing required metadata

```text
Error: "Required field missing"
```

**Solutions:**

Ensure all required metadata fields are included:

- `SchemaName`
- `DisplayName` with `LocalizedLabels`
- `DisplayCollectionName` (plural name)
- `PrimaryNameAttribute`

## Relationship/Lookup Creation Fails

### Referenced entity not found

```text
Error: "Referenced entity '{prefix}_category' not found"
```

**Solutions:**

- Ensure the target table exists BEFORE creating the lookup
- Check creation order: TIER 0 tables must exist before TIER 1, etc.
- Verify the table logical name is correct (case-insensitive)
- Ensure you're using the correct publisher prefix from `Initialize-DataverseApi`

### Duplicate relationship name

```text
Error: "Relationship with this name already exists"
```

**Solutions:**

- Relationship names must be unique across the environment
- Use a consistent naming pattern: `{publisher}_{targettable}_{sourcetable}`
- Use `Test-RelationshipExists` before creating

### Invalid target entity

```text
Error: "Invalid target entity for relationship"
```

**Solutions:**

- The target table must have a primary key attribute
- Ensure the table is not a virtual entity or external data source

### Self-referential lookup fails

**Solution:** Create the table first, then add the self-lookup as a separate step:

```powershell
# Step 1: Create table
New-DataverseTable -SchemaName "${publisherPrefix}_employee" ...

# Step 2: Add self-referential lookup (table now exists)
Add-DataverseLookup -SourceTable "${publisherPrefix}_employee" -TargetTable "${publisherPrefix}_employee" ...
```

## Sample Data Insertion Fails

### Foreign key violation

```text
Error: "The specified lookup reference does not exist"
```

**Solutions:**

- Insert TIER 0 data first, then TIER 1, then TIER 2
- Verify the lookup ID is correct (GUIDs are case-insensitive)
- If reusing existing lookup tables, query for existing record IDs first

### Invalid @odata.bind syntax

```text
Error: "Invalid @odata.bind value"
```

**Solutions:**

Format must be exactly: `/entitysetname(guid)`

```powershell
# Correct (using $publisherPrefix variable)
"${publisherPrefix}_categoryid@odata.bind" = "/${publisherPrefix}_categories(12345678-1234-1234-1234-123456789012)"

# Wrong - missing leading slash
"${publisherPrefix}_categoryid@odata.bind" = "${publisherPrefix}_categories(12345678-1234-1234-1234-123456789012)"

# Wrong - using logical name instead of entity set name
"${publisherPrefix}_categoryid@odata.bind" = "/${publisherPrefix}_category(12345678-1234-1234-1234-123456789012)"
```

### Entity set not found

```text
Error: "Resource not found for segment '{prefix}_product'"
```

**Solutions:**

Use the plural entity set name, not the logical name:

- Table `{prefix}_product` has entity set `{prefix}_products` (usually adds 's')
- Table `{prefix}_category` has entity set `{prefix}_categories` (adds 'ies')

Find the correct entity set name:

```powershell
$tableName = "${publisherPrefix}_product"
$table = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$tableName')?`$select=EntitySetName" -Headers $headers
Write-Host "Entity set name: $($table.EntitySetName)"
```

### Duplicate record errors

If using `New-DataverseRecordIfNotExists`, records with the same name are skipped. If inserts still fail:

- Check for unique constraints on other columns
- Verify the name column matches your expectation

## Existing Data Conflicts

### Stale record IDs

If reusing tables, always query for current record IDs; don't use cached values:

```powershell
# Always get fresh IDs before inserting dependent records
$categories = Invoke-RestMethod -Uri "$baseUrl/${publisherPrefix}_categories?`$select=${publisherPrefix}_categoryid,${publisherPrefix}_name" -Headers $headers
$categoryIds = @{}
$categories.value | ForEach-Object { $categoryIds[$_."${publisherPrefix}_name"] = $_."${publisherPrefix}_categoryid" }
```

### Data format differences

Existing records may have different formats:

- Dates: Use ISO 8601 format `yyyy-MM-ddTHH:mm:ssZ`
- Currency: Ensure correct decimal precision
- Text: Check MaxLength constraints

### Orphaned lookups

When reusing tables, verify that lookup values still exist:

```powershell
# Check for orphaned references
$products = Invoke-RestMethod -Uri "$baseUrl/${publisherPrefix}_products?`$select=${publisherPrefix}_name&`$expand=${publisherPrefix}_categoryid(`$select=${publisherPrefix}_name)" -Headers $headers
$products.value | Where-Object { $_."${publisherPrefix}_categoryid" -eq $null } | ForEach-Object {
    Write-Host "Orphaned product (no category): $($_."${publisherPrefix}_name")" -ForegroundColor Yellow
}
```

## Verifying Relationships

```powershell
# Check if a relationship exists
$relationshipName = "${publisherPrefix}_category_product"
$relations = Invoke-RestMethod -Uri "$baseUrl/RelationshipDefinitions?`$filter=SchemaName eq '$relationshipName'" -Headers $headers
if ($relations.value.Count -gt 0) {
    Write-Host "Relationship exists"
} else {
    Write-Host "Relationship not found"
}

# List all relationships for a table
$tableName = "${publisherPrefix}_product"
$tableRelations = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$tableName')/OneToManyRelationships" -Headers $headers
$tableRelations.value | ForEach-Object { Write-Host $_.SchemaName }
```

## Reference Documentation

- [Dataverse Web API](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview)
- [Dataverse Entity Metadata](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api)
- [OData Query Options](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-data-web-api)
