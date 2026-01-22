# Relationship Reference

This document covers creating and managing relationships between Dataverse tables.

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

Follow this naming pattern for consistency:

```text
{publisher}_{targetTable}_{sourceTable}

Examples:
- cr_category_product       (Product -> Category)
- cr_department_teammember  (TeamMember -> Department)
- cr_status_contactsubmission (ContactSubmission -> Status)
```

## Complete Example: Creating Relationships in Dependency Order

```powershell
# ============================================
# PHASE 3: Create Relationships
# ============================================

Write-Host "`n=== Processing Relationships ===" -ForegroundColor Magenta

# --- TIER 1 -> TIER 0 Relationships ---
Write-Host "Processing TIER 1 -> TIER 0 relationships..." -ForegroundColor Cyan

# Product -> Category
Add-DataverseLookupIfNotExists -SourceTable "cr_product" -TargetTable "cr_category" `
    -LookupSchemaName "cr_categoryid" -LookupDisplayName "Category" `
    -RelationshipName "cr_category_product"

# Team Member -> Department
Add-DataverseLookupIfNotExists -SourceTable "cr_teammember" -TargetTable "cr_department" `
    -LookupSchemaName "cr_departmentid" -LookupDisplayName "Department" `
    -RelationshipName "cr_department_teammember"

# Contact Submission -> Status
Add-DataverseLookupIfNotExists -SourceTable "cr_contactsubmission" -TargetTable "cr_status" `
    -LookupSchemaName "cr_statusid" -LookupDisplayName "Status" `
    -RelationshipName "cr_status_contactsubmission"

# --- TIER 2 -> TIER 1 Relationships ---
Write-Host "`nProcessing TIER 2 -> TIER 1 relationships..." -ForegroundColor Cyan

# Testimonial -> Product (optional relationship)
Add-DataverseLookupIfNotExists -SourceTable "cr_testimonial" -TargetTable "cr_product" `
    -LookupSchemaName "cr_productid" -LookupDisplayName "Related Product" `
    -RelationshipName "cr_product_testimonial"

Write-Host "`n=== Relationship processing complete ===" -ForegroundColor Green
```

## Self-Referential Lookups

For tables that reference themselves (e.g., Employee -> Manager):

```powershell
# First, create the table
New-DataverseTable -SchemaName "cr_employee" -DisplayName "Employee" -PluralDisplayName "Employees"

# Add regular columns
Add-DataverseColumn -TableName "cr_employee" -SchemaName "cr_title" -DisplayName "Job Title" -Type "String"

# Then add self-referential lookup (table must exist first!)
Add-DataverseLookup -SourceTable "cr_employee" -TargetTable "cr_employee" `
    -LookupSchemaName "cr_managerid" -LookupDisplayName "Manager" `
    -RelationshipName "cr_employee_manager"
```

## Verifying Relationships

```powershell
# Check if a relationship exists
$relations = Invoke-RestMethod -Uri "$baseUrl/RelationshipDefinitions?`$filter=SchemaName eq 'cr_category_product'" -Headers $headers
if ($relations.value.Count -gt 0) {
    Write-Host "Relationship exists" -ForegroundColor Green
    Write-Host "  Referenced Entity: $($relations.value[0].ReferencedEntity)"
    Write-Host "  Referencing Entity: $($relations.value[0].ReferencingEntity)"
} else {
    Write-Host "Relationship not found" -ForegroundColor Yellow
}

# List all relationships for a table
$tableRelations = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='cr_product')/ManyToOneRelationships" -Headers $headers
Write-Host "Lookups on cr_product:" -ForegroundColor Cyan
$tableRelations.value | ForEach-Object {
    Write-Host "  $($_.SchemaName): -> $($_.ReferencedEntity)"
}
```
