# Relationship Reference

## Relationship Types

| Type | Description | Use Case |
|------|-------------|----------|
| **1:N (One-to-Many)** | One parent record can have many child records | Category -> Products |
| **N:N (Many-to-Many)** | Records can relate to multiple records in both tables | Products <-> Tags |
| **Self-Referential** | Table references itself | Employee -> Manager |

## Check If Relationship Exists

```powershell
function Test-RelationshipExists {
    param([string]$RelationshipSchemaName)

    try {
        $result = Invoke-RestMethod -Uri "$baseUrl/RelationshipDefinitions(SchemaName='$RelationshipSchemaName')?`$select=SchemaName" -Headers $headers -ErrorAction Stop
        return $true
    } catch {
        if ($_.Exception.Response.StatusCode -eq 404) {
            return $false
        }
        throw
    }
}
```

## Get Table Relationships

```powershell
function Get-TableRelationships {
    param([string]$TableLogicalName)

    # Get 1:N relationships where this table is referenced
    $oneToMany = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableLogicalName')/OneToManyRelationships" -Headers $headers

    # Get N:1 relationships where this table references others
    $manyToOne = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableLogicalName')/ManyToOneRelationships" -Headers $headers

    Write-Host "`nRelationships for $TableLogicalName`:" -ForegroundColor Cyan

    Write-Host "  Referenced by (1:N):" -ForegroundColor Yellow
    $oneToMany.value | ForEach-Object {
        Write-Host "    - $($_.ReferencingEntity).$($_.ReferencingAttribute)"
    }

    Write-Host "  References (N:1):" -ForegroundColor Yellow
    $manyToOne.value | ForEach-Object {
        Write-Host "    - $($_.ReferencedEntity) via $($_.ReferencingAttribute)"
    }

    return @{
        OneToMany = $oneToMany.value
        ManyToOne = $manyToOne.value
    }
}
```

## Create Lookup (1:N Relationship)

```powershell
function Add-DataverseLookup {
    param(
        [string]$SourceTable,           # Table that will have the lookup column
        [string]$TargetTable,           # Table being referenced (must exist first!)
        [string]$LookupSchemaName,      # Schema name for the lookup column
        [string]$LookupDisplayName,     # Display name for the lookup column
        [string]$RelationshipName       # Unique name for the relationship
    )

    # Create a 1:N relationship (Many source records -> One target record)
    $relationship = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata"
        "SchemaName" = $RelationshipName
        "ReferencedEntity" = $TargetTable        # The "one" side (parent/lookup target)
        "ReferencingEntity" = $SourceTable       # The "many" side (child/has lookup)
        "Lookup" = @{
            "@odata.type" = "Microsoft.Dynamics.CRM.LookupAttributeMetadata"
            "SchemaName" = $LookupSchemaName
            "DisplayName" = @{
                "@odata.type" = "Microsoft.Dynamics.CRM.Label"
                "LocalizedLabels" = @(
                    @{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $LookupDisplayName; "LanguageCode" = 1033 }
                )
            }
        }
        "CascadeConfiguration" = @{
            "Assign" = "NoCascade"
            "Delete" = "RemoveLink"      # When parent deleted, clear the lookup (don't delete children)
            "Merge" = "NoCascade"
            "Reparent" = "NoCascade"
            "Share" = "NoCascade"
            "Unshare" = "NoCascade"
        }
    }

    $body = $relationship | ConvertTo-Json -Depth 10
    Invoke-RestMethod -Uri "$baseUrl/RelationshipDefinitions" -Method Post -Headers $headers -Body $body
}
```

## Safe Lookup Creation (Skip If Exists)

```powershell
function Add-DataverseLookupIfNotExists {
    param(
        [string]$SourceTable,
        [string]$TargetTable,
        [string]$LookupSchemaName,
        [string]$LookupDisplayName,
        [string]$RelationshipName
    )

    if (Test-RelationshipExists -RelationshipSchemaName $RelationshipName) {
        Write-Host "    [SKIP] Relationship '$RelationshipName' already exists" -ForegroundColor Yellow
        return @{ Skipped = $true; Reason = "Already exists" }
    }

    # Also check if the lookup column already exists (might be from a different relationship)
    $lookupLogicalName = $LookupSchemaName.ToLower()
    $sourceLogicalName = $SourceTable.ToLower()

    if (Test-ColumnExists -TableLogicalName $sourceLogicalName -ColumnLogicalName $lookupLogicalName) {
        Write-Host "    [SKIP] Lookup column '$LookupSchemaName' already exists on '$SourceTable'" -ForegroundColor Yellow
        return @{ Skipped = $true; Reason = "Lookup column already exists" }
    }

    Write-Host "    [CREATE] Creating relationship '$RelationshipName' ($SourceTable -> $TargetTable)..." -ForegroundColor Cyan
    $result = Add-DataverseLookup -SourceTable $SourceTable -TargetTable $TargetTable `
        -LookupSchemaName $LookupSchemaName -LookupDisplayName $LookupDisplayName `
        -RelationshipName $RelationshipName

    Write-Host "    [OK] Relationship '$RelationshipName' created successfully" -ForegroundColor Green
    return @{ Skipped = $false; Result = $result }
}
```

## Create Many-to-Many Relationship

```powershell
function Add-DataverseManyToMany {
    param(
        [string]$Table1,                # First table in the relationship
        [string]$Table2,                # Second table in the relationship
        [string]$RelationshipName,      # Unique name for the relationship
        [string]$IntersectEntityName    # Name for the junction table (auto-created)
    )

    # Create N:N relationship (junction table created automatically)
    $relationship = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata"
        "SchemaName" = $RelationshipName
        "Entity1LogicalName" = $Table1
        "Entity2LogicalName" = $Table2
        "IntersectEntityName" = $IntersectEntityName
        "Entity1AssociatedMenuConfiguration" = @{
            "Behavior" = "UseLabel"
            "Group" = "Details"
            "Label" = @{
                "@odata.type" = "Microsoft.Dynamics.CRM.Label"
                "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $Table2; "LanguageCode" = 1033 })
            }
            "Order" = 10000
        }
        "Entity2AssociatedMenuConfiguration" = @{
            "Behavior" = "UseLabel"
            "Group" = "Details"
            "Label" = @{
                "@odata.type" = "Microsoft.Dynamics.CRM.Label"
                "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = $Table1; "LanguageCode" = 1033 })
            }
            "Order" = 10000
        }
    }

    $body = $relationship | ConvertTo-Json -Depth 10
    Invoke-RestMethod -Uri "$baseUrl/RelationshipDefinitions" -Method Post -Headers $headers -Body $body
}
```

## Cascade Configuration Options

When creating relationships, you can configure cascade behavior:

| Option | Description |
|--------|-------------|
| `NoCascade` | No action on related records |
| `Cascade` | Perform action on all related records |
| `Active` | Perform action on active related records |
| `UserOwned` | Perform action on records owned by same user |
| `RemoveLink` | Clear the lookup value (recommended for Delete) |
| `Restrict` | Prevent action if related records exist |

## Relationship Naming Conventions

Follow this naming pattern for consistency, using the `$publisherPrefix` retrieved from `Initialize-DataverseApi`:

```text
{publisherPrefix}_{targetTable}_{sourceTable}

