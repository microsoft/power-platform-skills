# Table Management Reference

## Query Existing Custom Tables

Before creating tables, review existing custom tables in the environment:

```powershell
# Get all custom tables (entities) in the environment
$existingTables = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions?`$filter=IsCustomEntity eq true&`$select=SchemaName,LogicalName,DisplayName,Description,PrimaryNameAttribute" -Headers $headers

Write-Host "Found $($existingTables.value.Count) custom tables in the environment:" -ForegroundColor Cyan
$existingTables.value | ForEach-Object {
    $displayName = $_.DisplayName.UserLocalizedLabel.Label
    Write-Host "  - $($_.SchemaName) ($displayName)" -ForegroundColor Yellow
}
```

## Get Table Schema Details

```powershell
function Get-TableSchema {
    param([string]$TableLogicalName)

    # Get table metadata with attributes
    $tableInfo = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableLogicalName')?`$expand=Attributes(`$select=SchemaName,LogicalName,AttributeType,DisplayName,MaxLength)" -Headers $headers

    Write-Host "`nTable: $($tableInfo.SchemaName)" -ForegroundColor Cyan
    Write-Host "Display Name: $($tableInfo.DisplayName.UserLocalizedLabel.Label)"
    Write-Host "Primary Column: $($tableInfo.PrimaryNameAttribute)"
    Write-Host "Columns:" -ForegroundColor Yellow

    $tableInfo.Attributes | Where-Object {
        # Filter out system columns
        $_.SchemaName -notmatch '^(Created|Modified|Owner|State|Status|Version|Import|Overridden|TimeZone|UTCConversion|Traversed)'
    } | ForEach-Object {
        $displayName = if ($_.DisplayName.UserLocalizedLabel) { $_.DisplayName.UserLocalizedLabel.Label } else { $_.SchemaName }
        Write-Host "    - $($_.SchemaName) ($($_.AttributeType)) - $displayName"
    }

    return $tableInfo
}
```

## Compare Existing vs Required Tables

```powershell
function Compare-TableSchemas {
    param(
        [hashtable]$RequiredTables,  # Purpose name -> array of required columns (e.g., "category", "product")
        [array]$ExistingTables       # From EntityDefinitions query
    )

    $comparison = @{
        Reusable = @()      # Existing tables that match or exceed requirements
        Extendable = @()    # Existing tables that need additional columns
        CreateNew = @()     # Tables that don't exist and must be created
    }

    foreach ($tablePurpose in $RequiredTables.Keys) {
        # Search for existing tables that match this purpose (by name patterns)
        $existing = Find-SimilarTables -Purpose $tablePurpose -ExistingTables $ExistingTables | Select-Object -First 1

        if ($existing) {
            # Table exists - check if it has all required columns
            $tableSchema = Get-TableSchema -TableLogicalName $existing.LogicalName
            $existingColumns = $tableSchema.Attributes | Select-Object -ExpandProperty SchemaName
            $requiredColumns = $RequiredTables[$tablePurpose]

            $missingColumns = $requiredColumns | Where-Object { $_ -notin $existingColumns }

            if ($missingColumns.Count -eq 0) {
                $comparison.Reusable += @{
                    TablePurpose = $tablePurpose                    # Intended purpose (e.g., "category")
                    ActualLogicalName = $existing.LogicalName       # Actual name in Dataverse (e.g., "cr_productcategory")
                    ActualSchemaName = $existing.SchemaName         # Schema name (e.g., "cr_ProductCategory")
                    ExistingTable = $existing
                    Message = "All required columns present"
                }
            } else {
                $comparison.Extendable += @{
                    TablePurpose = $tablePurpose
                    ActualLogicalName = $existing.LogicalName
                    ActualSchemaName = $existing.SchemaName
                    ExistingTable = $existing
                    MissingColumns = $missingColumns
                    Message = "Missing columns: $($missingColumns -join ', ')"
                }
            }
        } else {
            $comparison.CreateNew += @{
                TablePurpose = $tablePurpose
                # New tables will use the publisher prefix pattern
                NewSchemaName = "${publisherPrefix}_$tablePurpose"
                NewLogicalName = "${publisherPrefix}_$tablePurpose".ToLower()
                RequiredColumns = $RequiredTables[$tablePurpose]
            }
        }
    }

    return $comparison
}
```

## Build Table Name Mapping

After comparing tables and getting user decisions, build a mapping that tracks the actual logical names to use for each table purpose. This is **critical** for correctly referencing tables throughout the workflow.

```powershell
function Build-TableNameMapping {
    param(
        [object]$ComparisonResult,  # From Compare-TableSchemas
        [string]$PublisherPrefix    # From Initialize-DataverseApi
    )

    # Maps table purpose -> actual logical name and entity set name
    # This ensures we use existing table names when reusing, and new names when creating
    $tableMapping = @{}

    # Tables being reused - use their ACTUAL logical names
    foreach ($table in $ComparisonResult.Reusable) {
        $tableMapping[$table.TablePurpose] = @{
            LogicalName = $table.ActualLogicalName
            SchemaName = $table.ActualSchemaName
            EntitySetName = $table.ActualLogicalName + "es"  # Pluralized for OData (may need adjustment)
            Source = "Reused"
        }
        Write-Host "  [REUSE] $($table.TablePurpose) -> $($table.ActualLogicalName)" -ForegroundColor Yellow
    }

    # Tables being extended - use their ACTUAL logical names
    foreach ($table in $ComparisonResult.Extendable) {
        $tableMapping[$table.TablePurpose] = @{
            LogicalName = $table.ActualLogicalName
            SchemaName = $table.ActualSchemaName
            EntitySetName = $table.ActualLogicalName + "es"
            Source = "Extended"
        }
        Write-Host "  [EXTEND] $($table.TablePurpose) -> $($table.ActualLogicalName)" -ForegroundColor Cyan
    }

    # Tables being created - use the publisher prefix pattern
    foreach ($table in $ComparisonResult.CreateNew) {
        $logicalName = "${PublisherPrefix}_$($table.TablePurpose)".ToLower()
        $schemaName = "${PublisherPrefix}_$($table.TablePurpose)"
        $tableMapping[$table.TablePurpose] = @{
            LogicalName = $logicalName
            SchemaName = $schemaName
            EntitySetName = $logicalName + "s"  # Standard pluralization for new tables
            Source = "Created"
        }
        Write-Host "  [CREATE] $($table.TablePurpose) -> $logicalName" -ForegroundColor Green
    }

    return $tableMapping
}

