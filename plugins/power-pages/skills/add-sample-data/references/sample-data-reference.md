# Sample Data Reference

## Insertion Order

Insert data by dependency tier:
1. **Tier 0** (reference tables) - Categories, Statuses, Departments (skip existing)
2. **Tier 1** (primary entities) - Products, Team Members (with lookups to Tier 0)
3. **Tier 2** (dependent tables) - Testimonials, Contact Submissions (with lookups to Tier 1)

**Important**: Check for existing data first. Never insert records with invalid lookup values.
```

## Check Existing Data

```powershell
function Get-ExistingRecordCount {
    param([string]$EntitySetName)

    $result = Invoke-RestMethod -Uri "$baseUrl/$EntitySetName/`$count" -Headers $headers
    return [int]$result
}

function Get-ExistingRecordByName {
    param(
        [string]$EntitySetName,
        [string]$NameColumn,  # Usually "${publisherPrefix}_name" or the primary name attribute
        [string]$NameValue
    )

    $filter = "$NameColumn eq '$NameValue'"
    $result = Invoke-RestMethod -Uri "$baseUrl/$EntitySetName`?`$filter=$filter&`$top=1" -Headers $headers

    if ($result.value.Count -gt 0) {
        return $result.value[0]
    }
    return $null
}

# Check existing data counts
# NOTE: Use $tableMap from Build-TableNameMapping for actual entity set names
Write-Host "`nChecking existing data in tables..." -ForegroundColor Cyan

# Build counts using table mapping (handles both reused and new tables)
$existingDataCounts = @{}
foreach ($purpose in @("category", "status", "department", "product", "teammember", "testimonial", "contactsubmission")) {
    if ($tableMap.ContainsKey($purpose)) {
        $entitySet = $tableMap[$purpose].EntitySetName
        $existingDataCounts[$entitySet] = Get-ExistingRecordCount -EntitySetName $entitySet
    }
}

Write-Host "`nExisting record counts:" -ForegroundColor Yellow
$existingDataCounts.GetEnumerator() | ForEach-Object {
    $status = if ($_.Value -gt 0) { "[!]" } else { "[OK]" }
    Write-Host "  $status $($_.Key): $($_.Value) records"
}
```

## Create Record Helper Function

```powershell
function New-DataverseRecord {
    param(
        [string]$EntitySetName,
        [hashtable]$Data
    )

    $body = $Data | ConvertTo-Json -Depth 5
    $response = Invoke-RestMethod -Uri "$baseUrl/$EntitySetName" -Method Post -Headers $headers -Body $body
    return $response
}
```

## Safe Record Creation (Skip If Exists)

```powershell
function New-DataverseRecordIfNotExists {
    param(
        [string]$EntitySetName,
        [hashtable]$Data,
        [string]$NameColumn = "${publisherPrefix}_name"
    )

    $nameValue = $Data[$NameColumn]
    $existing = Get-ExistingRecordByName -EntitySetName $EntitySetName -NameColumn $NameColumn -NameValue $nameValue

    if ($existing) {
        Write-Host "    [SKIP] Record '$nameValue' already exists - using existing" -ForegroundColor Yellow
        return @{
            Skipped = $true
            Record = $existing
        }
    }

    Write-Host "    [CREATE] Creating record '$nameValue'..." -ForegroundColor Cyan
    $body = $Data | ConvertTo-Json -Depth 5
    $response = Invoke-RestMethod -Uri "$baseUrl/$EntitySetName" -Method Post -Headers $headers -Body $body
    Write-Host "    [OK] Record '$nameValue' created" -ForegroundColor Green

    return @{
        Skipped = $false
        Record = $response
    }
}
```

## Foreign Key Syntax

When inserting records with lookup values, use the `@odata.bind` syntax:

```powershell
# Format: "lookupcolumn@odata.bind" = "/entitysetname(guid)"
# NOTE: Use $publisherPrefix from Initialize-DataverseApi

$product = @{
    "${publisherPrefix}_name" = "Professional Consultation"
    "${publisherPrefix}_description" = "One-on-one consultation with our expert team."
    "${publisherPrefix}_price" = 299.99
    # Reference category by its ID
    "${publisherPrefix}_categoryid@odata.bind" = "/${publisherPrefix}_categories($categoryId)"
}
```

## Complete Sample Data Script

**IMPORTANT**: Use the `$tableMap` from `Build-TableNameMapping` to get the correct table names and entity set names. This ensures:
- **Reused tables**: Use their actual logical names and column names from Dataverse
- **New tables**: Use the publisher prefix pattern

```powershell
$api = Initialize-DataverseApi -EnvironmentUrl "https://orgname.crm.dynamics.com"
$publisherPrefix = $api.PublisherPrefix

