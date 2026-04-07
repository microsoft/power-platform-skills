# Table Management Reference

## Query Existing Custom Tables

Before creating tables, review what exists:

```powershell
$existingTables = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions?`$filter=IsCustomEntity eq true&`$select=SchemaName,LogicalName,DisplayName,Description,PrimaryNameAttribute" -Headers $headers

Write-Host "Found $($existingTables.value.Count) custom tables:" -ForegroundColor Cyan
$existingTables.value | ForEach-Object {
    $displayName = $_.DisplayName.UserLocalizedLabel.Label
    Write-Host "  - $($_.SchemaName) ($displayName)" -ForegroundColor Yellow
}
```

## Get Table Schema Details

```powershell
function Get-TableSchema {
    param([string]$TableLogicalName)

    $tableInfo = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableLogicalName')?`$expand=Attributes(`$select=SchemaName,LogicalName,AttributeType,DisplayName,MaxLength)" -Headers $headers

    Write-Host "`nTable: $($tableInfo.SchemaName)" -ForegroundColor Cyan
    Write-Host "Primary Column: $($tableInfo.PrimaryNameAttribute)"

    $tableInfo.Attributes | Where-Object {
        $_.SchemaName -notmatch '^(Created|Modified|Owner|State|Status|Version|Import|Overridden|TimeZone|UTCConversion|Traversed)'
    } | ForEach-Object {
        $displayName = if ($_.DisplayName.UserLocalizedLabel) { $_.DisplayName.UserLocalizedLabel.Label } else { $_.SchemaName }
        Write-Host "    - $($_.SchemaName) ($($_.AttributeType)) - $displayName"
    }

    return $tableInfo
}
```

## Find Similar Tables

Search for tables with similar purposes but different names:

```powershell
function Find-SimilarTables {
    param(
        [string]$Purpose,
        [array]$ExistingTables
    )

    $patterns = @{
        "category" = @("category", "categories", "type", "types", "classification")
        "product" = @("product", "products", "item", "items", "service", "services", "offering")
        "contact" = @("contact", "contacts", "submission", "inquiry", "lead", "leads")
        "team" = @("team", "employee", "staff", "member", "person", "people")
        "testimonial" = @("testimonial", "review", "feedback", "rating")
    }

    $searchTerms = $patterns[$Purpose]
    if (-not $searchTerms) { $searchTerms = @($Purpose) }

    $matches = $ExistingTables | Where-Object {
        $tableName = $_.SchemaName.ToLower()
        $displayName = $_.DisplayName.UserLocalizedLabel.Label.ToLower()

        foreach ($term in $searchTerms) {
            if ($tableName -match $term -or $displayName -match $term) {
                return $true
            }
        }
        return $false
    }

    return $matches
}
```

## Compare Existing vs Required Tables

```powershell
function Compare-TableSchemas {
    param(
        [hashtable]$RequiredTables,  # Purpose name -> array of required columns
        [array]$ExistingTables
    )

    $comparison = @{
        Reusable = @()
        Extendable = @()
        CreateNew = @()
    }

    foreach ($tablePurpose in $RequiredTables.Keys) {
        $existing = Find-SimilarTables -Purpose $tablePurpose -ExistingTables $ExistingTables | Select-Object -First 1

        if ($existing) {
            $tableSchema = Get-TableSchema -TableLogicalName $existing.LogicalName
            $existingColumns = $tableSchema.Attributes | Select-Object -ExpandProperty SchemaName
            $requiredColumns = $RequiredTables[$tablePurpose]
            $missingColumns = $requiredColumns | Where-Object { $_ -notin $existingColumns }

            if ($missingColumns.Count -eq 0) {
                $comparison.Reusable += @{
                    TablePurpose = $tablePurpose
                    ActualLogicalName = $existing.LogicalName
                    ActualSchemaName = $existing.SchemaName
                    Message = "All required columns present"
                }
            } else {
                $comparison.Extendable += @{
                    TablePurpose = $tablePurpose
                    ActualLogicalName = $existing.LogicalName
                    ActualSchemaName = $existing.SchemaName
                    MissingColumns = $missingColumns
                    Message = "Missing columns: $($missingColumns -join ', ')"
                }
            }
        } else {
            $comparison.CreateNew += @{
                TablePurpose = $tablePurpose
                NewSchemaName = "${publisherPrefix}_$tablePurpose"
                NewLogicalName = "${publisherPrefix}_$tablePurpose".ToLower()
                RequiredColumns = $RequiredTables[$tablePurpose]
            }
        }
    }

    return $comparison
}
```

## Get Entity Set Name

Dataverse entity set names don't follow simple pluralization rules (e.g., `account` -> `accounts`, `opportunity` -> `opportunities`). Always query the actual name from API metadata:

```powershell
function Get-EntitySetName {
    param(
        [string]$TableLogicalName,
        [string]$BaseUrl,
        [hashtable]$Headers
    )
    $entityDef = Invoke-RestMethod -Uri "$BaseUrl/EntityDefinitions(LogicalName='$TableLogicalName')?`$select=EntitySetName" -Headers $Headers
    return $entityDef.EntitySetName
}
```

## Build Table Name Mapping

After comparing tables and getting user decisions, build a mapping that tracks actual logical names. **Critical** for correctly referencing tables throughout the workflow.

```powershell
function Build-TableNameMapping {
    param(
        [object]$ComparisonResult,
        [string]$PublisherPrefix,
        [string]$BaseUrl,
        [hashtable]$Headers
    )

    $tableMapping = @{}

    foreach ($table in $ComparisonResult.Reusable) {
        $entitySetName = Get-EntitySetName -TableLogicalName $table.ActualLogicalName -BaseUrl $BaseUrl -Headers $Headers
        $tableMapping[$table.TablePurpose] = @{
            LogicalName = $table.ActualLogicalName
            SchemaName = $table.ActualSchemaName
            EntitySetName = $entitySetName
            Source = "Reused"
        }
    }

    foreach ($table in $ComparisonResult.Extendable) {
        $entitySetName = Get-EntitySetName -TableLogicalName $table.ActualLogicalName -BaseUrl $BaseUrl -Headers $Headers
        $tableMapping[$table.TablePurpose] = @{
            LogicalName = $table.ActualLogicalName
            SchemaName = $table.ActualSchemaName
            EntitySetName = $entitySetName
            Source = "Extended"
        }
    }

    foreach ($table in $ComparisonResult.CreateNew) {
        $logicalName = "${PublisherPrefix}_$($table.TablePurpose)".ToLower()
        $schemaName = "${PublisherPrefix}_$($table.TablePurpose)"
        # EntitySetName is auto-generated by Dataverse on table creation
        # Query it after creating the table in Step 4
        $tableMapping[$table.TablePurpose] = @{
            LogicalName = $logicalName
            SchemaName = $schemaName
            EntitySetName = $null
            Source = "Created"
        }
    }

    return $tableMapping
}
```

**After creating new tables (Step 4)**, backfill their entity set names:

```powershell
foreach ($purpose in ($tableMap.Keys | Where-Object { $tableMap[$_].Source -eq "Created" })) {
    $tableMap[$purpose].EntitySetName = Get-EntitySetName -TableLogicalName $tableMap[$purpose].LogicalName -BaseUrl $baseUrl -Headers $headers
}
```

**Always use `$tableMap`** to get correct table names:
- For relationships: `$tableMap["product"].LogicalName`
- For data queries: `$tableMap["category"].EntitySetName`

## Check If Table/Column Exists

```powershell
function Test-TableExists {
    param([string]$TableLogicalName)
    try {
        Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableLogicalName')?`$select=LogicalName" -Headers $headers -ErrorAction Stop
        return $true
    } catch {
        if ($_.Exception.Response.StatusCode -eq 404) { return $false }
        throw
    }
}