# Example usage:
# $comparison = Compare-TableSchemas -RequiredTables $requiredTables -ExistingTables $existingTables.value
# $tableMap = Build-TableNameMapping -ComparisonResult $comparison -PublisherPrefix $publisherPrefix
#
# # Later, when referencing tables, use the mapping:
# $categoryTable = $tableMap["category"].LogicalName      # e.g., "existing_productcategory" or "cr_category"
# $categoryEntitySet = $tableMap["category"].EntitySetName  # e.g., "existing_productcategories" or "cr_categorys"
```

**IMPORTANT**: Always use the `$tableMap` to get the correct table names throughout the workflow:
- For relationships: `$tableMap["product"].LogicalName` instead of `"${publisherPrefix}_product"`
- For data queries: `$tableMap["category"].EntitySetName` instead of `"${publisherPrefix}_categories"`
- For column additions: `$tableMap["teammember"].LogicalName` instead of `"${publisherPrefix}_teammember"`

## Find Similar Tables

Search for tables with similar purposes but different names:

```powershell
function Find-SimilarTables {
    param(
        [string]$Purpose,  # e.g., "category", "product", "contact"
        [array]$ExistingTables
    )

    # Common naming patterns to search for
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

## Check If Table/Column Exists

```powershell
function Test-TableExists {
    param([string]$TableLogicalName)

    try {
        $result = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableLogicalName')?`$select=LogicalName" -Headers $headers -ErrorAction Stop
        return $true
    } catch {
        if ($_.Exception.Response.StatusCode -eq 404) {
            return $false
        }
        throw
    }
}