# $tableMap should be built in STEP 5 using Build-TableNameMapping
# It maps table purposes to actual logical names and entity set names
```

### Helper Functions for Table Mapping

```powershell
# Get entity set name from table mapping
function Get-EntitySet { param([string]$Purpose) return $tableMap[$Purpose].EntitySetName }

# Get table logical name from mapping
function Get-TableName { param([string]$Purpose) return $tableMap[$Purpose].LogicalName }

# Get the primary key column name for a table
# For reused tables, this may differ from the standard pattern
function Get-PrimaryKeyColumn {
    param([string]$Purpose)
    $tableName = Get-TableName $Purpose
    # Primary key is typically {tablename}id
    return "${tableName}id"
}
```

```powershell
# ============================================
# TIER 0: Insert Reference/Lookup Data FIRST
# ============================================

Write-Host "`n=== TIER 0: Processing Reference/Lookup Data ===" -ForegroundColor Magenta

# --- Categories ---
$categoryIds = @{}
$categoryEntitySet = Get-EntitySet "category"
$categoryPK = Get-PrimaryKeyColumn "category"

# NOTE: For reused tables, column names may use the existing table's prefix
# For new tables, use $publisherPrefix for column names
$categories = @(
    @{ "${publisherPrefix}_name" = "Services"; "${publisherPrefix}_description" = "Professional services"; "${publisherPrefix}_displayorder" = 1; "${publisherPrefix}_isactive" = $true },
    @{ "${publisherPrefix}_name" = "Packages"; "${publisherPrefix}_description" = "Bundled offerings"; "${publisherPrefix}_displayorder" = 2; "${publisherPrefix}_isactive" = $true },
    @{ "${publisherPrefix}_name" = "Products"; "${publisherPrefix}_description" = "Physical and digital products"; "${publisherPrefix}_displayorder" = 3; "${publisherPrefix}_isactive" = $true }
)

Write-Host "Processing categories (using $categoryEntitySet)..." -ForegroundColor Cyan
foreach ($cat in $categories) {
    $result = New-DataverseRecordIfNotExists -EntitySetName $categoryEntitySet -Data $cat -NameColumn "${publisherPrefix}_name"
    $categoryIds[$cat["${publisherPrefix}_name"]] = $result.Record.$categoryPK
}

# --- Statuses ---
$statusIds = @{}
$statusEntitySet = Get-EntitySet "status"
$statusPK = Get-PrimaryKeyColumn "status"

$statuses = @(
    @{ "${publisherPrefix}_name" = "New"; "${publisherPrefix}_displayorder" = 1 },
    @{ "${publisherPrefix}_name" = "Reviewed"; "${publisherPrefix}_displayorder" = 2 },
    @{ "${publisherPrefix}_name" = "Responded"; "${publisherPrefix}_displayorder" = 3 },
    @{ "${publisherPrefix}_name" = "Closed"; "${publisherPrefix}_displayorder" = 4 }
)

Write-Host "`nProcessing statuses (using $statusEntitySet)..." -ForegroundColor Cyan
foreach ($status in $statuses) {
    $result = New-DataverseRecordIfNotExists -EntitySetName $statusEntitySet -Data $status -NameColumn "${publisherPrefix}_name"
    $statusIds[$status["${publisherPrefix}_name"]] = $result.Record.$statusPK
}

# --- Departments ---
$departmentIds = @{}
$departmentEntitySet = Get-EntitySet "department"
$departmentPK = Get-PrimaryKeyColumn "department"

$departments = @(
    @{ "${publisherPrefix}_name" = "Executive"; "${publisherPrefix}_code" = "EXEC" },
    @{ "${publisherPrefix}_name" = "Engineering"; "${publisherPrefix}_code" = "ENG" },
    @{ "${publisherPrefix}_name" = "Customer Success"; "${publisherPrefix}_code" = "CS" },
    @{ "${publisherPrefix}_name" = "Sales"; "${publisherPrefix}_code" = "SALES" }
)

