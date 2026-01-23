---
description: Setup Dataverse tables, schema, entities, and data model for Power Pages. Use this skill when you need to create Dataverse tables, define table columns, set up entity relationships, create lookup fields, design database schema, add sample data, or configure table structure for your Power Pages site.
user-invocable: true
allowed-tools: Bash(pac:*), Bash(az:*)
model: sonnet
---

# Setup Dataverse Tables

This skill guides makers through setting up Dataverse tables and schema for their Power Pages site. It analyzes the site created in the previous step, recommends appropriate tables, and helps create them with sample data.

**IMPORTANT**: This skill takes a **data architecture approach** - it analyzes table relationships, builds a dependency graph, and creates tables in the correct topological order (referenced tables first, then dependent tables). This ensures referential integrity and follows enterprise data modeling best practices.

## Reference Documentation

This skill uses modular reference files for detailed instructions:

| File | Purpose |
|------|---------|
| [data-architecture-reference.md](./data-architecture-reference.md) | Entity relationships, table tiers, dependency graphs |
| [api-authentication-reference.md](./api-authentication-reference.md) | OData Web API setup, Azure CLI authentication |
| [table-management-reference.md](./table-management-reference.md) | Table creation, columns, helper functions |
| [relationship-reference.md](./relationship-reference.md) | Lookups, 1:N and N:N relationships |
| [sample-data-reference.md](./sample-data-reference.md) | Data insertion with referential integrity |
| [troubleshooting.md](./troubleshooting.md) | Common issues and solutions |

## Memory Bank

This skill uses a **memory bank** (`memory-bank.md`) to persist context across sessions.

**Follow the instructions in `${CLAUDE_PLUGIN_ROOT}/shared/memory-bank.md`** for:
- Checking and reading the memory bank before starting
- Skipping completed steps and resuming progress
- Updating the memory bank after each major step

## Workflow Overview

```text
+-----------------------------------------------------------------------------+
|  STEP 1: Resume or Start Fresh                                              |
|  - Check if continuing from /create-site                                    |
|  - Identify existing site project path                                      |
|  - Offer to proceed or show resume command                                  |
+-----------------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------------+
|  STEP 2: Analyze Site & Design Data Architecture                            |
|  - Read site source code and configuration                                  |
|  - Identify data requirements from components                               |
|  - Design entity-relationship model with proper normalization               |
|  - Document table relationships (1:N, N:N, self-referential)                |
|  See: data-architecture-reference.md                                        |
+-----------------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------------+
|  STEP 3: Build Dependency Graph & Determine Creation Order                  |
|  - Analyze foreign key relationships                                        |
|  - Perform topological sort to determine creation order                     |
|  - Identify reference/lookup tables (create first)                          |
|  - Identify dependent tables (create after their references)                |
|  See: data-architecture-reference.md                                        |
+-----------------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------------+
|  STEP 4: Set Up OData Web API Authentication                                |
|  - Configure Azure CLI authentication                                       |
|  - Get environment URL and access token                                     |
|  - Set up API headers for Dataverse calls                                   |
|  See: api-authentication-reference.md                                       |
+-----------------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------------+
|  STEP 5: Review Existing Tables & Identify Reusable Tables                  |
|  - Query all existing custom tables in the environment                      |
|  - Compare existing tables against recommended schema                       |
|  - Identify tables that can be reused (matching or similar schema)          |
|  - Present options: reuse existing, extend existing, or create new          |
|  See: table-management-reference.md                                         |
+-----------------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------------+
|  STEP 6: Create/Extend Tables in Dependency Order                           |
|  - Skip tables marked for reuse                                             |
|  - Extend existing tables with missing columns if needed                    |
|  - Create only new tables that don't exist                                  |
|  - Add relationship columns (lookups) after both tables exist               |
|  See: table-management-reference.md, relationship-reference.md              |
+-----------------------------------------------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------------+
|  STEP 7: Add Sample Data with Referential Integrity                         |
|  - Check for existing data in reused tables                                 |
|  - Insert reference/lookup data first (skip if exists)                      |
|  - Insert dependent records with valid foreign keys                         |
|  - Verify relationships are correctly established                           |
|  See: sample-data-reference.md                                              |
+-----------------------------------------------------------------------------+
                                    |
                                    v
                        Next: /setup-webapi skill
```

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

---

## STEP 2: Analyze Site & Design Data Architecture

**See: [data-architecture-reference.md](./data-architecture-reference.md)**

### Quick Summary

1. **Read powerpages.config.json** to get site name and structure
2. **Scan component files** for data patterns:
   - Forms (contact forms, registration forms)
   - Lists/Tables (product listings, team members)
   - Cards (testimonials, portfolio items)

### Data Pattern Recognition

| Pattern | Recommended Table | Likely Relationships |
|---------|-------------------|---------------------|
| Contact form | `cr_contactsubmission` | -> `cr_contactstatus` (lookup) |
| Product/service cards | `cr_product` | -> `cr_category` (lookup) |
| Team member section | `cr_teammember` | -> `cr_department` (lookup) |
| Testimonials/Reviews | `cr_testimonial` | -> `cr_product` (optional) |
| Blog/News section | `cr_blogpost` | -> `cr_category`, -> `cr_author` |
| FAQ section | `cr_faq` | -> `cr_faqcategory` (lookup) |

### Actions

1. Design a complete ER model identifying all entities and relationships
2. Classify tables into tiers (TIER 0 reference tables, TIER 1 primary entities, etc.)
3. Present architecture recommendations using `AskUserQuestion`

