---
description: Setup Dataverse tables and schema for your Power Pages site. Analyzes your site to recommend tables, creates tables using OData Web API, and adds sample data.
user-invocable: true
allowed-tools: Bash(pac:*), Bash(az:*)
model: sonnet
---

# Setup Dataverse Tables

This skill guides makers through setting up Dataverse tables and schema for their Power Pages site. It analyzes the site created in the previous step, recommends appropriate tables, and helps create them with sample data.

**IMPORTANT**: This skill takes a **data architecture approach** - it analyzes table relationships, builds a dependency graph, and creates tables in the correct topological order (referenced tables first, then dependent tables). This ensures referential integrity and follows enterprise data modeling best practices.

## Memory Bank

This skill uses a **memory bank** (`memory-bank.md`) to persist context across sessions.

**Follow the instructions in `${CLAUDE_PLUGIN_ROOT}/shared/memory-bank.md`** for:
- Checking and reading the memory bank before starting
- Skipping completed steps and resuming progress
- Updating the memory bank after each major step

## Workflow Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: Resume or Start Fresh                                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Check if continuing from /create-site                                    │
│  • Identify existing site project path                                      │
│  • Offer to proceed or show resume command                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: Analyze Site & Design Data Architecture                            │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Read site source code and configuration                                  │
│  • Identify data requirements from components                               │
│  • Design entity-relationship model with proper normalization               │
│  • Document table relationships (1:N, N:N, self-referential)                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: Build Dependency Graph & Determine Creation Order                  │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Analyze foreign key relationships                                        │
│  • Perform topological sort to determine creation order                     │
│  • Identify reference/lookup tables (create first)                          │
│  • Identify dependent tables (create after their references)                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: Set Up OData Web API Authentication                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Configure Azure CLI authentication                                       │
│  • Get environment URL and access token                                     │
│  • Set up API headers for Dataverse calls                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 5: Review Existing Tables & Identify Reusable Tables                  │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Query all existing custom tables in the environment                      │
│  • Compare existing tables against recommended schema                       │
│  • Identify tables that can be reused (matching or similar schema)          │
│  • Present options: reuse existing, extend existing, or create new          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 6: Create/Extend Tables in Dependency Order                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Skip tables marked for reuse                                             │
│  • Extend existing tables with missing columns if needed                    │
│  • Create only new tables that don't exist                                  │
│  • Add relationship columns (lookups) after both tables exist               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 7: Add Sample Data with Referential Integrity                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Check for existing data in reused tables                                 │
│  • Insert reference/lookup data first (skip if exists)                      │
│  • Insert dependent records with valid foreign keys                         │
│  • Verify relationships are correctly established                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
                        Next: /setup-webapi skill
```

---

## Data Architecture Principles

**CRITICAL**: Before creating any tables, you MUST design a proper data architecture. This means:

### 1. Entity-Relationship Analysis

Identify all entities and their relationships:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  RELATIONSHIP TYPES IN DATAVERSE                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1:N (One-to-Many) - Most common                                            │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Parent table referenced by child table via Lookup column                 │
│  • Example: Category (1) → Products (N)                                     │
│  • Parent must exist before child can reference it                          │
│                                                                             │
│  N:N (Many-to-Many)                                                         │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Junction/intersection table created automatically                        │
│  • Example: Products ↔ Tags                                                 │
│  • Both tables must exist before creating the relationship                  │
│                                                                             │
│  Self-Referential                                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Table references itself                                                  │
│  • Example: Employee → Manager (also an Employee)                           │
│  • Table must exist before adding self-referential lookup                   │
│                                                                             │
│  Polymorphic (Customer/Regarding)                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Single column can reference multiple table types                         │
│  • Example: Activity regarding Contact OR Account OR Lead                   │
│  • All target tables must exist before creating polymorphic lookup          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2. Table Classification

Classify tables into tiers based on their dependencies:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  TABLE DEPENDENCY TIERS                                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  TIER 0: Reference/Lookup Tables (Create FIRST)                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • No foreign keys to other custom tables                                   │
│  • Examples: Category, Status, Country, Department, Tag                     │
│  • These are the "dictionaries" of your data model                          │
│                                                                             │
│  TIER 1: Primary Entity Tables (Create SECOND)                              │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Only reference Tier 0 tables or system tables                            │
│  • Examples: Product (→Category), Employee (→Department)                    │
│  • Core business entities                                                   │
│                                                                             │
│  TIER 2: Dependent/Transaction Tables (Create THIRD)                        │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Reference Tier 1 tables                                                  │
│  • Examples: Order (→Customer), OrderLine (→Order, →Product)                │
│  • Often transactional or junction tables                                   │
│                                                                             │
│  TIER 3: Deeply Nested Tables (Create LAST)                                 │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Reference Tier 2 tables                                                  │
│  • Examples: OrderLineDetail (→OrderLine), PaymentAllocation (→Payment)     │
│  • Rare in typical Power Pages sites                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3. Dependency Graph Documentation

**Always document the dependency graph before creating tables:**

```text
Example: E-Commerce Site Data Architecture

                    ┌─────────────┐
                    │  Category   │  TIER 0
                    │  (lookup)   │
                    └──────┬──────┘
                           │
           ┌───────────────┼───────────────┐
           ↓               ↓               ↓
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │   Product    │ │   Supplier   │ │   Customer   │  TIER 1
    │ (→Category)  │ │              │ │              │
    └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
           │               │               │
           └───────────────┼───────────────┘
                           ↓
                    ┌──────────────┐
                    │    Order     │  TIER 2
                    │ (→Customer)  │
                    └──────┬───────┘
                           │
                           ↓
                    ┌──────────────┐
                    │  OrderLine   │  TIER 3
                    │(→Order,      │
                    │ →Product)    │
                    └──────────────┘

