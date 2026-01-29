---
name: adding-sample-data
description: Inserts sample data into Dataverse tables with proper foreign key relationships. Use when populating tables with test data, adding demo content, or seeding databases.
user-invocable: true
allowed-tools: ["Read", "Write", "Grep", "Glob", "Bash", "AskUserQuestion"]
model: opus
---

**📋 [Shared Instructions](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Read before starting.

# Add Sample Data

**References:** [sample-data](./references/sample-data-reference.md)

Inserts sample data into Dataverse tables created by `/setup-dataverse`.

## Prerequisites

- Tables created with `/setup-dataverse`
- `$tableMap` available in memory bank with actual table names
- API authentication set up

## Workflow

1. **Check Context** → Read memory bank, get table mapping
2. **Check Existing Data** → Query tables to avoid duplicates
3. **Confirm with User** → Show what will be inserted
4. **Insert Tier 0** → Reference tables (categories, statuses)
5. **Insert Tier 1** → Primary entities with lookups
6. **Insert Tier 2** → Dependent records
7. **Verify Data** → Query with $expand to check relationships

---

## Step 1: Check Context

Read `memory-bank.md` for:
- Table name mapping (`$tableMap`)
- Publisher prefix
- Environment URL

If `/setup-dataverse` not completed, tell user to run it first.

---

## Step 2: Check Existing Data

```powershell
$api = Initialize-DataverseApi -EnvironmentUrl "https://<org>.crm.dynamics.com"

# Check record counts for each table
foreach ($purpose in $tableMap.Keys) {
    $entitySet = $tableMap[$purpose].EntitySetName
    $count = Get-ExistingRecordCount -EntitySetName $entitySet
    Write-Host "$purpose ($entitySet): $count records"
}
```

---

## Step 3: Confirm with User

Use `AskUserQuestion` to show:
- Tables that already have data (will skip or append)
- Tables that are empty (will populate)
- Sample records to be created

Options:
- **Proceed** - Insert sample data
- **Skip existing** - Only populate empty tables
- **Cancel** - Don't insert any data

---

## Step 4-6: Insert Data by Tier

See [sample-data-reference.md](./references/sample-data-reference.md#complete-sample-data-script).

**Tier 0** (reference tables): Categories, Statuses, Departments
**Tier 1** (primary entities): Products, Team Members
**Tier 2** (dependent): Testimonials, Contact Submissions

Use `New-DataverseRecordIfNotExists` to skip existing records.

---

## Step 7: Verify Data

```powershell
# Verify relationships with $expand
$products = Invoke-RestMethod -Uri "$baseUrl/$productEntitySet`?`$expand=${prefix}_categoryid" -Headers $headers
```

Update memory-bank.md with sample data status.