Examples (where $publisherPrefix = "cr"):
- {publisherPrefix}_category_product       (Product -> Category)
- {publisherPrefix}_department_teammember  (TeamMember -> Department)
- {publisherPrefix}_status_contactsubmission (ContactSubmission -> Status)
```

## Complete Example: Creating Relationships in Dependency Order

**IMPORTANT**: Use the `$tableMap` from `Build-TableNameMapping` to get the correct table names. This ensures:
- **Reused/Extended tables**: Use their actual logical names from Dataverse
- **New tables**: Use the publisher prefix pattern

```powershell
$api = Initialize-DataverseApi -EnvironmentUrl "https://orgname.crm.dynamics.com"
$publisherPrefix = $api.PublisherPrefix

# $tableMap should be built in STEP 5 using Build-TableNameMapping
# It maps table purposes to actual logical names
```

```powershell
# ============================================
# PHASE 3: Create Relationships
# ============================================

Write-Host "`n=== Processing Relationships ===" -ForegroundColor Magenta

# Helper to get actual table name from mapping
function Get-TableName { param([string]$Purpose) return $tableMap[$Purpose].LogicalName }

# --- TIER 1 -> TIER 0 Relationships ---
Write-Host "Processing TIER 1 -> TIER 0 relationships..." -ForegroundColor Cyan

