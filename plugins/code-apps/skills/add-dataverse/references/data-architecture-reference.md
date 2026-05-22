# Data Architecture Reference

## Relationship Types

- **1:N (One-to-Many)**: Parent table referenced by child via Lookup. Parent must exist first.
- **N:N (Many-to-Many)**: Junction table created automatically. Both tables must exist first.
- **Self-Referential**: Table references itself. Table must exist before adding self-lookup.

## Dependency Tiers

Create tables in order by their dependencies:
- **Tier 0**: Reference/lookup tables (no dependencies) - Category, Status, Department
- **Tier 1**: Primary entities (reference Tier 0) - Product->Category, Employee->Department
- **Tier 2**: Dependent/transaction tables (reference Tier 1) - Order->Customer, OrderLine->Order
- **Tier 3**: Deeply nested tables (rare)

## Common Relationship Patterns

| App Feature | Tables | Relationships |
|-------------|--------|---------------|
| **Inventory** | Category, Asset, ServiceRecord | Category(0) -> Asset(1) -> ServiceRecord(2) |
| **Helpdesk** | Category, Priority, Ticket, Comment | Category(0), Priority(0) -> Ticket(1) -> Comment(2) |
| **Project Tracker** | Department, Project, Task | Department(0) -> Project(1) -> Task(2) |
| **CRM** | Account, Contact, Opportunity | Account(0) -> Contact(1) -> Opportunity(2) |
| **Event Mgmt** | EventType, Event, Registration | EventType(0) -> Event(1) -> Registration(2) |

## Adding Lookups

```powershell
function Add-DataverseLookup {
    param(
        [string]$SourceTable,       # Table getting the lookup column
        [string]$TargetTable,       # Table being referenced
        [string]$SchemaName,        # Lookup column schema name
        [string]$DisplayName        # Lookup column display name
    )

    $lookup = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata"
        "SchemaName" = "${publisherPrefix}_${TargetTable}_${SourceTable}"
        "ReferencedEntity" = $TargetTable
        "ReferencingEntity" = $SourceTable
        "Lookup" = @{
            "@odata.type" = "Microsoft.Dynamics.CRM.LookupAttributeMetadata"
            "SchemaName" = $SchemaName
            "DisplayName" = @{
                "@odata.type" = "Microsoft.Dynamics.CRM.Label"
                "LocalizedLabels" = @(@{
                    "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"
                    "Label" = $DisplayName
                    "LanguageCode" = 1033
                })
            }
        }
        "CascadeConfiguration" = @{
            "Assign" = "NoCascade"
            "Delete" = "RemoveLink"
            "Merge" = "NoCascade"
            "Reparent" = "NoCascade"
            "Share" = "NoCascade"
            "Unshare" = "NoCascade"
        }
    }

    $body = $lookup | ConvertTo-Json -Depth 10
    Invoke-RestMethod -Uri "$baseUrl/RelationshipDefinitions" -Method Post -Headers $headers -Body $body
}

function Add-DataverseLookupIfNotExists {
    param(
        [string]$SourceTable,
        [string]$TargetTable,
        [string]$SchemaName,
        [string]$DisplayName
    )

    if (Test-ColumnExists -TableLogicalName $SourceTable -ColumnLogicalName $SchemaName.ToLower()) {
        Write-Host "    [SKIP] Lookup '$SchemaName' already exists on '$SourceTable'" -ForegroundColor Yellow
        return
    }

    Write-Host "    [CREATE] Adding lookup '$SchemaName' on '$SourceTable' -> '$TargetTable'..." -ForegroundColor Cyan
    Add-DataverseLookup -SourceTable $SourceTable -TargetTable $TargetTable -SchemaName $SchemaName -DisplayName $DisplayName
    Write-Host "    [OK] Lookup created" -ForegroundColor Green
}
```

## Validation Rules

Before table creation, validate:
1. No circular dependencies
2. All referenced tables exist
3. Lookup targets have primary keys
4. Self-references: create table first, then add self-lookup