Write-Host "`nProcessing departments (using $departmentEntitySet)..." -ForegroundColor Cyan
foreach ($dept in $departments) {
    $result = New-DataverseRecordIfNotExists -EntitySetName $departmentEntitySet -Data $dept -NameColumn "${publisherPrefix}_name"
    $departmentIds[$dept["${publisherPrefix}_name"]] = $result.Record.$departmentPK
}

# ============================================
# TIER 1: Insert Primary Entity Data
# ============================================

Write-Host "`n=== TIER 1: Processing Primary Entity Data ===" -ForegroundColor Magenta

# --- Products (with Category lookup) ---
$productIds = @{}
$productEntitySet = Get-EntitySet "product"
$productPK = Get-PrimaryKeyColumn "product"

# NOTE: For lookup bindings, use the actual entity set name from the table mapping
$products = @(
    @{
        "${publisherPrefix}_name" = "Professional Consultation"
        "${publisherPrefix}_description" = "One-on-one consultation with our expert team."
        "${publisherPrefix}_price" = 299.99
        "${publisherPrefix}_imageurl" = "https://images.unsplash.com/photo-1553877522-43269d4ea984?w=400"
        "${publisherPrefix}_isactive" = $true
        "${publisherPrefix}_categoryid@odata.bind" = "/$categoryEntitySet($($categoryIds['Services']))"
    },
    @{
        "${publisherPrefix}_name" = "Enterprise Solution Package"
        "${publisherPrefix}_description" = "Complete enterprise solution with 12 months support."
        "${publisherPrefix}_price" = 4999.99
        "${publisherPrefix}_imageurl" = "https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=400"
        "${publisherPrefix}_isactive" = $true
        "${publisherPrefix}_categoryid@odata.bind" = "/$categoryEntitySet($($categoryIds['Packages']))"
    },
    @{
        "${publisherPrefix}_name" = "Starter Kit"
        "${publisherPrefix}_description" = "Perfect for small businesses getting started."
        "${publisherPrefix}_price" = 99.99
        "${publisherPrefix}_imageurl" = "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400"
        "${publisherPrefix}_isactive" = $true
        "${publisherPrefix}_categoryid@odata.bind" = "/$categoryEntitySet($($categoryIds['Packages']))"
    }
)

Write-Host "Processing products (using $productEntitySet)..." -ForegroundColor Cyan
foreach ($product in $products) {
    $result = New-DataverseRecordIfNotExists -EntitySetName $productEntitySet -Data $product -NameColumn "${publisherPrefix}_name"
    $productIds[$product["${publisherPrefix}_name"]] = $result.Record.$productPK
}

# --- Team Members (with Department lookup) ---
$teamMemberIds = @{}
$teammemberEntitySet = Get-EntitySet "teammember"
$teammemberPK = Get-PrimaryKeyColumn "teammember"

$team = @(
    @{
        "${publisherPrefix}_name" = "Emily Rodriguez"
        "${publisherPrefix}_title" = "Chief Executive Officer"
        "${publisherPrefix}_email" = "emily.r@company.com"
        "${publisherPrefix}_bio" = "Emily has over 15 years of experience in technology leadership."
        "${publisherPrefix}_photourl" = "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=300"
        "${publisherPrefix}_linkedin" = "https://linkedin.com/in/emilyrodriguez"
        "${publisherPrefix}_displayorder" = 1
        "${publisherPrefix}_departmentid@odata.bind" = "/$departmentEntitySet($($departmentIds['Executive']))"
    },
    @{
        "${publisherPrefix}_name" = "David Kim"
        "${publisherPrefix}_title" = "Chief Technology Officer"
        "${publisherPrefix}_email" = "david.k@company.com"
        "${publisherPrefix}_bio" = "David brings deep technical expertise from his decade at leading tech companies."
        "${publisherPrefix}_photourl" = "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=300"
        "${publisherPrefix}_linkedin" = "https://linkedin.com/in/davidkim"
        "${publisherPrefix}_displayorder" = 2
        "${publisherPrefix}_departmentid@odata.bind" = "/$departmentEntitySet($($departmentIds['Engineering']))"
    },
    @{
        "${publisherPrefix}_name" = "Lisa Thompson"
        "${publisherPrefix}_title" = "Head of Customer Success"
        "${publisherPrefix}_email" = "lisa.t@company.com"
        "${publisherPrefix}_bio" = "Lisa ensures our customers achieve their goals."
        "${publisherPrefix}_photourl" = "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=300"
        "${publisherPrefix}_linkedin" = "https://linkedin.com/in/lisathompson"
        "${publisherPrefix}_displayorder" = 3
        "${publisherPrefix}_departmentid@odata.bind" = "/$departmentEntitySet($($departmentIds['Customer Success']))"
    }
)