---

## STEP 3: Build Dependency Graph & Validate Creation Order

**See: [data-architecture-reference.md](./data-architecture-reference.md)**

### Quick Summary

Before creating any tables, validate the creation order:

1. List all tables and their lookup columns
2. Build adjacency list: for each table, list tables it depends on
3. Perform topological sort to get valid creation order
4. Group tables by tier for parallel creation where possible

### Validation Rules

- **No circular dependencies** - A cannot depend on B if B depends on A
- **All referenced tables exist** - Either in schema or as system tables
- **Self-references are handled** - Table created first, then self-lookup added

---

## STEP 4: Set Up OData Web API Authentication

**See: [api-authentication-reference.md](./api-authentication-reference.md)**

### Quick Summary

```powershell
# Verify Azure CLI is logged in
az account show

# Get environment URL
pac org who

# Get access token
$envUrl = "https://<org>.crm.dynamics.com"
$token = (az account get-access-token --resource $envUrl --query accessToken -o tsv)

# Set up headers
$headers = @{
    "Authorization" = "Bearer $token"
    "Content-Type" = "application/json"
    "OData-MaxVersion" = "4.0"
    "OData-Version" = "4.0"
    "Prefer" = "return=representation"
}

$baseUrl = "$envUrl/api/data/v9.2"
```

---

## STEP 5: Review Existing Tables & Identify Reusable Tables

**See: [table-management-reference.md](./table-management-reference.md)**

### Quick Summary

**CRITICAL**: Before creating any tables, review existing tables in the environment to prevent duplicates and leverage existing schema.

### Actions

1. Query all existing custom tables using `EntityDefinitions` API
2. Compare existing tables against recommended schema
3. Present reuse options to user:
   - **Reuse as-is**: Table has all required columns
   - **Extend**: Table exists but needs additional columns
   - **Create new**: Table doesn't exist

### Present Options

Use `AskUserQuestion`:

| Option | Description |
|--------|-------------|
| **Use recommendations** | Reuse existing tables, extend where needed, create only new |
| **Create all new** | Create new tables with unique names |
| **Review each table** | Decide for each table individually |

---

## STEP 6: Create/Extend Tables in Dependency Order

**See: [table-management-reference.md](./table-management-reference.md) and [relationship-reference.md](./relationship-reference.md)**

### Quick Summary

Based on STEP 5 decisions, create only new tables and extend existing tables as needed.

### Protocol

1. **PHASE 1**: Process tables based on decisions (skip reusable, extend, create new)
2. **PHASE 2**: Add non-lookup columns to new and extended tables
3. **PHASE 3**: Create/verify relationships (lookup columns)

### Key Functions

- `New-DataverseTableIfNotExists` - Create table only if it doesn't exist
- `Add-DataverseColumnIfNotExists` - Add column only if it doesn't exist
- `Add-DataverseLookupIfNotExists` - Create relationship only if it doesn't exist

---

## STEP 7: Add Sample Data with Referential Integrity

**See: [sample-data-reference.md](./sample-data-reference.md)**

### Quick Summary

Insert data **in the correct order** to maintain referential integrity.

### Protocol

1. Check for existing data in reused tables
2. Insert TIER 0 data first (categories, statuses, departments)
3. Insert TIER 1 data with valid TIER 0 lookups (products, team members)
4. Insert TIER 2 data with valid lookups (testimonials, submissions)

### Foreign Key Syntax

```powershell
# Use @odata.bind to reference related records
$product = @{
    cr_name = "Professional Consultation"
    "cr_categoryid@odata.bind" = "/cr_categories($categoryId)"
}
```

### Verify Data

After inserting, verify relationships using `$expand`:

```powershell
$products = Invoke-RestMethod -Uri "$baseUrl/cr_products?`$expand=cr_categoryid(`$select=cr_name)" -Headers $headers
```

---

## STEP 8: Cleanup Helper Files

**📖 See: [cleanup-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/cleanup-reference.md)**

Remove any temporary helper files created during this skill's execution. Verify tables are created and data is inserted correctly before cleanup.

---

## Next Steps

After setting up Dataverse tables with sample data, configure table permissions so Power Pages can access the data.

> **Next Skill**: Run `/setup-webapi` to configure table permissions and enable Web API access for your Power Pages site.

---

## Update Memory Bank

After completing this skill, update `memory-bank.md`:

```markdown
### /setup-dataverse
- [x] Site analyzed for data requirements
- [x] Data architecture designed with dependency graph
- [x] Existing tables reviewed and analyzed
- [x] Reuse decisions made (reuse/extend/create)
- [x] Tables created/extended in dependency order
- [x] Relationships (lookups) established
- [x] Sample data inserted with referential integrity

## Data Architecture

### Tables by Tier

| Tier | Tables |
|------|--------|
| TIER 0 | cr_category, cr_status, cr_department |
| TIER 1 | cr_product, cr_teammember |
| TIER 2 | cr_testimonial, cr_contactsubmission |

### Relationships

| Source | Target | Lookup Column |
|--------|--------|---------------|
| cr_product | cr_category | cr_categoryid |
| cr_teammember | cr_department | cr_departmentid |
| cr_testimonial | cr_product | cr_productid |

## Current Status

**Last Action**: Dataverse tables and relationships created with sample data

**Next Step**: Run `/setup-webapi` to configure table permissions
```

---

## Troubleshooting

**See: [troubleshooting.md](./troubleshooting.md)** for common issues and solutions.
