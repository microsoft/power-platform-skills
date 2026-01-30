---
name: setting-up-dataverse-tables
description: Creates Dataverse tables, columns, and relationships for Power Pages. Use when creating tables, defining schema, setting up entity relationships, or lookup fields.
user-invocable: true
allowed-tools: ["Read", "Write", "Grep", "Glob", "Bash", "TodoWrite", "AskUserQuestion", "Skill", "Task"]
model: opus
---

**📋 [Shared Instructions](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Read before starting.

# Setup Dataverse Tables

**References:** [data-architecture](./references/data-architecture-reference.md) | [api-auth](./references/api-authentication-reference.md) | [table-management](./references/table-management-reference.md) | [relationships](./references/relationship-reference.md) | [troubleshooting](./references/troubleshooting.md)

Tables are created in **topological order** (referenced tables first) to maintain referential integrity.

## Workflow

1. **Check Context** → Read memory bank, get project path
2. **Analyze Site** → Identify data patterns from components
3. **Build Dependency Graph** → Determine creation order
4. **Setup API Auth** → Get token and publisher prefix
5. **Review Existing Tables** → Reuse, extend, or create new
6. **Create Tables** → In dependency order with relationships

---

## Step 1: Check Context

Read `memory-bank.md`. If continuing from `/create-site`, proceed. Otherwise ask for project path or suggest `/create-site` first.

---

## Step 2: Analyze Site

Read `powerpages.config.json` and scan components for data patterns:

| Pattern | Table | Relationships |
|---------|-------|---------------|
| Contact form | `{prefix}_contactsubmission` | → status |
| Products | `{prefix}_product` | → category |
| Team members | `{prefix}_teammember` | → department |
| Testimonials | `{prefix}_testimonial` | → product (optional) |
| Blog | `{prefix}_blogpost` | → category, author |
| FAQ | `{prefix}_faq` | → faqcategory |

**Use standard Dataverse tables instead of creating new ones:**

| Need | Use This | NOT This |
|------|----------|----------|
| User profiles, customers | `contact` (standard) | `{prefix}_user` or `{prefix}_customer` |
| Organizations, companies | `account` (standard) | `{prefix}_company` |

The `contact` table is already integrated with Power Pages authentication - portal users are linked to Contact records. Extend it with custom columns if needed rather than creating a separate user table.

Design ER model, classify into tiers (TIER 0 = reference tables, TIER 1 = primary entities, etc.), present to user.

---

## Step 3: Build Dependency Graph

Topologically sort tables. Rules:
- No circular dependencies
- All referenced tables exist
- Self-references: create table first, add lookup after

---

## Step 4: Setup API Auth

```powershell
az account show
pac org who

$api = Initialize-DataverseApi -EnvironmentUrl "https://<org>.crm.dynamics.com"
$headers = $api.Headers
$baseUrl = $api.BaseUrl
$publisherPrefix = $api.PublisherPrefix  # Use for all schema names
```

---

## Step 5: Review Existing Tables

**ALWAYS query existing tables first before recommending creation:**

```powershell
# 1. Get ALL existing custom tables
$existingTables = Invoke-RestMethod -Uri "$baseUrl/EntityDefinitions?`$filter=IsCustomEntity eq true&`$select=SchemaName,LogicalName,DisplayName" -Headers $headers

# 2. Use Find-SimilarTables to match by purpose (category, product, team, etc.)
# 3. Use Compare-TableSchemas to check if columns match requirements
```

**Always recommend standard Dataverse tables for common needs:**
- `contact` - For users, customers, people (already linked to Power Pages auth)
- `account` - For organizations, companies, partners

These exist in every environment - extend with custom columns instead of creating new tables.

**Present findings to user with `AskUserQuestion`:**
- Show which existing tables can be reused (and what columns they have)
- Show which need extension (missing columns)
- Show which must be created new (no match found)

Options:
- **Use recommendations** - Reuse existing, extend where needed, create only new
- **Create all new** - Unique names for all tables
- **Review each** - Decide individually

Build `$tableMap` with `Build-TableNameMapping` - **critical for later steps**:
```powershell
$tableMap["category"].LogicalName   # Actual table name (may be existing table)
$tableMap["category"].EntitySetName # For OData queries
$tableMap["category"].Source        # "Reused", "Extended", or "Created"
```

---

## Step 6: Create Tables

**Present the plan and get explicit confirmation before creating:**

Use `AskUserQuestion` to show:
- Tables to be reused (no changes)
- Tables to be extended (list columns to add)
- Tables to be created (list all columns)
- Relationships to be created

Options:
- **Proceed** - Create/extend tables as planned
- **Modify** - Let me adjust the plan
- **Cancel** - Don't make any changes

**Only after user confirms "Proceed"**, create in dependency order using:
- `New-DataverseTableIfNotExists`
- `Add-DataverseColumnIfNotExists`
- `Add-DataverseLookupIfNotExists`

**Phases**: Skip reusable → Extend existing → Create new → Add lookups

---

## Step 7: Create Skill Tracking Setting and Upload

Create `Site/AI/SetupDataverse` site setting to track skill usage:

```powershell
New-SkillTrackingSetting -ProjectRoot $projectRoot -SkillName "SetupDataverse"
npm run build  # Always build before upload
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

See [authoring-tool-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/authoring-tool-reference.md) for helper function.

Cleanup per [cleanup-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/cleanup-reference.md).

---

## Optional Enhancements

After table creation, suggest:
- `/add-sample-data` - Insert sample data with proper foreign key relationships

---

## Next Steps

Run `/setup-webapi` to configure table permissions.
