---
name: migrate-to-dataverse
version: 1.0.0
description: Read the YAML files of an existing Canvas App and replace Power FX data source calls with equivalent Dataverse table calls. USE WHEN the user wants to migrate, replace, or update data source references in pa.yaml files to point to Dataverse tables.
author: Rui Santos
user-invocable: true
---

# Migrate Canvas App Data Sources to Dataverse

Read the YAML files of the current Canvas App and replace all Power FX data source calls with Dataverse equivalents for the following requirements:

$ARGUMENTS

## CRITICAL: Review Guidance First

Before making any changes, you MUST read and internalize the technical reference document:

- `${CLAUDE_PLUGIN_ROOT}/references/TechnicalGuide.md` — Technical best practices, control selection, validation workflow, formulas, layout strategies

Read this file before planning any edits.

## CRITICAL: Sync the Canvas App First

Before reading or editing any YAML files, call the `sync_canvas` MCP tool to ensure a local copy of the canvas app YAML is present and up to date. This pulls the current app state from the coauthoring session into local `.pa.yaml` files.

Only proceed after `sync_canvas` completes successfully.

## Migration Workflow

### 1. Discover Available Data Sources

Call `list_data_sources` to enumerate all data sources connected to the current authoring session. This is the authoritative list of Dataverse tables (and other connectors) available for mapping.

After the call completes, share a discovery summary with the user:

> **Discovery complete.**
> Available data sources ([N] total):
> | Name | Type | Key Columns |
> |------|------|-------------|
> | [Table Name] | Dataverse / SharePoint / … | [column names] |

For each Dataverse table identified, call `get_data_source_schema` to retrieve the full column list and Power Fx types. This information is required to map source columns to destination columns accurately.

### 2. Read the YAML Files

Read every `.pa.yaml` file produced by `sync_canvas`. For each file:

- Identify every Power Fx formula that references a non-Dataverse data source (e.g. `SharePoint.GetItems`, `Filter('MyList', …)`, `Patch('MyList', …)`, `LookUp`, `Collect`, `ClearCollect`, etc.).
- Note the source table/list name, the columns referenced, and the operation type (`Filter`, `Patch`, `LookUp`, `Collect`, etc.).

### 3. Build a Column Mapping Plan

Using the schemas retrieved in step 1, produce a mapping table for every data source call found:

> **Proposed Mapping Plan**
>
> | Source Expression | Source Column | Dataverse Table | Dataverse Column | Notes |
> |-------------------|---------------|-----------------|-----------------|-------|
> | `Filter('Orders List', Status = "Open")` | Status | `cr123_orders` | `cr123_status` | Type match: Text |
> | … | … | … | … | … |

Rules for column selection:
- Prefer an **exact name match** (case-insensitive).
- Fall back to a **semantic name match** (e.g. `Title` → `cr123_name`).
- Flag any column with **no clear match** as `⚠ needs manual review`.
- Respect Power Fx type compatibility — do not map a `Text` column to a `Choices` column without an explicit conversion formula.

Present the plan to the user and ask for approval before making any changes:

> Does this mapping plan look correct?
> - **Approve and apply changes**
> - **I'd like to adjust the mapping first**

If adjustments are requested, update the mapping plan accordingly and re-present.

### 4. Apply the Replacements

Once the plan is approved, update every affected `.pa.yaml` file:

- Replace each source data-call expression with the equivalent Dataverse Power Fx expression using the approved column mapping.
- Keep all UI properties, layout, and non-data formulas **unchanged**.
- Follow the formula conventions in `${CLAUDE_PLUGIN_ROOT}/references/TechnicalGuide.md` (use `=` prefix, wrap multi-line formulas correctly, etc.).
- Preserve `OnVisible` initialization patterns — replace collection sources but keep the collection/variable structure if it exists.

Announce progress for each file:

> **Updating [filename].pa.yaml ([N] of [Total])…**

### 5. Validate

Call `compile_canvas` after updating all files. Fix any compilation errors before finishing. Report the result:

- On success: > **Compilation successful — all replacements are valid.**
- On failure: > **[N] error(s) found — fixing before finishing.** [brief description of each error]

Repeat validate → fix until all files compile clean.

### 6. Complete

When all files pass validation, present a final summary:

> **Migration complete.**
>
> | File | Expressions Replaced | Status |
> |------|----------------------|--------|
> | [filename].pa.yaml | [N] | Compiled |
>
> **Source replaced:** [original data source names]
> **Target:** [Dataverse table names used]
> **Columns requiring manual review:** [list any ⚠ flagged columns, or "none"]