function Test-ColumnExists {
    param(
        [string]$TableLogicalName,
        [string]$ColumnLogicalName
    )

    try {
        $result = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableLogicalName')/Attributes(LogicalName='$ColumnLogicalName')?`$select=LogicalName" -Headers $headers -ErrorAction Stop
        return $true
    } catch {
        if ($_.Exception.Response.StatusCode -eq 404) {
            return $false
        }
        throw
    }
}
```

## Create Table Helper Function

**IMPORTANT**: Use the `$publisherPrefix` variable (retrieved via `Initialize-DataverseApi`) for all table and column schema names. Never hardcode prefixes.

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
```

## Safe Table Creation (Skip If Exists)

```powershell
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
        return @{ Skipped = $true; Reason = "Already exists" }
    }

    Write-Host "  [CREATE] Creating table '$SchemaName'..." -ForegroundColor Cyan
    $result = New-DataverseTable -SchemaName $SchemaName -DisplayName $DisplayName `
        -PluralDisplayName $PluralDisplayName -Description $Description `
        -PrimaryColumnName $PrimaryColumnName -PrimaryColumnDisplayName $PrimaryColumnDisplayName

    Write-Host "  [OK] Table '$SchemaName' created successfully" -ForegroundColor Green
    return @{ Skipped = $false; Result = $result }
}
```