Creation Order: Category → Product, Supplier, Customer → Order → OrderLine
```

### 4. Common Relationship Patterns for Power Pages Sites

| Site Feature | Tables | Relationships |
|--------------|--------|---------------|
| **Blog** | Category, Author, BlogPost, Comment | Category(0) → BlogPost(1) → Comment(2); Author(0) → BlogPost(1) |
| **E-commerce** | Category, Product, Customer, Order, OrderLine | Category(0) → Product(1); Customer(1) → Order(2) → OrderLine(3) ← Product(1) |
| **Event Registration** | EventType, Event, Attendee, Registration | EventType(0) → Event(1); Attendee(1) → Registration(2) ← Event(1) |
| **Support Portal** | Category, Priority, Ticket, Comment | Category(0), Priority(0) → Ticket(1) → Comment(2) |
| **Directory/Listing** | Category, Location, Listing, Review | Category(0), Location(0) → Listing(1) → Review(2) |
| **Job Board** | Department, JobType, JobPosting, Application | Department(0), JobType(0) → JobPosting(1) → Application(2) |

---

## STEP 1: Resume or Start Fresh

### Check Memory Bank First

**Before asking questions**, check if a memory bank exists:

1. If continuing from `/create-site` in the same session, use the known project path
2. Otherwise, ask the user for the project path
3. Read `<PROJECT_PATH>/memory-bank.md` if it exists
4. Extract:
   - Project name and framework
   - Site features (to recommend appropriate tables)
   - Any previously chosen preferences
   - Whether this skill was already partially completed

If the memory bank shows `/setup-dataverse` steps already completed:

- Inform the user what was done
- Ask if they want to add more tables, modify existing ones, or skip to next steps

### Check Context

First, determine if the user is continuing from `/create-site` or starting fresh.

**If continuing from create-site:**

Show this message:

> **Ready for Next Step!**
>
> Your Power Pages site has been created. Now let's set up the Dataverse tables to store and manage your site's data.
>
> Would you like to proceed with setting up Dataverse tables for your site?

Use the `AskUserQuestion` tool with these options:

| Option | Description |
|--------|-------------|
| **Yes, proceed** | Continue to analyze the site and set up tables |
| **Show me the command** | Display the command to run this skill later: `/setup-dataverse` |
| **Not now** | Exit and save progress for later |

**If starting fresh (no prior context):**

Ask the user:

> To set up Dataverse tables, I need to know about your Power Pages site.
>
> Do you have an existing site project, or would you like to create one first?

| Option | Description |
|--------|-------------|
| **I have an existing site** | Provide the path to your site project |
| **Create a site first** | Run `/create-site` to create a new Power Pages site |

If they have an existing site, ask for the project path using `AskUserQuestion`.

### Resume Command

If the user selects "Show me the command", display:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  Resume Command                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Run this command when you're ready to continue:                            │
│                                                                             │
│    /setup-dataverse                                                         │
│                                                                             │
│  Or type: "Set up Dataverse tables for my Power Pages site"                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## STEP 2: Analyze Site & Design Data Architecture

### Read Site Configuration

Read the site's source code to understand data requirements:

1. **Read powerpages.config.json** to get site name and structure
2. **Scan component files** for data patterns:
   - Forms (contact forms, registration forms, feedback forms)
   - Lists/Tables (product listings, team members, services)
   - Cards (testimonials, portfolio items, blog posts)
   - User data (profiles, preferences, submissions)

### Identify Data Requirements

Look for these patterns in the code:

| Pattern | Recommended Table | Likely Relationships |
|---------|-------------------|---------------------|
| Contact form with name, email, message | `cr_contactsubmission` | → `cr_contactstatus` (lookup) |
| Product/service cards with categories | `cr_product` or `cr_service` | → `cr_category` (lookup) |
| Team member section with departments | `cr_teammember` | → `cr_department` (lookup) |
| Testimonials/Reviews | `cr_testimonial` | → `cr_product` or `cr_service` (optional) |
| Blog/News section | `cr_blogpost` | → `cr_category`, → `cr_author` |
| FAQ section with categories | `cr_faq` | → `cr_faqcategory` (lookup) |
| Event listings | `cr_event` | → `cr_eventtype`, → `cr_location` |
| Portfolio/Gallery items | `cr_portfolioitem` | → `cr_category` |
| User feedback/Surveys | `cr_feedback` | → `cr_feedbacktype` (lookup) |

### Design Entity-Relationship Model

**CRITICAL**: Before recommending tables, design a complete ER model:

1. **Identify all entities** (both main tables and lookup/reference tables)
2. **Identify relationships** between entities
3. **Normalize the data** (avoid storing the same data in multiple places)
4. **Document the dependency graph**

Example analysis output format:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  DATA ARCHITECTURE FOR: [Site Name]                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  TIER 0 - Reference Tables (No Dependencies)                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  1. cr_category        - Product/content categories                         │
│  2. cr_status          - Status values for various entities                 │
│  3. cr_department      - Team member departments                            │
│                                                                             │
│  TIER 1 - Primary Entity Tables                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  4. cr_product         - Products (→ cr_category)                           │
│  5. cr_teammember      - Team members (→ cr_department)                     │
│  6. cr_blogpost        - Blog posts (→ cr_category)                         │
│                                                                             │
│  TIER 2 - Dependent Tables                                                  │
│  ─────────────────────────────────────────────────────────────────────────  │
│  7. cr_testimonial     - Testimonials (→ cr_product, optional)              │
│  8. cr_contactsubmission - Contact submissions (→ cr_status)                │
│                                                                             │
│  RELATIONSHIP DIAGRAM                                                       │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│    cr_category ──┬──→ cr_product ───→ cr_testimonial                        │
│                  └──→ cr_blogpost                                           │
│                                                                             │
│    cr_department ───→ cr_teammember                                         │
│                                                                             │
│    cr_status ───────→ cr_contactsubmission                                  │
│                                                                             │
│  CREATION ORDER                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│  1. cr_category, cr_status, cr_department (parallel - no deps)              │
│  2. cr_product, cr_teammember, cr_blogpost (after tier 0)                   │
│  3. cr_testimonial, cr_contactsubmission (after their references)           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Present Architecture Recommendations

After analysis, present the complete data architecture using `AskUserQuestion`:

> **Data Architecture for Your Site**
>
> Based on your site's features, I've designed the following data architecture:
>
> **Reference Tables (created first):**
> - [List lookup/reference tables]
>
> **Primary Entity Tables:**
> - [List main tables with their relationships]
>
> **Dependent Tables:**
> - [List tables that depend on others]
>
> **Relationship Summary:**
> - [Describe key relationships]
>
> Would you like to proceed with this architecture?

| Option | Description |
|--------|-------------|
| **Yes, create these tables** | Proceed with recommended architecture |
| **Modify the schema** | Let me adjust columns, tables, or relationships |
| **Show me the full diagram** | Display complete ER diagram before proceeding |

---

## STEP 3: Build Dependency Graph & Validate Creation Order

Before creating any tables, validate the creation order:

### Dependency Analysis Algorithm

```text
1. List all tables and their lookup columns
2. Build adjacency list: for each table, list tables it depends on
3. Perform topological sort to get valid creation order
4. If cycle detected, report error (invalid schema design)
5. Group tables by tier for parallel creation where possible
```

### Example Dependency Resolution

```powershell
# Example: Building dependency graph in PowerShell
$tables = @{
    "cr_category" = @()                           # No dependencies - TIER 0
    "cr_status" = @()                             # No dependencies - TIER 0
    "cr_department" = @()                         # No dependencies - TIER 0
    "cr_product" = @("cr_category")               # Depends on category - TIER 1
    "cr_teammember" = @("cr_department")          # Depends on department - TIER 1
    "cr_testimonial" = @("cr_product")            # Depends on product - TIER 2
    "cr_contactsubmission" = @("cr_status")       # Depends on status - TIER 1
}

# Topological sort result (creation order):
# 1. cr_category, cr_status, cr_department (can be parallel)
# 2. cr_product, cr_teammember, cr_contactsubmission (after their deps)
# 3. cr_testimonial (after cr_product)
```

### Validation Rules

Before proceeding to table creation, validate:

1. **No circular dependencies** - A cannot depend on B if B depends on A
2. **All referenced tables exist** - Either in schema or as system tables
3. **Lookup targets are valid** - Table being referenced must have a primary key
4. **Self-references are handled** - Table created first, then self-lookup added

---

## STEP 4: Set Up OData Web API Authentication

This skill uses the Dataverse OData Web API for all table and data operations. Operations will use:

1. **Dataverse Web API** for table creation, schema management, and data operations
2. **Azure CLI** for authentication (`az account get-access-token`)
3. **PowerShell** for scripting API calls
4. **Client-side `/_api/` calls** from the Power Pages site for runtime data access

Ensure Azure CLI is authenticated before proceeding:

```powershell
# Verify Azure CLI is logged in
az account show

