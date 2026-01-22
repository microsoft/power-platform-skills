# Sample Data Reference

This document covers inserting sample data into Dataverse tables while maintaining referential integrity.

## Data Insertion Protocol

```text
SAMPLE DATA INSERTION ORDER (WITH EXISTING DATA CHECKS)

0. Check for existing data in reused tables
   - Query record counts in each table
   - If data exists, ask user: skip, add more, or replace
   - Collect existing record IDs for use as foreign keys

1. Insert TIER 0 data (reference/lookup tables)
   - Categories, Statuses, Departments, etc.
   - Skip if records with same name already exist
   - Store the returned/existing record IDs for use in foreign keys

2. Insert TIER 1 data with valid lookups
   - Products (with Category lookup)
   - Team Members (with Department lookup)
   - Use the IDs from step 1 for lookup values

3. Insert TIER 2 data with valid lookups
   - Testimonials (with Product lookup)
   - Contact Submissions (with Status lookup)
   - Use IDs from steps 1 and 2 for lookup values

IMPORTANT: Never insert records with invalid/non-existent lookup values!
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
        [string]$NameColumn,  # Usually "cr_name" or the primary name attribute
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
Write-Host "`nChecking existing data in tables..." -ForegroundColor Cyan
$existingDataCounts = @{
    "cr_categories" = Get-ExistingRecordCount -EntitySetName "cr_categories"
    "cr_statuses" = Get-ExistingRecordCount -EntitySetName "cr_statuses"
    "cr_departments" = Get-ExistingRecordCount -EntitySetName "cr_departments"
    "cr_products" = Get-ExistingRecordCount -EntitySetName "cr_products"
    "cr_teammembers" = Get-ExistingRecordCount -EntitySetName "cr_teammembers"
    "cr_testimonials" = Get-ExistingRecordCount -EntitySetName "cr_testimonials"
    "cr_contactsubmissions" = Get-ExistingRecordCount -EntitySetName "cr_contactsubmissions"
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
        [string]$NameColumn = "cr_name"
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

$product = @{
    cr_name = "Professional Consultation"
    cr_description = "One-on-one consultation with our expert team."
    cr_price = 299.99
    # Reference category by its ID
    "cr_categoryid@odata.bind" = "/cr_categories($categoryId)"
}
```

## Complete Sample Data Script

```powershell
# ============================================
# TIER 0: Insert Reference/Lookup Data FIRST
# ============================================

Write-Host "`n=== TIER 0: Processing Reference/Lookup Data ===" -ForegroundColor Magenta

# --- Categories ---
$categoryIds = @{}

$categories = @(
    @{ cr_name = "Services"; cr_description = "Professional services"; cr_displayorder = 1; cr_isactive = $true },
    @{ cr_name = "Packages"; cr_description = "Bundled offerings"; cr_displayorder = 2; cr_isactive = $true },
    @{ cr_name = "Products"; cr_description = "Physical and digital products"; cr_displayorder = 3; cr_isactive = $true }
)

Write-Host "Processing categories..." -ForegroundColor Cyan
foreach ($cat in $categories) {
    $result = New-DataverseRecordIfNotExists -EntitySetName "cr_categories" -Data $cat -NameColumn "cr_name"
    $categoryIds[$cat.cr_name] = $result.Record.cr_categoryid
}

# --- Statuses ---
$statusIds = @{}

$statuses = @(
    @{ cr_name = "New"; cr_displayorder = 1 },
    @{ cr_name = "Reviewed"; cr_displayorder = 2 },
    @{ cr_name = "Responded"; cr_displayorder = 3 },
    @{ cr_name = "Closed"; cr_displayorder = 4 }
)

Write-Host "`nProcessing statuses..." -ForegroundColor Cyan
foreach ($status in $statuses) {
    $result = New-DataverseRecordIfNotExists -EntitySetName "cr_statuses" -Data $status -NameColumn "cr_name"
    $statusIds[$status.cr_name] = $result.Record.cr_statusid
}

# --- Departments ---
$departmentIds = @{}

$departments = @(
    @{ cr_name = "Executive"; cr_code = "EXEC" },
    @{ cr_name = "Engineering"; cr_code = "ENG" },
    @{ cr_name = "Customer Success"; cr_code = "CS" },
    @{ cr_name = "Sales"; cr_code = "SALES" }
)

Write-Host "`nProcessing departments..." -ForegroundColor Cyan
foreach ($dept in $departments) {
    $result = New-DataverseRecordIfNotExists -EntitySetName "cr_departments" -Data $dept -NameColumn "cr_name"
    $departmentIds[$dept.cr_name] = $result.Record.cr_departmentid
}

# ============================================
# TIER 1: Insert Primary Entity Data
# ============================================

Write-Host "`n=== TIER 1: Processing Primary Entity Data ===" -ForegroundColor Magenta

# --- Products (with Category lookup) ---
$productIds = @{}

$products = @(
    @{
        cr_name = "Professional Consultation"
        cr_description = "One-on-one consultation with our expert team."
        cr_price = 299.99
        cr_imageurl = "https://images.unsplash.com/photo-1553877522-43269d4ea984?w=400"
        cr_isactive = $true
        "cr_categoryid@odata.bind" = "/cr_categories($($categoryIds['Services']))"
    },
    @{
        cr_name = "Enterprise Solution Package"
        cr_description = "Complete enterprise solution with 12 months support."
        cr_price = 4999.99
        cr_imageurl = "https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=400"
        cr_isactive = $true
        "cr_categoryid@odata.bind" = "/cr_categories($($categoryIds['Packages']))"
    },
    @{
        cr_name = "Starter Kit"
        cr_description = "Perfect for small businesses getting started."
        cr_price = 99.99
        cr_imageurl = "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=400"
        cr_isactive = $true
        "cr_categoryid@odata.bind" = "/cr_categories($($categoryIds['Packages']))"
    }
)

Write-Host "Processing products..." -ForegroundColor Cyan
foreach ($product in $products) {
    $result = New-DataverseRecordIfNotExists -EntitySetName "cr_products" -Data $product -NameColumn "cr_name"
    $productIds[$product.cr_name] = $result.Record.cr_productid
}

# --- Team Members (with Department lookup) ---
$teamMemberIds = @{}

$team = @(
    @{
        cr_name = "Emily Rodriguez"
        cr_title = "Chief Executive Officer"
        cr_email = "emily.r@company.com"
        cr_bio = "Emily has over 15 years of experience in technology leadership."
        cr_photourl = "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=300"
        cr_linkedin = "https://linkedin.com/in/emilyrodriguez"
        cr_displayorder = 1
        "cr_departmentid@odata.bind" = "/cr_departments($($departmentIds['Executive']))"
    },
    @{
        cr_name = "David Kim"
        cr_title = "Chief Technology Officer"
        cr_email = "david.k@company.com"
        cr_bio = "David brings deep technical expertise from his decade at leading tech companies."
        cr_photourl = "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=300"
        cr_linkedin = "https://linkedin.com/in/davidkim"
        cr_displayorder = 2
        "cr_departmentid@odata.bind" = "/cr_departments($($departmentIds['Engineering']))"
    },
    @{
        cr_name = "Lisa Thompson"
        cr_title = "Head of Customer Success"
        cr_email = "lisa.t@company.com"
        cr_bio = "Lisa ensures our customers achieve their goals."
        cr_photourl = "https://images.unsplash.com/photo-1580489944761-15a19d654956?w=300"
        cr_linkedin = "https://linkedin.com/in/lisathompson"
        cr_displayorder = 3
        "cr_departmentid@odata.bind" = "/cr_departments($($departmentIds['Customer Success']))"
    }
)

Write-Host "`nProcessing team members..." -ForegroundColor Cyan
foreach ($member in $team) {
    $result = New-DataverseRecordIfNotExists -EntitySetName "cr_teammembers" -Data $member -NameColumn "cr_name"
    $teamMemberIds[$member.cr_name] = $result.Record.cr_teammemberid
}

# ============================================
# TIER 2: Insert Dependent Data
# ============================================

Write-Host "`n=== TIER 2: Processing Dependent Data ===" -ForegroundColor Magenta

# --- Contact Submissions (with Status lookup) ---
$contacts = @(
    @{
        cr_name = "John Smith"
        cr_email = "john.smith@example.com"
        cr_message = "I'm interested in learning more about your services."
        cr_submissiondate = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
        "cr_statusid@odata.bind" = "/cr_statuses($($statusIds['New']))"
    },
    @{
        cr_name = "Sarah Johnson"
        cr_email = "sarah.j@company.com"
        cr_message = "Looking for a partner for our upcoming project."
        cr_submissiondate = (Get-Date).AddDays(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
        "cr_statusid@odata.bind" = "/cr_statuses($($statusIds['Reviewed']))"
    },
    @{
        cr_name = "Michael Chen"
        cr_email = "m.chen@startup.io"
        cr_message = "Questions about pricing and availability."
        cr_submissiondate = (Get-Date).AddDays(-5).ToString("yyyy-MM-ddTHH:mm:ssZ")
        "cr_statusid@odata.bind" = "/cr_statuses($($statusIds['Responded']))"
    }
)

Write-Host "Processing contact submissions..." -ForegroundColor Cyan
foreach ($contact in $contacts) {
    New-DataverseRecordIfNotExists -EntitySetName "cr_contactsubmissions" -Data $contact -NameColumn "cr_name"
}

# --- Testimonials (with optional Product lookup) ---
$testimonials = @(
    @{
        cr_name = "Amanda Foster"
        cr_quote = "Their solution increased our efficiency by 40%."
        cr_company = "TechStart Inc."
        cr_role = "Operations Director"
        cr_rating = 5
        cr_photourl = "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200"
        cr_isactive = $true
        "cr_productid@odata.bind" = "/cr_products($($productIds['Enterprise Solution Package']))"
    },
    @{
        cr_name = "Robert Martinez"
        cr_quote = "The best investment we've made this year."
        cr_company = "Global Solutions Ltd"
        cr_role = "CEO"
        cr_rating = 5
        cr_photourl = "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200"
        cr_isactive = $true
        "cr_productid@odata.bind" = "/cr_products($($productIds['Professional Consultation']))"
    },
    @{
        cr_name = "Jennifer Wu"
        cr_quote = "Delivered beyond expectations. Highly recommend."
        cr_company = "Innovate Partners"
        cr_role = "Managing Partner"
        cr_rating = 5
        cr_photourl = "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=200"
        cr_isactive = $true
        # General testimonial - no specific product linked
    }
)

Write-Host "`nProcessing testimonials..." -ForegroundColor Cyan
foreach ($testimonial in $testimonials) {
    New-DataverseRecordIfNotExists -EntitySetName "cr_testimonials" -Data $testimonial -NameColumn "cr_name"
}

Write-Host "`n=== Sample data processing complete ===" -ForegroundColor Green
```

## Verify Data and Relationships

```powershell
# Verify products with their categories (expanded relationship)
Write-Host "Products with Categories:" -ForegroundColor Cyan
$products = Invoke-RestMethod -Uri "$baseUrl/cr_products?`$select=cr_name,cr_price&`$expand=cr_categoryid(`$select=cr_name)" -Headers $headers
$products.value | ForEach-Object {
    Write-Host "  $($_.cr_name) - `$$($_.cr_price) - Category: $($_.cr_categoryid.cr_name)"
}

# Verify team members with their departments
Write-Host "`nTeam Members with Departments:" -ForegroundColor Cyan
$members = Invoke-RestMethod -Uri "$baseUrl/cr_teammembers?`$select=cr_name,cr_title&`$expand=cr_departmentid(`$select=cr_name)" -Headers $headers
$members.value | ForEach-Object {
    Write-Host "  $($_.cr_name) ($($_.cr_title)) - Dept: $($_.cr_departmentid.cr_name)"
}

# Verify contact submissions with their statuses
Write-Host "`nContact Submissions with Statuses:" -ForegroundColor Cyan
$submissions = Invoke-RestMethod -Uri "$baseUrl/cr_contactsubmissions?`$select=cr_name,cr_email&`$expand=cr_statusid(`$select=cr_name)" -Headers $headers
$submissions.value | ForEach-Object {
    Write-Host "  $($_.cr_name) ($($_.cr_email)) - Status: $($_.cr_statusid.cr_name)"
}

# Verify testimonials with their linked products
Write-Host "`nTestimonials with Products:" -ForegroundColor Cyan
$testimonials = Invoke-RestMethod -Uri "$baseUrl/cr_testimonials?`$select=cr_name,cr_company&`$expand=cr_productid(`$select=cr_name)" -Headers $headers
$testimonials.value | ForEach-Object {
    $productName = if ($_.cr_productid) { $_.cr_productid.cr_name } else { "(General)" }
    Write-Host "  $($_.cr_name) from $($_.cr_company) - Product: $productName"
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
Update-DataverseRecord -EntitySetName "cr_products" -RecordId $productIds['Starter Kit'] -Data @{
    cr_price = 129.99
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
