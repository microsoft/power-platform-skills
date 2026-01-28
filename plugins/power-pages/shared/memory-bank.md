# Memory Bank Instructions

This document defines the memory bank system used to persist context across conversations and skill invocations. **All skills in this plugin follow these instructions.**

## Overview

The memory bank (`memory-bank.md`) is a markdown file stored in the project root that tracks:

- Project configuration and metadata
- Completed steps and progress
- User decisions and preferences
- Created resources (tables, permissions, etc.)
- Current status and next steps

## File Location

The memory bank is always stored at: `<PROJECT_ROOT>/memory-bank.md`

---

## Before Starting Any Skill

**IMPORTANT**: Every skill MUST check for and read the memory bank before proceeding.

### Step 1: Locate the Memory Bank

1. If the user has specified a project path, check `<PROJECT_PATH>/memory-bank.md`
2. If continuing from a previous skill in the same session, use the known project path
3. If no path is known, ask the user for the project path

### Step 2: Read and Parse Context

If the memory bank exists, extract:

| Information | Purpose |
|-------------|---------|
| Project path, name, framework | Know what you're working with |
| Completed steps (checkboxes) | Skip steps already done |
| User preferences | Don't re-ask answered questions |
| Created resources | Know what tables/settings exist |
| Current status | Understand where to resume |

### Step 3: Resume or Continue

- **If the current skill's steps are already marked complete**: Ask if they want to modify, add more, or skip to next steps
- **If partially complete**: Inform the user and resume from the incomplete step
- **If not started**: Begin from the first step

### Step 4: Inform the User

Always tell the user what you found:

> "I found your project memory bank. [Summary: project name, framework, what's been completed]. Let's continue from [next step]."

---

## After Each Major Step

Update the memory bank immediately after completing each major step. This ensures progress is saved even if the session ends unexpectedly.

### What to Update

1. **Mark completed steps** with `[x]`
2. **Record created resources** (tables, settings, files)
3. **Save user decisions** (framework choice, integration approach, etc.)
4. **Update current status** and next step
5. **Add timestamp** to "Last Updated"
6. **Add notes** for important context or decisions

### Update Frequency

Update after:

- Completing any workflow step
- User makes a significant decision
- Creating or modifying resources
- Encountering errors or issues worth noting
- Before ending a session

---

## When to Create vs Update

| Scenario | Action |
|----------|--------|
| Memory bank doesn't exist | Create it after the first major step (e.g., after site creation) |
| Memory bank exists | Update it - preserve existing content, add new information |
| Continuing previous session | Read first, then update as you progress |

## Template Structure

```markdown
# Power Pages Project Memory Bank

> Last Updated: [TIMESTAMP]
> Session: [SESSION_ID or conversation context]

## Project Overview

| Property | Value |
|----------|-------|
| Project Name | [SITE_NAME] |
| Project Path | [FULL_PATH] |
| Framework | [React/Angular/Vue/Astro] |
| Created Date | [DATE] |
| Status | [In Progress/Site Created/Tables Setup/Deployed] |

## User Preferences

### Design Preferences
- Style: [Modern/Corporate/Creative/Elegant]
- Color Scheme: [Description or hex codes]
- Special Requirements: [Accessibility, mobile-first, etc.]

### Technical Preferences
- Data Integration: [MCP Server/OData API]
- Authentication: [Enabled/Disabled] - [Provider if enabled]

## Completed Steps

### /create-site
- [x] Requirements gathered
- [x] Framework selected: [FRAMEWORK]
- [x] Site created with features: [LIST]
- [x] powerpages.config.json created
- [x] Project built successfully
- [x] Prerequisites verified (PAC CLI, Azure CLI)
- [x] Uploaded to Power Pages (Inactive)
- [x] Site activated
- Website ID: [GUID]
- Site URL: [URL]

### /setup-dataverse
- [x] Site analyzed
- [x] Schema recommended
- [x] Integration approach chosen: [MCP/OData]
- [x] Tables created: [LIST]
- [x] Sample data inserted

### /setup-webapi
- [x] Site settings created for Web API
- [x] Table permissions configured
- [x] Frontend code updated
- [x] Project built and uploaded

## Created Resources

### Publisher Prefix

The publisher prefix is fetched dynamically from the Default solution's publisher via `Initialize-DataverseApi`:
- **Prefix**: `{prefix}` (e.g., `cr`, `contoso`, `new`)

### Dataverse Tables

| Table Name | Display Name | Columns | Sample Data |
|------------|--------------|---------|-------------|
| {prefix}_contactsubmission | Contact Submission | name, email, message, status | 3 records |
| {prefix}_product | Product | name, description, price, category | 5 records |

### Site Settings

| Setting | Value |
|---------|-------|
| Webapi/{prefix}_product/enabled | true |
| Webapi/{prefix}_product/fields | {prefix}_name,{prefix}_description,{prefix}_price,{prefix}_category |

## Current Status

**Last Action**: [Description of last completed action]

**Next Step**: [What the user should do next]

**Pending Items**:
- [ ] [Item 1]
- [ ] [Item 2]

## Notes & Issues

### Session Notes
- [Date]: [Note about decisions, issues, or context]

### Known Issues
- [Issue description and any workarounds]

## Quick Resume

To continue working on this project:

1. **Create Site**: `/create-site` (creates new site or updates existing)
2. **Setup Dataverse Tables**: `/setup-dataverse` (creates tables and sample data)
3. **Setup Web API**: `/setup-webapi` (enables Web API access and updates frontend)
4. **Manual**: Navigate to [PROJECT_PATH] and continue development
```

## Reading the Memory Bank

When reading the memory bank, extract:

1. **Project context**: Path, framework, name
2. **Completed work**: Check checkboxes to know what's done
3. **User preferences**: Apply these without re-asking
4. **Created resources**: Know what tables/settings exist
5. **Current status**: Understand where to resume

## Writing Guidelines

1. **Be concise**: Use tables and lists, not paragraphs
2. **Be specific**: Include exact values, paths, GUIDs
3. **Timestamp updates**: Always update "Last Updated"
4. **Preserve history**: Add to notes, don't overwrite
5. **Track decisions**: Record why choices were made

## Example: Checking Memory Bank

```text
At the start of /setup-dataverse:

1. Read memory-bank.md from project root
2. Check if /setup-dataverse steps are already marked complete
3. If tables are already created, ask user if they want to:
   - Add more tables
   - Modify existing tables
   - Add more sample data
   - Skip to next step
4. Apply saved preferences (e.g., MCP vs OData choice)
```

## Integration with Skills

Both skills should include these instructions:

### At Skill Start

```text
### Check Memory Bank

Before proceeding, check if a memory bank exists:

1. Look for `memory-bank.md` in the project root
2. If found, read it to understand:
   - What steps have been completed
   - What user preferences were chosen
   - What resources already exist
3. Adjust your workflow to skip completed steps
4. Inform the user what you found and where you'll resume
```

### At Skill End / After Major Steps

```text
### Update Memory Bank

After completing this step, update the memory bank:

1. Create or update `memory-bank.md` in the project root
2. Mark completed steps with [x]
3. Record any new resources created
4. Update the "Current Status" section
5. Add any relevant notes
```