# If not logged in, run:
az login
```

---

## STEP 5: Review Existing Tables & Identify Reusable Tables

**CRITICAL**: Before creating any tables, you MUST review existing tables in the Dataverse environment. This prevents duplicate tables, leverages existing schema, and follows best practices for enterprise data management.

### Query Existing Custom Tables

Use the Dataverse Web API to retrieve all existing custom tables:

```powershell
# Get all custom tables (entities) in the environment
# Custom tables typically have a publisher prefix (e.g., cr_, new_, contoso_)

$existingTables = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions?`$filter=IsCustomEntity eq true&`$select=SchemaName,LogicalName,DisplayName,Description,PrimaryNameAttribute" -Headers $headers

Write-Host "Found $($existingTables.value.Count) custom tables in the environment:" -ForegroundColor Cyan
$existingTables.value | ForEach-Object {
    $displayName = $_.DisplayName.UserLocalizedLabel.Label
    Write-Host "  - $($_.SchemaName) ($displayName)" -ForegroundColor Yellow
}
```

### Get Table Details with Columns

For each potentially reusable table, retrieve its columns to compare against your schema:

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

# Example: Check if a category table already exists
$existingCategory = Get-TableSchema -TableLogicalName "cr_category"
```

### Compare Existing vs Required Tables

Build a comparison matrix to identify reusable tables:

```powershell
function Compare-TableSchemas {
    param(
        [hashtable]$RequiredTables,  # Schema name -> array of required columns
        [array]$ExistingTables       # From EntityDefinitions query
    )

    $comparison = @{
        Reusable = @()      # Existing tables that match or exceed requirements
        Extendable = @()    # Existing tables that need additional columns
        CreateNew = @()     # Tables that don't exist and must be created
    }

    foreach ($tableName in $RequiredTables.Keys) {
        $existing = $ExistingTables | Where-Object { $_.SchemaName -eq $tableName -or $_.LogicalName -eq $tableName }

        if ($existing) {
            # Table exists - check if it has all required columns
            $tableSchema = Get-TableSchema -TableLogicalName $existing.LogicalName
            $existingColumns = $tableSchema.Attributes | Select-Object -ExpandProperty SchemaName
            $requiredColumns = $RequiredTables[$tableName]

            $missingColumns = $requiredColumns | Where-Object { $_ -notin $existingColumns }

            if ($missingColumns.Count -eq 0) {
                $comparison.Reusable += @{
                    TableName = $tableName
                    ExistingTable = $existing
                    Message = "All required columns present"
                }
            } else {
                $comparison.Extendable += @{
                    TableName = $tableName
                    ExistingTable = $existing
                    MissingColumns = $missingColumns
                    Message = "Missing columns: $($missingColumns -join ', ')"
                }
            }
        } else {
            $comparison.CreateNew += @{
                TableName = $tableName
                RequiredColumns = $RequiredTables[$tableName]
            }
        }
    }

    return $comparison
}

# Example usage
$requiredTables = @{
    "cr_category" = @("cr_name", "cr_description", "cr_displayorder", "cr_isactive")
    "cr_product" = @("cr_name", "cr_description", "cr_price", "cr_imageurl", "cr_categoryid")
    "cr_contactsubmission" = @("cr_name", "cr_email", "cr_message", "cr_submissiondate")
}

$comparison = Compare-TableSchemas -RequiredTables $requiredTables -ExistingTables $existingTables.value
```

### Present Reuse Options