Write-Host "`nProcessing team members (using $teammemberEntitySet)..." -ForegroundColor Cyan
foreach ($member in $team) {
    $result = New-DataverseRecordIfNotExists -EntitySetName $teammemberEntitySet -Data $member -NameColumn "${publisherPrefix}_name"
    $teamMemberIds[$member["${publisherPrefix}_name"]] = $result.Record.$teammemberPK
}

# ============================================
# TIER 2: Insert Dependent Data
# ============================================

Write-Host "`n=== TIER 2: Processing Dependent Data ===" -ForegroundColor Magenta

# --- Contact Submissions (with Status lookup) ---
$contactsubmissionEntitySet = Get-EntitySet "contactsubmission"

$contacts = @(
    @{
        "${publisherPrefix}_name" = "John Smith"
        "${publisherPrefix}_email" = "john.smith@example.com"
        "${publisherPrefix}_message" = "I'm interested in learning more about your services."
        "${publisherPrefix}_submissiondate" = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
        "${publisherPrefix}_statusid@odata.bind" = "/$statusEntitySet($($statusIds['New']))"
    },
    @{
        "${publisherPrefix}_name" = "Sarah Johnson"
        "${publisherPrefix}_email" = "sarah.j@company.com"
        "${publisherPrefix}_message" = "Looking for a partner for our upcoming project."
        "${publisherPrefix}_submissiondate" = (Get-Date).AddDays(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
        "${publisherPrefix}_statusid@odata.bind" = "/$statusEntitySet($($statusIds['Reviewed']))"
    },
    @{
        "${publisherPrefix}_name" = "Michael Chen"
        "${publisherPrefix}_email" = "m.chen@startup.io"
        "${publisherPrefix}_message" = "Questions about pricing and availability."
        "${publisherPrefix}_submissiondate" = (Get-Date).AddDays(-5).ToString("yyyy-MM-ddTHH:mm:ssZ")
        "${publisherPrefix}_statusid@odata.bind" = "/$statusEntitySet($($statusIds['Responded']))"
    }
)

Write-Host "Processing contact submissions (using $contactsubmissionEntitySet)..." -ForegroundColor Cyan
foreach ($contact in $contacts) {
    New-DataverseRecordIfNotExists -EntitySetName $contactsubmissionEntitySet -Data $contact -NameColumn "${publisherPrefix}_name"
}

# --- Testimonials (with optional Product lookup) ---
$testimonialEntitySet = Get-EntitySet "testimonial"

$testimonials = @(
    @{
        "${publisherPrefix}_name" = "Amanda Foster"
        "${publisherPrefix}_quote" = "Their solution increased our efficiency by 40%."
        "${publisherPrefix}_company" = "TechStart Inc."
        "${publisherPrefix}_role" = "Operations Director"
        "${publisherPrefix}_rating" = 5
        "${publisherPrefix}_photourl" = "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200"
        "${publisherPrefix}_isactive" = $true
        "${publisherPrefix}_productid@odata.bind" = "/$productEntitySet($($productIds['Enterprise Solution Package']))"
    },
    @{
        "${publisherPrefix}_name" = "Robert Martinez"
        "${publisherPrefix}_quote" = "The best investment we've made this year."
        "${publisherPrefix}_company" = "Global Solutions Ltd"
        "${publisherPrefix}_role" = "CEO"
        "${publisherPrefix}_rating" = 5
        "${publisherPrefix}_photourl" = "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200"
        "${publisherPrefix}_isactive" = $true
        "${publisherPrefix}_productid@odata.bind" = "/$productEntitySet($($productIds['Professional Consultation']))"
    },
    @{
        "${publisherPrefix}_name" = "Jennifer Wu"
        "${publisherPrefix}_quote" = "Delivered beyond expectations. Highly recommend."
        "${publisherPrefix}_company" = "Innovate Partners"
        "${publisherPrefix}_role" = "Managing Partner"
        "${publisherPrefix}_rating" = 5
        "${publisherPrefix}_photourl" = "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=200"
        "${publisherPrefix}_isactive" = $true
        # General testimonial - no specific product linked
    }
)

Write-Host "`nProcessing testimonials (using $testimonialEntitySet)..." -ForegroundColor Cyan
foreach ($testimonial in $testimonials) {
    New-DataverseRecordIfNotExists -EntitySetName $testimonialEntitySet -Data $testimonial -NameColumn "${publisherPrefix}_name"
}

Write-Host "`n=== Sample data processing complete ===" -ForegroundColor Green
```

## Verify Data and Relationships

**NOTE**: Use the `$tableMap` entity set names to query the correct tables (handles both reused and new tables).

```powershell
# Verify products with their categories (expanded relationship)
$productEntitySet = Get-EntitySet "product"
Write-Host "Products with Categories (from $productEntitySet):" -ForegroundColor Cyan
$products = Invoke-RestMethod -Uri "$baseUrl/$productEntitySet`?`$select=${publisherPrefix}_name,${publisherPrefix}_price&`$expand=${publisherPrefix}_categoryid(`$select=${publisherPrefix}_name)" -Headers $headers
$products.value | ForEach-Object {
    Write-Host "  $($_."${publisherPrefix}_name") - `$$($_."${publisherPrefix}_price") - Category: $($_."${publisherPrefix}_categoryid"."${publisherPrefix}_name")"
}

# Verify team members with their departments
$teammemberEntitySet = Get-EntitySet "teammember"
Write-Host "`nTeam Members with Departments (from $teammemberEntitySet):" -ForegroundColor Cyan
$members = Invoke-RestMethod -Uri "$baseUrl/$teammemberEntitySet`?`$select=${publisherPrefix}_name,${publisherPrefix}_title&`$expand=${publisherPrefix}_departmentid(`$select=${publisherPrefix}_name)" -Headers $headers
$members.value | ForEach-Object {
    Write-Host "  $($_."${publisherPrefix}_name") ($($_."${publisherPrefix}_title")) - Dept: $($_."${publisherPrefix}_departmentid"."${publisherPrefix}_name")"
}

# Verify contact submissions with their statuses
$contactsubmissionEntitySet = Get-EntitySet "contactsubmission"
Write-Host "`nContact Submissions with Statuses (from $contactsubmissionEntitySet):" -ForegroundColor Cyan
$submissions = Invoke-RestMethod -Uri "$baseUrl/$contactsubmissionEntitySet`?`$select=${publisherPrefix}_name,${publisherPrefix}_email&`$expand=${publisherPrefix}_statusid(`$select=${publisherPrefix}_name)" -Headers $headers
$submissions.value | ForEach-Object {
    Write-Host "  $($_."${publisherPrefix}_name") ($($_."${publisherPrefix}_email")) - Status: $($_."${publisherPrefix}_statusid"."${publisherPrefix}_name")"
}

# Verify testimonials with their linked products
$testimonialEntitySet = Get-EntitySet "testimonial"
Write-Host "`nTestimonials with Products (from $testimonialEntitySet):" -ForegroundColor Cyan
$testimonials = Invoke-RestMethod -Uri "$baseUrl/$testimonialEntitySet`?`$select=${publisherPrefix}_name,${publisherPrefix}_company&`$expand=${publisherPrefix}_productid(`$select=${publisherPrefix}_name)" -Headers $headers
$testimonials.value | ForEach-Object {
    $productName = if ($_."${publisherPrefix}_productid") { $_."${publisherPrefix}_productid"."${publisherPrefix}_name" } else { "(General)" }
    Write-Host "  $($_."${publisherPrefix}_name") from $($_."${publisherPrefix}_company") - Product: $productName"
}
```

## Update Records

```powershell
function Update-DataverseRecord {
    param(
        [string]$EntitySetName,
        [string]$RecordId,
        [hashtable]$Data
    )

    $body = $Data | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Uri "$baseUrl/$EntitySetName($RecordId)" -Method Patch -Headers $headers -Body $body
}

# Example: Update a product's price
Update-DataverseRecord -EntitySetName "${publisherPrefix}_products" -RecordId $productIds['Starter Kit'] -Data @{
    "${publisherPrefix}_price" = 129.99
}
```

## Delete Records

```powershell
function Remove-DataverseRecord {
    param(
        [string]$EntitySetName,
        [string]$RecordId
    )

    Invoke-RestMethod -Uri "$baseUrl/$EntitySetName($RecordId)" -Method Delete -Headers $headers
}

# CAUTION: Delete records in reverse dependency order (TIER 2 -> TIER 1 -> TIER 0)
```