## Add Column Helper Function

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
```

## Safe Column Addition (Skip If Exists)

```powershell
function Add-DataverseColumnIfNotExists {
    param(
        [string]$TableName,
        [string]$SchemaName,
        [string]$DisplayName,
        [string]$Type,
        [int]$MaxLength = 100
    )

    $columnLogicalName = $SchemaName.ToLower()
    $tableLogicalName = $TableName.ToLower()

    if (Test-ColumnExists -TableLogicalName $tableLogicalName -ColumnLogicalName $columnLogicalName) {
        Write-Host "    [SKIP] Column '$SchemaName' already exists on '$TableName'" -ForegroundColor Yellow
        return @{ Skipped = $true; Reason = "Already exists" }
    }

    Write-Host "    [CREATE] Adding column '$SchemaName' to '$TableName'..." -ForegroundColor Cyan
    $result = Add-DataverseColumn -TableName $TableName -SchemaName $SchemaName `
        -DisplayName $DisplayName -Type $Type -MaxLength $MaxLength

    Write-Host "    [OK] Column '$SchemaName' added successfully" -ForegroundColor Green
    return @{ Skipped = $false; Result = $result }
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

# Example usage:
# Add-DataversePicklist -TableName "${publisherPrefix}_contactsubmission" -SchemaName "${publisherPrefix}_status" -DisplayName "Status" -Options @(
#     @{ Value = 1; Label = "New" },
#     @{ Value = 2; Label = "Reviewed" },
#     @{ Value = 3; Label = "Responded" },
#     @{ Value = 4; Label = "Closed" }
# )
```

## Common Table Templates

**NOTE**: All examples below use `$publisherPrefix` variable. Initialize it first using:
```powershell
$api = Initialize-DataverseApi -EnvironmentUrl "https://orgname.crm.dynamics.com"
$publisherPrefix = $api.PublisherPrefix  # e.g., "cr", "contoso", "new"
```

### Product/Service Table

```powershell
New-DataverseTable -SchemaName "${publisherPrefix}_product" -DisplayName "Product" -PluralDisplayName "Products" -Description "Products and services offered"

Add-DataverseColumn -TableName "${publisherPrefix}_product" -SchemaName "${publisherPrefix}_description" -DisplayName "Description" -Type "Memo" -MaxLength 4000
Add-DataverseColumn -TableName "${publisherPrefix}_product" -SchemaName "${publisherPrefix}_price" -DisplayName "Price" -Type "Money"
Add-DataverseColumn -TableName "${publisherPrefix}_product" -SchemaName "${publisherPrefix}_imageurl" -DisplayName "Image URL" -Type "Url"
Add-DataverseColumn -TableName "${publisherPrefix}_product" -SchemaName "${publisherPrefix}_isactive" -DisplayName "Is Active" -Type "Boolean"
```

### Team Member Table

```powershell
New-DataverseTable -SchemaName "${publisherPrefix}_teammember" -DisplayName "Team Member" -PluralDisplayName "Team Members" -Description "Team members displayed on the website"

Add-DataverseColumn -TableName "${publisherPrefix}_teammember" -SchemaName "${publisherPrefix}_title" -DisplayName "Job Title" -Type "String"
Add-DataverseColumn -TableName "${publisherPrefix}_teammember" -SchemaName "${publisherPrefix}_email" -DisplayName "Email" -Type "Email"
Add-DataverseColumn -TableName "${publisherPrefix}_teammember" -SchemaName "${publisherPrefix}_bio" -DisplayName "Bio" -Type "Memo" -MaxLength 4000
Add-DataverseColumn -TableName "${publisherPrefix}_teammember" -SchemaName "${publisherPrefix}_photourl" -DisplayName "Photo URL" -Type "Url"
Add-DataverseColumn -TableName "${publisherPrefix}_teammember" -SchemaName "${publisherPrefix}_linkedin" -DisplayName "LinkedIn" -Type "Url"
Add-DataverseColumn -TableName "${publisherPrefix}_teammember" -SchemaName "${publisherPrefix}_displayorder" -DisplayName "Display Order" -Type "Integer"
```

### Testimonial Table

```powershell
New-DataverseTable -SchemaName "${publisherPrefix}_testimonial" -DisplayName "Testimonial" -PluralDisplayName "Testimonials" -Description "Customer testimonials and reviews"

Add-DataverseColumn -TableName "${publisherPrefix}_testimonial" -SchemaName "${publisherPrefix}_quote" -DisplayName "Quote" -Type "Memo" -MaxLength 2000
Add-DataverseColumn -TableName "${publisherPrefix}_testimonial" -SchemaName "${publisherPrefix}_company" -DisplayName "Company" -Type "String"
Add-DataverseColumn -TableName "${publisherPrefix}_testimonial" -SchemaName "${publisherPrefix}_role" -DisplayName "Role" -Type "String"
Add-DataverseColumn -TableName "${publisherPrefix}_testimonial" -SchemaName "${publisherPrefix}_rating" -DisplayName "Rating" -Type "Integer"
Add-DataverseColumn -TableName "${publisherPrefix}_testimonial" -SchemaName "${publisherPrefix}_photourl" -DisplayName "Photo URL" -Type "Url"
Add-DataverseColumn -TableName "${publisherPrefix}_testimonial" -SchemaName "${publisherPrefix}_isactive" -DisplayName "Is Active" -Type "Boolean"
```

### Contact Submission Table

```powershell
New-DataverseTable -SchemaName "${publisherPrefix}_contactsubmission" -DisplayName "Contact Submission" -PluralDisplayName "Contact Submissions" -Description "Contact form submissions from the website"

Add-DataverseColumn -TableName "${publisherPrefix}_contactsubmission" -SchemaName "${publisherPrefix}_email" -DisplayName "Email" -Type "Email"
Add-DataverseColumn -TableName "${publisherPrefix}_contactsubmission" -SchemaName "${publisherPrefix}_message" -DisplayName "Message" -Type "Memo" -MaxLength 4000
Add-DataverseColumn -TableName "${publisherPrefix}_contactsubmission" -SchemaName "${publisherPrefix}_submissiondate" -DisplayName "Submission Date" -Type "DateTime"
```

### FAQ Table

```powershell
New-DataverseTable -SchemaName "${publisherPrefix}_faq" -DisplayName "FAQ" -PluralDisplayName "FAQs" -Description "Frequently asked questions" -PrimaryColumnName "${publisherPrefix}_question" -PrimaryColumnDisplayName "Question"

Add-DataverseColumn -TableName "${publisherPrefix}_faq" -SchemaName "${publisherPrefix}_answer" -DisplayName "Answer" -Type "Memo" -MaxLength 4000
Add-DataverseColumn -TableName "${publisherPrefix}_faq" -SchemaName "${publisherPrefix}_category" -DisplayName "Category" -Type "String"
Add-DataverseColumn -TableName "${publisherPrefix}_faq" -SchemaName "${publisherPrefix}_displayorder" -DisplayName "Display Order" -Type "Integer"
Add-DataverseColumn -TableName "${publisherPrefix}_faq" -SchemaName "${publisherPrefix}_isactive" -DisplayName "Is Active" -Type "Boolean"
```