After comparing schemas, present the findings to the user:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  EXISTING TABLE ANALYSIS                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ✅ REUSABLE (no changes needed):                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • cr_category - Has all required columns                                   │
│  • cr_status - Has all required columns                                     │
│                                                                             │
│  🔧 EXTENDABLE (need additional columns):                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • cr_product - Missing: cr_imageurl, cr_isactive                           │
│  • cr_teammember - Missing: cr_linkedin, cr_displayorder                    │
│                                                                             │
│  🆕 CREATE NEW (don't exist):                                               │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • cr_testimonial                                                           │
│  • cr_contactsubmission                                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Use `AskUserQuestion` to confirm the approach:

> **Existing Tables Found**
>
> I found existing tables that may be reused. Here's my recommendation:
>
> **Reuse as-is:** cr_category, cr_status
> **Extend with new columns:** cr_product (needs: cr_imageurl, cr_isactive)
> **Create new:** cr_testimonial, cr_contactsubmission
>
> How would you like to proceed?

| Option | Description |
|--------|-------------|
| **Use recommendations** | Reuse existing tables, extend where needed, create only new tables |
| **Create all new** | Create new tables with unique names (e.g., cr_site_category) |
| **Review each table** | Let me decide for each table individually |

### Check for Similar Tables

Sometimes tables exist with different names but similar purposes. Search for these:

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

# Example: Find tables that might serve as category tables
$similarCategories = Find-SimilarTables -Purpose "category" -ExistingTables $existingTables.value
if ($similarCategories) {
    Write-Host "Found similar tables that could be used for categories:" -ForegroundColor Yellow
    $similarCategories | ForEach-Object {
        Write-Host "  - $($_.SchemaName): $($_.DisplayName.UserLocalizedLabel.Label)"
    }
}
```

### Check Existing Relationships

When reusing tables, verify existing relationships don't conflict:

```powershell
function Get-TableRelationships {
    param([string]$TableLogicalName)

    # Get 1:N relationships where this table is referenced
    $oneToMany = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableLogicalName')/OneToManyRelationships" -Headers $headers

    # Get N:1 relationships where this table references others
    $manyToOne = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$TableLogicalName')/ManyToOneRelationships" -Headers $headers

    Write-Host "`nRelationships for $TableLogicalName:" -ForegroundColor Cyan

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

### Update Memory Bank with Reuse Decisions

Document which tables are being reused vs created:

```markdown
### Table Decisions

| Required Table | Decision | Existing Table | Notes |
|----------------|----------|----------------|-------|
| cr_category | REUSE | cr_category | All columns present |
| cr_product | EXTEND | cr_product | Adding cr_imageurl, cr_isactive |
| cr_testimonial | CREATE | - | New table |
| cr_contactsubmission | REUSE | cr_inquiry | Renaming to match site usage |
```

---

## STEP 6: Create/Extend Tables in Dependency Order

**CRITICAL**: Based on the analysis from STEP 5, create only new tables and extend existing tables as needed. Tables marked for reuse should be skipped.

### Creation/Extension Protocol

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  TABLE CREATION/EXTENSION PROTOCOL                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PHASE 1: Process tables based on STEP 5 decisions                          │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • REUSABLE tables: Skip creation, use existing table                       │
│  • EXTENDABLE tables: Add missing columns to existing table                 │
│  • CREATE NEW tables: Create in dependency order (TIER 0 → TIER 1 → ...)    │
│                                                                             │
│  PHASE 2: Add non-lookup columns                                            │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • For NEW tables: Add all required columns                                 │
│  • For EXTENDED tables: Add only missing columns                            │
│  • Skip columns that already exist                                          │
│                                                                             │
│  PHASE 3: Create/verify relationships (lookup columns)                      │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Check if relationship already exists before creating                     │
│  • Create only missing relationships                                        │
│  • Verify existing relationships point to correct tables                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Helper Function: Check If Table Exists

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

### Safe Table Creation (Skip If Exists)

```powershell
function New-DataverseTableIfNotExists {
    param(
        [string]$SchemaName,
        [string]$DisplayName,
        [string]$PluralDisplayName,
        [string]$Description = "",
        [string]$PrimaryColumnName = "cr_name",
        [string]$PrimaryColumnDisplayName = "Name"
    )

    $logicalName = $SchemaName.ToLower()

    if (Test-TableExists -TableLogicalName $logicalName) {
        Write-Host "  ⏭️  Table '$SchemaName' already exists - skipping creation" -ForegroundColor Yellow
        return @{ Skipped = $true; Reason = "Already exists" }
    }

    Write-Host "  🆕 Creating table '$SchemaName'..." -ForegroundColor Cyan
    $result = New-DataverseTable -SchemaName $SchemaName -DisplayName $DisplayName `
        -PluralDisplayName $PluralDisplayName -Description $Description `
        -PrimaryColumnName $PrimaryColumnName -PrimaryColumnDisplayName $PrimaryColumnDisplayName

    Write-Host "  ✅ Table '$SchemaName' created successfully" -ForegroundColor Green
    return @{ Skipped = $false; Result = $result }
}
```

### Safe Column Addition (Skip If Exists)

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
        Write-Host "    ⏭️  Column '$SchemaName' already exists on '$TableName' - skipping" -ForegroundColor Yellow
        return @{ Skipped = $true; Reason = "Already exists" }
    }

    Write-Host "    🆕 Adding column '$SchemaName' to '$TableName'..." -ForegroundColor Cyan
    $result = Add-DataverseColumn -TableName $TableName -SchemaName $SchemaName `
        -DisplayName $DisplayName -Type $Type -MaxLength $MaxLength

    Write-Host "    ✅ Column '$SchemaName' added successfully" -ForegroundColor Green
    return @{ Skipped = $false; Result = $result }
}
```

### Safe Relationship Creation (Skip If Exists)

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
        Write-Host "    ⏭️  Relationship '$RelationshipName' already exists - skipping" -ForegroundColor Yellow
        return @{ Skipped = $true; Reason = "Already exists" }
    }

    # Also check if the lookup column already exists (might be from a different relationship)
    $lookupLogicalName = $LookupSchemaName.ToLower()
    $sourceLogicalName = $SourceTable.ToLower()

    if (Test-ColumnExists -TableLogicalName $sourceLogicalName -ColumnLogicalName $lookupLogicalName) {
        Write-Host "    ⏭️  Lookup column '$LookupSchemaName' already exists on '$SourceTable' - skipping" -ForegroundColor Yellow
        return @{ Skipped = $true; Reason = "Lookup column already exists" }
    }

    Write-Host "    🆕 Creating relationship '$RelationshipName' ($SourceTable → $TargetTable)..." -ForegroundColor Cyan
    $result = Add-DataverseLookup -SourceTable $SourceTable -TargetTable $TargetTable `
        -LookupSchemaName $LookupSchemaName -LookupDisplayName $LookupDisplayName `
        -RelationshipName $RelationshipName

    Write-Host "    ✅ Relationship '$RelationshipName' created successfully" -ForegroundColor Green
    return @{ Skipped = $false; Result = $result }
}
```

### Set Up API Connection

Create tables using the Dataverse Web API. First, set up the API connection:

```powershell
# Get the environment URL
pac org who

# Get access token using Azure CLI
$envUrl = "https://<org>.crm.dynamics.com"  # Replace with your org URL
$token = (az account get-access-token --resource $envUrl --query accessToken -o tsv)

# Set up headers for API calls
$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
    "OData-MaxVersion" = "4.0"
    "OData-Version" = "4.0"
    "MSCRM.SolutionUniqueName" = "YourSolutionName"  # Optional: add to a solution
}

$baseUrl = "$envUrl/api/data/v9.2"
```

#### Example: Create Contact Submission Table

```powershell
# Create the table (entity)
$tableDefinition = @{
    "@odata.type" = "Microsoft.Dynamics.CRM.EntityMetadata"
    "SchemaName" = "cr_contactsubmission"
    "DisplayName" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{
                "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"
                "Label" = "Contact Submission"
                "LanguageCode" = 1033
            }
        )
    }
    "DisplayCollectionName" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{
                "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"
                "Label" = "Contact Submissions"
                "LanguageCode" = 1033
            }
        )
    }
    "Description" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{
                "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"
                "Label" = "Stores contact form submissions from the website"
                "LanguageCode" = 1033
            }
        )
    }
    "OwnershipType" = "UserOwned"
    "HasNotes" = $false
    "HasActivities" = $false
    "PrimaryNameAttribute" = "cr_name"
    "Attributes" = @(
        @{
            "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"
            "SchemaName" = "cr_name"
            "AttributeType" = "String"
            "FormatName" = @{ "Value" = "Text" }
            "MaxLength" = 100
            "DisplayName" = @{
                "@odata.type" = "Microsoft.Dynamics.CRM.Label"
                "LocalizedLabels" = @(
                    @{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Name"; "LanguageCode" = 1033 }
                )
            }
            "IsPrimaryName" = $true
        }
    )
}

$body = $tableDefinition | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions" -Method Post -Headers $headers -Body $body
```

#### Add Columns to Existing Table

```powershell
# Add email column
$emailColumn = @{
    "@odata.type" = "Microsoft.Dynamics.CRM.StringAttributeMetadata"
    "SchemaName" = "cr_email"
    "AttributeType" = "String"
    "FormatName" = @{ "Value" = "Email" }
    "MaxLength" = 100
    "DisplayName" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Email"; "LanguageCode" = 1033 }
        )
    }
}

# Get table's LogicalName or use EntitySetName
$tableName = "cr_contactsubmission"
Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$tableName')/Attributes" -Method Post -Headers $headers -Body ($emailColumn | ConvertTo-Json -Depth 10)

# Add message column (multiline text)
$messageColumn = @{
    "@odata.type" = "Microsoft.Dynamics.CRM.MemoAttributeMetadata"
    "SchemaName" = "cr_message"
    "AttributeType" = "Memo"
    "MaxLength" = 4000
    "DisplayName" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Message"; "LanguageCode" = 1033 }
        )
    }
}
Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$tableName')/Attributes" -Method Post -Headers $headers -Body ($messageColumn | ConvertTo-Json -Depth 10)

# Add submission date column
$dateColumn = @{
    "@odata.type" = "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata"
    "SchemaName" = "cr_submissiondate"
    "AttributeType" = "DateTime"
    "Format" = "DateAndTime"
    "DisplayName" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Submission Date"; "LanguageCode" = 1033 }
        )
    }
}
Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$tableName')/Attributes" -Method Post -Headers $headers -Body ($dateColumn | ConvertTo-Json -Depth 10)