function Test-ColumnExists {
    param([string]$TableLogicalName, [string]$ColumnLogicalName)
    try {
        Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableLogicalName')/Attributes(LogicalName='$ColumnLogicalName')?`$select=LogicalName" -Headers $headers -ErrorAction Stop
        return $true
    } catch {
        if ($_.Exception.Response.StatusCode -eq 404) { return $false }
        throw
    }
}
```

## Create Table

**Use `$publisherPrefix`** (from `Initialize-DataverseApi`) for all schema names. Never hardcode prefixes.

```powershell
function New-DataverseTable {
    param(
        [string]$SchemaName,
        [string]$DisplayName,
        [string]$PluralDisplayName,
        [string]$Description = "",
        [string]$PrimaryColumnName = "${publisherPrefix}_name",
        [string]$PrimaryColumnDisplayName = "Name"
    )

    $tableDefinition = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.EntityMetadata"
        "SchemaName" = $SchemaName
        "DisplayName" = @{
            "@odata.type" = "Microsoft.Dynamics.CRM.Label"
            "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $DisplayName; "LanguageCode" = 1033 })
        }
        "DisplayCollectionName" = @{
            "@odata.type" = "Microsoft.Dynamics.CRM.Label"
            "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $PluralDisplayName; "LanguageCode" = 1033 })
        }
        "Description" = @{
            "@odata.type" = "Microsoft.Dynamics.CRM.Label"
            "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $Description; "LanguageCode" = 1033 })
        }
        "OwnershipType" = "UserOwned"
        "HasNotes" = $false
        "HasActivities" = $false
        "PrimaryNameAttribute" = $PrimaryColumnName
        "Attributes" = @(
            @{
                "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"
                "SchemaName" = $PrimaryColumnName
                "AttributeType" = "String"
                "FormatName" = @{ "Value" = "Text" }
                "MaxLength" = 100
                "DisplayName" = @{
                    "@odata.type" = "Microsoft.Dynamics.CRM.Label"
                    "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $PrimaryColumnDisplayName; "LanguageCode" = 1033 })
                }
                "IsPrimaryName" = $true
            }
        )
    }

    $body = $tableDefinition | ConvertTo-Json -Depth 10
    Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions" -Method Post -Headers $headers -Body $body
}