# Product -> Category (uses actual table names from mapping)
$productTable = Get-TableName "product"
$categoryTable = Get-TableName "category"
Add-DataverseLookupIfNotExists -SourceTable $productTable -TargetTable $categoryTable `
    -LookupSchemaName "${publisherPrefix}_categoryid" -LookupDisplayName "Category" `
    -RelationshipName "${publisherPrefix}_${categoryTable}_${productTable}"

# Team Member -> Department
$teammemberTable = Get-TableName "teammember"
$departmentTable = Get-TableName "department"
Add-DataverseLookupIfNotExists -SourceTable $teammemberTable -TargetTable $departmentTable `
    -LookupSchemaName "${publisherPrefix}_departmentid" -LookupDisplayName "Department" `
    -RelationshipName "${publisherPrefix}_${departmentTable}_${teammemberTable}"

# Contact Submission -> Status
$contactsubmissionTable = Get-TableName "contactsubmission"
$statusTable = Get-TableName "status"
Add-DataverseLookupIfNotExists -SourceTable $contactsubmissionTable -TargetTable $statusTable `
    -LookupSchemaName "${publisherPrefix}_statusid" -LookupDisplayName "Status" `
    -RelationshipName "${publisherPrefix}_${statusTable}_${contactsubmissionTable}"

# --- TIER 2 -> TIER 1 Relationships ---
Write-Host "`nProcessing TIER 2 -> TIER 1 relationships..." -ForegroundColor Cyan

# Testimonial -> Product (optional relationship)
$testimonialTable = Get-TableName "testimonial"
Add-DataverseLookupIfNotExists -SourceTable $testimonialTable -TargetTable $productTable `
    -LookupSchemaName "${publisherPrefix}_productid" -LookupDisplayName "Related Product" `
    -RelationshipName "${publisherPrefix}_${productTable}_${testimonialTable}"

Write-Host "`n=== Relationship processing complete ===" -ForegroundColor Green
```

**NOTE**: When reusing existing tables, their logical names may differ from the expected pattern:
- New table: `cr_category` (follows `${publisherPrefix}_purpose` pattern)
- Reused table: `contoso_productcategory` or `existing_categories` (actual name from Dataverse)

The `$tableMap` handles this automatically by storing the actual logical names.

## Self-Referential Lookups

For tables that reference themselves (e.g., Employee -> Manager):

```powershell
# First, create the table
New-DataverseTable -SchemaName "${publisherPrefix}_employee" -DisplayName "Employee" -PluralDisplayName "Employees"

# Add regular columns
Add-DataverseColumn -TableName "${publisherPrefix}_employee" -SchemaName "${publisherPrefix}_title" -DisplayName "Job Title" -Type "String"

# Then add self-referential lookup (table must exist first!)
Add-DataverseLookup -SourceTable "${publisherPrefix}_employee" -TargetTable "${publisherPrefix}_employee" `
    -LookupSchemaName "${publisherPrefix}_managerid" -LookupDisplayName "Manager" `
    -RelationshipName "${publisherPrefix}_employee_manager"
```

## Verifying Relationships

```powershell
# Check if a relationship exists
$relationshipName = "${publisherPrefix}_category_product"
$relations = Invoke-RestMethod -Uri "$baseUrl/RelationshipDefinitions?`$filter=SchemaName eq '$relationshipName'" -Headers $headers
if ($relations.value.Count -gt 0) {
    Write-Host "Relationship exists" -ForegroundColor Green
    Write-Host "  Referenced Entity: $($relations.value[0].ReferencedEntity)"
    Write-Host "  Referencing Entity: $($relations.value[0].ReferencingEntity)"
} else {
    Write-Host "Relationship not found" -ForegroundColor Yellow
}

# List all relationships for a table
$tableName = "${publisherPrefix}_product"
$tableRelations = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$tableName')/ManyToOneRelationships" -Headers $headers
Write-Host "Lookups on ${tableName}:" -ForegroundColor Cyan
$tableRelations.value | ForEach-Object {
    Write-Host "  $($_.SchemaName): -> $($_.ReferencedEntity)"
}
```