# Add status choice column
$statusColumn = @{
    "@odata.type" = "Microsoft.Dynamics.CRM.PicklistAttributeMetadata"
    "SchemaName" = "cr_status"
    "AttributeType" = "Picklist"
    "DisplayName" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.Label"
        "LocalizedLabels" = @(
            @{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Status"; "LanguageCode" = 1033 }
        )
    }
    "OptionSet" = @{
        "@odata.type" = "Microsoft.Dynamics.CRM.OptionSetMetadata"
        "IsGlobal" = $false
        "OptionSetType" = "Picklist"
        "Options" = @(
            @{ "Value" = 1; "Label" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.Label"; "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "New"; "LanguageCode" = 1033 }) } }
            @{ "Value" = 2; "Label" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.Label"; "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Reviewed"; "LanguageCode" = 1033 }) } }
            @{ "Value" = 3; "Label" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.Label"; "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Responded"; "LanguageCode" = 1033 }) } }
            @{ "Value" = 4; "Label" = @{ "@odata.type" = "Microsoft.Dynamics.CRM.Label"; "LocalizedLabels" = @(@{ "@odata.type" = "Microsoft.Dynamics.CRM.LocalizedLabel"; "Label" = "Closed"; "LanguageCode" = 1033 }) } }
        )
    }
}
Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='$tableName')/Attributes" -Method Post -Headers $headers -Body ($statusColumn | ConvertTo-Json -Depth 10)
```

### Helper Function for Table Creation

To simplify table creation, use this helper function:

```powershell
function New-DataverseTable {
    param(
        [string]$SchemaName,
        [string]$DisplayName,
        [string]$PluralDisplayName,
        [string]$Description = "",
        [string]$PrimaryColumnName = "cr_name",
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

function Add-DataverseColumn {
    param(
        [string]$TableName,
        [string]$SchemaName,
        [string]$DisplayName,
        [string]$Type,  # String, Memo, Integer, Decimal, Money, DateTime, Boolean, Url
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

function Add-DataverseLookup {
    param(
        [string]$SourceTable,           # Table that will have the lookup column
        [string]$TargetTable,           # Table being referenced (must exist first!)
        [string]$LookupSchemaName,      # Schema name for the lookup column
        [string]$LookupDisplayName,     # Display name for the lookup column
        [string]$RelationshipName       # Unique name for the relationship
    )

    # Create a 1:N relationship (Many source records → One target record)
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

---

### Dependency-Ordered Creation Example (With Reuse Checks)

Here's a complete example showing proper creation order with existing table checks:

```powershell
# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 1: Create/Skip tables based on STEP 5 decisions
# ═══════════════════════════════════════════════════════════════════════════════

Write-Host "`n════════════════════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "PHASE 1: Processing Tables (Create New / Skip Existing)" -ForegroundColor Magenta
Write-Host "════════════════════════════════════════════════════════════════`n" -ForegroundColor Magenta

# --- TIER 0: Reference/Lookup Tables (no dependencies) ---
Write-Host "Processing TIER 0 tables (Reference/Lookup)..." -ForegroundColor Cyan

New-DataverseTableIfNotExists -SchemaName "cr_category" -DisplayName "Category" -PluralDisplayName "Categories" `
    -Description "Product and content categories"

New-DataverseTableIfNotExists -SchemaName "cr_department" -DisplayName "Department" -PluralDisplayName "Departments" `
    -Description "Organization departments"

New-DataverseTableIfNotExists -SchemaName "cr_status" -DisplayName "Status" -PluralDisplayName "Statuses" `
    -Description "Status values for various entities"

# --- TIER 1: Primary Entity Tables (depend only on TIER 0) ---
Write-Host "`nProcessing TIER 1 tables (Primary Entities)..." -ForegroundColor Cyan

New-DataverseTableIfNotExists -SchemaName "cr_product" -DisplayName "Product" -PluralDisplayName "Products" `
    -Description "Products and services offered"

New-DataverseTableIfNotExists -SchemaName "cr_teammember" -DisplayName "Team Member" -PluralDisplayName "Team Members" `
    -Description "Team members displayed on the website"

# --- TIER 2: Dependent Tables (depend on TIER 1) ---
Write-Host "`nProcessing TIER 2 tables (Dependent)..." -ForegroundColor Cyan

New-DataverseTableIfNotExists -SchemaName "cr_testimonial" -DisplayName "Testimonial" -PluralDisplayName "Testimonials" `
    -Description "Customer testimonials and reviews"

New-DataverseTableIfNotExists -SchemaName "cr_contactsubmission" -DisplayName "Contact Submission" -PluralDisplayName "Contact Submissions" `
    -Description "Contact form submissions from the website"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Add/Skip columns (only adds missing columns)
# ═══════════════════════════════════════════════════════════════════════════════

Write-Host "`n════════════════════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "PHASE 2: Processing Columns (Add Missing / Skip Existing)" -ForegroundColor Magenta
Write-Host "════════════════════════════════════════════════════════════════`n" -ForegroundColor Magenta

# Category columns
Write-Host "Processing columns for cr_category..." -ForegroundColor Cyan
Add-DataverseColumnIfNotExists -TableName "cr_category" -SchemaName "cr_description" -DisplayName "Description" -Type "Memo" -MaxLength 1000
Add-DataverseColumnIfNotExists -TableName "cr_category" -SchemaName "cr_displayorder" -DisplayName "Display Order" -Type "Integer"
Add-DataverseColumnIfNotExists -TableName "cr_category" -SchemaName "cr_isactive" -DisplayName "Is Active" -Type "Boolean"

# Department columns
Write-Host "`nProcessing columns for cr_department..." -ForegroundColor Cyan
Add-DataverseColumnIfNotExists -TableName "cr_department" -SchemaName "cr_code" -DisplayName "Code" -Type "String" -MaxLength 10

# Product columns (non-lookup)
Write-Host "`nProcessing columns for cr_product..." -ForegroundColor Cyan
Add-DataverseColumnIfNotExists -TableName "cr_product" -SchemaName "cr_description" -DisplayName "Description" -Type "Memo" -MaxLength 4000
Add-DataverseColumnIfNotExists -TableName "cr_product" -SchemaName "cr_price" -DisplayName "Price" -Type "Money"
Add-DataverseColumnIfNotExists -TableName "cr_product" -SchemaName "cr_imageurl" -DisplayName "Image URL" -Type "Url"
Add-DataverseColumnIfNotExists -TableName "cr_product" -SchemaName "cr_isactive" -DisplayName "Is Active" -Type "Boolean"

# Team Member columns (non-lookup)
Write-Host "`nProcessing columns for cr_teammember..." -ForegroundColor Cyan
Add-DataverseColumnIfNotExists -TableName "cr_teammember" -SchemaName "cr_title" -DisplayName "Job Title" -Type "String"
Add-DataverseColumnIfNotExists -TableName "cr_teammember" -SchemaName "cr_email" -DisplayName "Email" -Type "Email"
Add-DataverseColumnIfNotExists -TableName "cr_teammember" -SchemaName "cr_bio" -DisplayName "Bio" -Type "Memo" -MaxLength 4000

# Testimonial columns (non-lookup)
Write-Host "`nProcessing columns for cr_testimonial..." -ForegroundColor Cyan
Add-DataverseColumnIfNotExists -TableName "cr_testimonial" -SchemaName "cr_quote" -DisplayName "Quote" -Type "Memo" -MaxLength 2000
Add-DataverseColumnIfNotExists -TableName "cr_testimonial" -SchemaName "cr_company" -DisplayName "Company" -Type "String"
Add-DataverseColumnIfNotExists -TableName "cr_testimonial" -SchemaName "cr_rating" -DisplayName "Rating" -Type "Integer"

# Contact Submission columns (non-lookup)
Write-Host "`nProcessing columns for cr_contactsubmission..." -ForegroundColor Cyan
Add-DataverseColumnIfNotExists -TableName "cr_contactsubmission" -SchemaName "cr_email" -DisplayName "Email" -Type "Email"
Add-DataverseColumnIfNotExists -TableName "cr_contactsubmission" -SchemaName "cr_message" -DisplayName "Message" -Type "Memo" -MaxLength 4000
Add-DataverseColumnIfNotExists -TableName "cr_contactsubmission" -SchemaName "cr_submissiondate" -DisplayName "Submission Date" -Type "DateTime"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3: Create/Skip relationships (only creates missing relationships)
# ═══════════════════════════════════════════════════════════════════════════════

Write-Host "`n════════════════════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "PHASE 3: Processing Relationships (Create Missing / Skip Existing)" -ForegroundColor Magenta
Write-Host "════════════════════════════════════════════════════════════════`n" -ForegroundColor Magenta

# --- First: Lookups from TIER 1 → TIER 0 ---
Write-Host "Processing TIER 1 → TIER 0 relationships..." -ForegroundColor Cyan

# Product → Category
Add-DataverseLookupIfNotExists -SourceTable "cr_product" -TargetTable "cr_category" `
    -LookupSchemaName "cr_categoryid" -LookupDisplayName "Category" `
    -RelationshipName "cr_category_product"

# Team Member → Department
Add-DataverseLookupIfNotExists -SourceTable "cr_teammember" -TargetTable "cr_department" `
    -LookupSchemaName "cr_departmentid" -LookupDisplayName "Department" `
    -RelationshipName "cr_department_teammember"

# Contact Submission → Status
Add-DataverseLookupIfNotExists -SourceTable "cr_contactsubmission" -TargetTable "cr_status" `
    -LookupSchemaName "cr_statusid" -LookupDisplayName "Status" `
    -RelationshipName "cr_status_contactsubmission"

# --- Then: Lookups from TIER 2 → TIER 1 ---
Write-Host "`nProcessing TIER 2 → TIER 1 relationships..." -ForegroundColor Cyan

# Testimonial → Product (optional relationship for product-specific testimonials)
Add-DataverseLookupIfNotExists -SourceTable "cr_testimonial" -TargetTable "cr_product" `
    -LookupSchemaName "cr_productid" -LookupDisplayName "Related Product" `
    -RelationshipName "cr_product_testimonial"

Write-Host "`n════════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "Schema processing complete!" -ForegroundColor Green
Write-Host "════════════════════════════════════════════════════════════════" -ForegroundColor Green
```

---

### Common Table Templates (Updated with Relationships)

#### Product/Service Table

```powershell
# Create Product table
New-DataverseTable -SchemaName "cr_product" -DisplayName "Product" -PluralDisplayName "Products" -Description "Products and services offered"

# Add columns
Add-DataverseColumn -TableName "cr_product" -SchemaName "cr_description" -DisplayName "Description" -Type "Memo" -MaxLength 4000
Add-DataverseColumn -TableName "cr_product" -SchemaName "cr_price" -DisplayName "Price" -Type "Money"
Add-DataverseColumn -TableName "cr_product" -SchemaName "cr_category" -DisplayName "Category" -Type "String"
Add-DataverseColumn -TableName "cr_product" -SchemaName "cr_imageurl" -DisplayName "Image URL" -Type "Url"
Add-DataverseColumn -TableName "cr_product" -SchemaName "cr_isactive" -DisplayName "Is Active" -Type "Boolean"
```

#### Team Member Table

```powershell
# Create Team Member table
New-DataverseTable -SchemaName "cr_teammember" -DisplayName "Team Member" -PluralDisplayName "Team Members" -Description "Team members displayed on the website"

# Add columns
Add-DataverseColumn -TableName "cr_teammember" -SchemaName "cr_title" -DisplayName "Job Title" -Type "String"
Add-DataverseColumn -TableName "cr_teammember" -SchemaName "cr_email" -DisplayName "Email" -Type "Email"
Add-DataverseColumn -TableName "cr_teammember" -SchemaName "cr_bio" -DisplayName "Bio" -Type "Memo" -MaxLength 4000
Add-DataverseColumn -TableName "cr_teammember" -SchemaName "cr_photourl" -DisplayName "Photo URL" -Type "Url"
Add-DataverseColumn -TableName "cr_teammember" -SchemaName "cr_linkedin" -DisplayName "LinkedIn" -Type "Url"
Add-DataverseColumn -TableName "cr_teammember" -SchemaName "cr_displayorder" -DisplayName "Display Order" -Type "Integer"
```

#### Testimonial Table

```powershell
# Create Testimonial table
New-DataverseTable -SchemaName "cr_testimonial" -DisplayName "Testimonial" -PluralDisplayName "Testimonials" -Description "Customer testimonials and reviews"

# Add columns
Add-DataverseColumn -TableName "cr_testimonial" -SchemaName "cr_quote" -DisplayName "Quote" -Type "Memo" -MaxLength 2000
Add-DataverseColumn -TableName "cr_testimonial" -SchemaName "cr_company" -DisplayName "Company" -Type "String"
Add-DataverseColumn -TableName "cr_testimonial" -SchemaName "cr_role" -DisplayName "Role" -Type "String"
Add-DataverseColumn -TableName "cr_testimonial" -SchemaName "cr_rating" -DisplayName "Rating" -Type "Integer"
Add-DataverseColumn -TableName "cr_testimonial" -SchemaName "cr_photourl" -DisplayName "Photo URL" -Type "Url"
Add-DataverseColumn -TableName "cr_testimonial" -SchemaName "cr_isactive" -DisplayName "Is Active" -Type "Boolean"
```

#### FAQ Table

```powershell
# Create FAQ table
New-DataverseTable -SchemaName "cr_faq" -DisplayName "FAQ" -PluralDisplayName "FAQs" -Description "Frequently asked questions" -PrimaryColumnName "cr_question" -PrimaryColumnDisplayName "Question"

# Add columns
Add-DataverseColumn -TableName "cr_faq" -SchemaName "cr_answer" -DisplayName "Answer" -Type "Memo" -MaxLength 4000
Add-DataverseColumn -TableName "cr_faq" -SchemaName "cr_category" -DisplayName "Category" -Type "String"
Add-DataverseColumn -TableName "cr_faq" -SchemaName "cr_displayorder" -DisplayName "Display Order" -Type "Integer"
Add-DataverseColumn -TableName "cr_faq" -SchemaName "cr_isactive" -DisplayName "Is Active" -Type "Boolean"
```

---

## STEP 7: Add Sample Data with Referential Integrity

After creating/extending tables and relationships, add sample data **in the correct order** to maintain referential integrity. If tables were reused, check for existing data first.

**CRITICAL**: Insert data in the same order as table creation - reference/lookup data first, then dependent data with valid foreign keys.

### Data Insertion Protocol

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  SAMPLE DATA INSERTION ORDER (WITH EXISTING DATA CHECKS)                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  0. Check for existing data in reused tables                                │
│     • Query record counts in each table                                     │
│     • If data exists, ask user: skip, add more, or replace                  │
│     • Collect existing record IDs for use as foreign keys                   │
│                                                                             │
│  1. Insert TIER 0 data (reference/lookup tables)                            │
│     • Categories, Statuses, Departments, etc.                               │
│     • Skip if records with same name already exist                          │
│     • Store the returned/existing record IDs for use in foreign keys        │
│                                                                             │
│  2. Insert TIER 1 data with valid lookups                                   │
│     • Products (with Category lookup)                                       │
│     • Team Members (with Department lookup)                                 │
│     • Use the IDs from step 1 for lookup values                             │
│                                                                             │
│  3. Insert TIER 2 data with valid lookups                                   │
│     • Testimonials (with Product lookup)                                    │
│     • Contact Submissions (with Status lookup)                              │
│     • Use IDs from steps 1 and 2 for lookup values                          │
│                                                                             │
│  IMPORTANT: Never insert records with invalid/non-existent lookup values!   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Check Existing Data Before Inserting

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

function New-DataverseRecordIfNotExists {
    param(
        [string]$EntitySetName,
        [hashtable]$Data,
        [string]$NameColumn = "cr_name"
    )

    $nameValue = $Data[$NameColumn]
    $existing = Get-ExistingRecordByName -EntitySetName $EntitySetName -NameColumn $NameColumn -NameValue $nameValue

    if ($existing) {
        Write-Host "    ⏭️  Record '$nameValue' already exists - using existing" -ForegroundColor Yellow
        return @{
            Skipped = $true
            Record = $existing
        }
    }

    Write-Host "    🆕 Creating record '$nameValue'..." -ForegroundColor Cyan
    $body = $Data | ConvertTo-Json -Depth 5
    $response = Invoke-RestMethod -Uri "$baseUrl/$EntitySetName" -Method Post -Headers $headers -Body $body
    Write-Host "    ✅ Record '$nameValue' created" -ForegroundColor Green

    return @{
        Skipped = $false
        Record = $response
    }
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
    $status = if ($_.Value -gt 0) { "⚠️" } else { "✅" }
    Write-Host "  $status $($_.Key): $($_.Value) records"
}
```

### Present Existing Data Options

If existing data is found, use `AskUserQuestion`:

> **Existing Data Found**
>
> Some tables already contain data:
> - cr_categories: 5 records
> - cr_products: 12 records
>
> How would you like to handle sample data?

| Option | Description |
|--------|-------------|
| **Skip tables with data** | Only add sample data to empty tables |
| **Add to existing data** | Add sample data alongside existing records (may create duplicates) |
| **Replace existing data** | Clear existing records and insert fresh sample data (destructive!) |
| **Skip all sample data** | Don't add any sample data, keep existing records |

### Using OData API via PowerShell

Create a PowerShell script to insert sample data:

```powershell
# Get access token
$token = (az account get-access-token --resource "https://<org>.crm.dynamics.com" --query accessToken -o tsv)

# Set headers (include Prefer header to get created record back)
$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
    "OData-MaxVersion" = "4.0"
    "OData-Version" = "4.0"
    "Prefer" = "return=representation"  # Returns created record with ID
}

# Environment URL (get from pac org who)
$baseUrl = "https://<org>.crm.dynamics.com/api/data/v9.2"

# Helper function to create record and return its ID
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

### Complete Sample Data Script (Dependency-Ordered with Reuse)

This script demonstrates proper insertion order with foreign key relationships, skipping records that already exist:

```powershell
# ═══════════════════════════════════════════════════════════════════════════════
# TIER 0: Insert/Reuse Reference/Lookup Data FIRST
# ═══════════════════════════════════════════════════════════════════════════════

Write-Host "`n════════════════════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "TIER 0: Processing Reference/Lookup Data" -ForegroundColor Magenta
Write-Host "════════════════════════════════════════════════════════════════`n" -ForegroundColor Magenta

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

# ═══════════════════════════════════════════════════════════════════════════════
# TIER 1: Insert/Reuse Primary Entity Data (with TIER 0 lookups)
# ═══════════════════════════════════════════════════════════════════════════════

Write-Host "`n════════════════════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "TIER 1: Processing Primary Entity Data (with TIER 0 lookups)" -ForegroundColor Magenta
Write-Host "════════════════════════════════════════════════════════════════`n" -ForegroundColor Magenta

# --- Products (with Category lookup) ---
$productIds = @{}

$products = @(
    @{
        cr_name = "Professional Consultation"
        cr_description = "One-on-one consultation with our expert team."
        cr_price = 299.99
        cr_imageurl = "https://images.unsplash.com/photo-1553877522-43269d4ea984?w=400"
        cr_isactive = $true
        # FOREIGN KEY: Reference the Category by its ID using @odata.bind syntax
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

# ═══════════════════════════════════════════════════════════════════════════════
# TIER 2: Insert/Reuse Dependent Data (with TIER 0 and TIER 1 lookups)
# ═══════════════════════════════════════════════════════════════════════════════

Write-Host "`n════════════════════════════════════════════════════════════════" -ForegroundColor Magenta
Write-Host "TIER 2: Processing Dependent Data (with TIER 0 and TIER 1 lookups)" -ForegroundColor Magenta
Write-Host "════════════════════════════════════════════════════════════════`n" -ForegroundColor Magenta

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
        # Link to specific product
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
        # (Lookup is optional, so we can omit cr_productid@odata.bind)
    }
)

Write-Host "`nProcessing testimonials..." -ForegroundColor Cyan
foreach ($testimonial in $testimonials) {
    New-DataverseRecordIfNotExists -EntitySetName "cr_testimonials" -Data $testimonial -NameColumn "cr_name"
}

Write-Host "`n════════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "Sample data processing complete!" -ForegroundColor Green
Write-Host "════════════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "`nRecords processed (created or reused):" -ForegroundColor Yellow
Write-Host "  - Categories: $($categoryIds.Count)"
Write-Host "  - Statuses: $($statusIds.Count)"
Write-Host "  - Departments: $($departmentIds.Count)"
Write-Host "  - Products: $($productIds.Count)"
Write-Host "  - Team Members: $($teamMemberIds.Count)"
Write-Host "  - Contact Submissions: $($contacts.Count)"
Write-Host "  - Testimonials: $($testimonials.Count)"
```

### Verify Data and Relationships

After inserting, verify the data and its relationships:

```powershell
# Verify products with their categories (expanded relationship)
Write-Host "Products with Categories:" -ForegroundColor Cyan
$products = Invoke-RestMethod -Uri "$baseUrl/cr_products?`$select=cr_name,cr_price&`$expand=cr_categoryid(`$select=cr_name)" -Headers $headers
$products.value | ForEach-Object {
    Write-Host "  $($_.cr_name) - $$($_.cr_price) - Category: $($_.cr_categoryid.cr_name)"
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

---

## Next Steps

After setting up Dataverse tables with sample data, the next step is to configure table permissions so Power Pages can access the data.

> **Next Skill**: Run `/setup-webapi` to configure table permissions and enable Web API access for your Power Pages site.

---

## Update Memory Bank

After completing this skill, update `memory-bank.md` with the Dataverse setup details including the data architecture and reuse decisions:

```markdown
### /setup-dataverse
- [x] Site analyzed for data requirements
- [x] Data architecture designed with dependency graph
- [x] Existing tables reviewed and analyzed
- [x] Reuse decisions made (reuse/extend/create)
- [x] Tables created/extended in dependency order
- [x] Relationships (lookups) established
- [x] Sample data inserted with referential integrity (skipped existing)

## Data Architecture

### Existing Table Analysis

| Required Table | Decision | Existing Table | Action Taken |
|----------------|----------|----------------|--------------|
| cr_category | REUSE | cr_category | Used existing table |
| cr_product | EXTEND | cr_product | Added cr_imageurl, cr_isactive columns |
| cr_testimonial | CREATE | - | Created new table |
| cr_contactsubmission | CREATE | - | Created new table |

### Dependency Graph
```text
TIER 0 (Reference Tables):
  cr_category, cr_status, cr_department

TIER 1 (Primary Tables):
  cr_product → cr_category
  cr_teammember → cr_department

TIER 2 (Dependent Tables):
  cr_contactsubmission → cr_status
  cr_testimonial → cr_product
```

### Tables by Tier

#### TIER 0 - Reference/Lookup Tables

| Table Name | Display Name | Purpose |
|------------|--------------|---------|
| cr_category | Category | Product/content categories |
| cr_status | Status | Status values for submissions |
| cr_department | Department | Team member departments |

#### TIER 1 - Primary Entity Tables

| Table Name | Display Name | Relationships |
|------------|--------------|---------------|
| cr_product | Product | → cr_category (lookup) |
| cr_teammember | Team Member | → cr_department (lookup) |

#### TIER 2 - Dependent Tables

| Table Name | Display Name | Relationships |
|------------|--------------|---------------|
| cr_contactsubmission | Contact Submission | → cr_status (lookup) |
| cr_testimonial | Testimonial | → cr_product (optional lookup) |

### Relationships Created

| Relationship Name | Type | Source Table | Target Table | Lookup Column |
|-------------------|------|--------------|--------------|---------------|
| cr_category_product | 1:N | cr_product | cr_category | cr_categoryid |
| cr_department_teammember | 1:N | cr_teammember | cr_department | cr_departmentid |
| cr_status_contactsubmission | 1:N | cr_contactsubmission | cr_status | cr_statusid |
| cr_product_testimonial | 1:N | cr_testimonial | cr_product | cr_productid |

### Sample Data Summary

| Table | Records | Notes |
|-------|---------|-------|
| cr_category | 3 | Services, Packages, Products |
| cr_status | 4 | New, Reviewed, Responded, Closed |
| cr_department | 4 | Executive, Engineering, Customer Success, Sales |
| cr_product | 3 | All linked to categories |
| cr_teammember | 3 | All linked to departments |
| cr_contactsubmission | 3 | All linked to statuses |
| cr_testimonial | 3 | 2 linked to products, 1 general |

### Technical Details
- Data Integration: OData Web API
- Environment URL: [URL from pac org who]
- Creation Order: TIER 0 → TIER 1 → TIER 2
- Data Insertion Order: Reference data first, then dependent data with valid FK references

## Current Status

**Last Action**: Dataverse tables and relationships created with sample data

**Next Step**: Run `/setup-webapi` to configure table permissions and Web API access

## Notes

- [DATE]: Created data architecture with [N] tables and [M] relationships
- All tables created in dependency order
- Sample data inserted with valid foreign key references
```

---

## Troubleshooting

### Existing Table Detection Issues

- **Tables not found**: Ensure the filter `IsCustomEntity eq true` is correct for your needs
- **Wrong publisher prefix**: Tables may have different prefixes (e.g., `new_`, `contoso_` instead of `cr_`)
- **System tables included**: Add additional filters to exclude system tables if needed
- **Case sensitivity**: Table logical names are case-insensitive but schema names preserve case

### Table Reuse Issues

- **Existing table has different schema**: Consider creating a new table with a unique name instead
- **Column type mismatch**: Cannot change column types; may need to create new column with different name
- **Relationship conflicts**: Verify existing relationships don't prevent your intended lookups
- **Missing required columns on reused table**: Use `Add-DataverseColumnIfNotExists` to add only missing columns

### Dataverse Web API Errors

- Verify Azure CLI is logged in: `az login`
- Check access token is valid: `az account get-access-token --resource <env-url>`
- Ensure you have appropriate Dataverse permissions (System Administrator or System Customizer)

### Table Creation Fails

- Verify schema name uses valid publisher prefix (e.g., `cr_`)
- Check that the table doesn't already exist
- Ensure all required metadata fields are included in the request
- Review the error response for specific validation failures

### Relationship/Lookup Creation Fails

- **"Referenced entity not found"**: Ensure the target table exists BEFORE creating the lookup
  - Check creation order: TIER 0 tables must exist before TIER 1, etc.
- **"Duplicate relationship name"**: Relationship names must be unique across the environment
  - Use a consistent naming pattern: `{publisher}_{targettable}_{sourcetable}`
- **"Invalid target entity"**: The target table must have a primary key attribute
- **Self-referential lookup fails**: Create the table first, then add the self-lookup as a separate step

### Sample Data Insertion Fails

- **"Foreign key violation"**: The referenced record doesn't exist
  - Insert TIER 0 data first, then TIER 1, then TIER 2
  - Verify the lookup ID is correct (GUIDs are case-insensitive)
  - If reusing existing lookup tables, query for existing record IDs first
- **"Invalid @odata.bind syntax"**: Format must be `/entitysetname(guid)`
  - Example: `"cr_categoryid@odata.bind" = "/cr_categories(12345678-1234-1234-1234-123456789012)"`
- **"Entity set not found"**: Use the plural entity set name, not the logical name
  - Table `cr_product` has entity set `cr_products` (usually plural)
- **Duplicate record errors**: If using `New-DataverseRecordIfNotExists`, records with the same name are skipped
  - Check for unique constraints on other columns if inserts still fail

### Existing Data Conflicts

- **Stale record IDs**: If reusing tables, always query for current record IDs; don't use cached values
- **Data format differences**: Existing records may have different formats (e.g., dates, currency)
- **Orphaned lookups**: When reusing tables, verify that lookup values still exist in referenced tables

### Verifying Relationships

```powershell
# Check if a relationship exists
$relations = Invoke-RestMethod -Uri "$baseUrl/RelationshipDefinitions?`$filter=SchemaName eq 'cr_category_product'" -Headers $headers
if ($relations.value.Count -gt 0) {
    Write-Host "Relationship exists"
} else {
    Write-Host "Relationship not found"
}

# List all relationships for a table
$tableRelations = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions(LogicalName='cr_product')/OneToManyRelationships" -Headers $headers
$tableRelations.value | ForEach-Object { Write-Host $_.SchemaName }
```

---

## Reference Documentation

- [Dataverse Web API](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview)
- [Dataverse Entity Metadata](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-entity-definitions-using-web-api)
- [OData Query Options](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-data-web-api)