function New-DataverseTableIfNotExists {
    param(
        [string]$SchemaName,
        [string]$DisplayName,
        [string]$PluralDisplayName,
        [string]$Description = "",
        [string]$PrimaryColumnName = "${publisherPrefix}_name",
        [string]$PrimaryColumnDisplayName = "Name"
    )

    $logicalName = $SchemaName.ToLower()
    if (Test-TableExists -TableLogicalName $logicalName) {
        Write-Host "  [SKIP] Table '$SchemaName' already exists" -ForegroundColor Yellow
        return @{ Skipped = $true }
    }

    Write-Host "  [CREATE] Creating table '$SchemaName'..." -ForegroundColor Cyan
    $result = New-DataverseTable -SchemaName $SchemaName -DisplayName $DisplayName `
        -PluralDisplayName $PluralDisplayName -Description $Description `
        -PrimaryColumnName $PrimaryColumnName -PrimaryColumnDisplayName $PrimaryColumnDisplayName
    Write-Host "  [OK] Table '$SchemaName' created" -ForegroundColor Green
    return @{ Skipped = $false; Result = $result }
}
```

## Add Columns

```powershell
function Add-DataverseColumn {
    param(
        [string]$TableName,
        [string]$SchemaName,
        [string]$DisplayName,
        [string]$Type,  # String, Email, Url, Memo, Integer, Money, DateTime, Boolean
        [int]$MaxLength = 100
    )

    $columnTypes = @{
        "String" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"; "AttributeType" = "String"; "FormatName" = @{ "Value" = "Text" }; "MaxLength" = $MaxLength }
        "Email" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"; "AttributeType" = "String"; "FormatName" = @{ "Value" = "Email" }; "MaxLength" = $MaxLength }
        "Url" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"; "AttributeType" = "String"; "FormatName" = @{ "Value" = "Url" }; "MaxLength" = 200 }
        "Memo" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.MemoAttributeMetadata"; "AttributeType" = "Memo"; "MaxLength" = $MaxLength }
        "Integer" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.IntegerAttributeMetadata"; "AttributeType" = "Integer"; "MinValue" = -2147483648; "MaxValue" = 2147483647 }
        "Money" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.MoneyAttributeMetadata"; "AttributeType" = "Money"; "PrecisionSource" = 2 }
        "DateTime" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata"; "AttributeType" = "DateTime"; "Format" = "DateAndTime" }
        "Boolean" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.BooleanAttributeMetadata"; "AttributeType" = "Boolean" }
    }

    $column = $columnTypes[$Type].Clone()
    $column["SchemaName"] = $SchemaName
    $column["DisplayName"] = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $DisplayName; "LanguageCode" = 1033 })
    }

    Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableName')/Attributes" -Method Post -Headers $headers -Body ($column | ConvertTo-Json -Depth 10)
}

function Add-DataverseColumnIfNotExists {
    param(
        [string]$TableName,
        [string]$SchemaName,
        [string]$DisplayName,
        [string]$Type,
        [int]$MaxLength = 100
    )

    if (Test-ColumnExists -TableLogicalName $TableName.ToLower() -ColumnLogicalName $SchemaName.ToLower()) {
        Write-Host "    [SKIP] Column '$SchemaName' already exists on '$TableName'" -ForegroundColor Yellow
        return @{ Skipped = $true }
    }

    Write-Host "    [CREATE] Adding column '$SchemaName' to '$TableName'..." -ForegroundColor Cyan
    Add-DataverseColumn -TableName $TableName -SchemaName $SchemaName -DisplayName $DisplayName -Type $Type -MaxLength $MaxLength
    Write-Host "    [OK] Column '$SchemaName' added" -ForegroundColor Green
}
```

## Add Choice/Picklist Column

```powershell
function Add-DataversePicklist {
    param(
        [string]$TableName,
        [string]$SchemaName,
        [string]$DisplayName,
        [hashtable[]]$Options  # Array of @{ Value = 1; Label = "Option 1" }
    )

    $optionMetadata = $Options | ForEach-Object {
        @{
            "Value" = $_.Value
            "Label" = @{
                "@odata.type" = "Microsoft.Dynamics.CRM.Label"
                "LocalizedLabels" = @(@{
                    "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"
                    "Label" = $_.Label
                    "LanguageCode" = 1033
                })
            }
        }
    }

    $column = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.PicklistAttributeMetadata"
        "SchemaName" = $SchemaName
        "AttributeType" = "Picklist"
        "DisplayName" = @{
            "@odata.type" = "Microsoft.Dynamics.CRM.Label"
            "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $DisplayName; "LanguageCode" = 1033 })
        }
        "OptionSet" = @{
            "@odata.type" = "Microsoft.Dynamics.CRM.OptionSetMetadata"
            "IsGlobal" = $false
            "OptionSetType" = "Picklist"
            "Options" = $optionMetadata
        }
    }

    Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableName')/Attributes" -Method Post -Headers $headers -Body ($column | ConvertTo-Json -Depth 10)
}
```
