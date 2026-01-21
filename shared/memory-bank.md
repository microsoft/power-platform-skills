# Memory Bank Instructions

This document defines the memory bank system used to persist context across conversations and skill invocations.

## Overview

The memory bank (`memory-bank.md`) is a markdown file stored in the project root that tracks:

- Project configuration and metadata
- Completed steps and progress
- User decisions and preferences
- Created resources (tables, permissions, etc.)
- Current status and next steps

## File Location

The memory bank is always stored at: `<PROJECT_ROOT>/memory-bank.md`

## When to Read

**ALWAYS** read the memory bank at the start of any skill execution:

1. Check if `memory-bank.md` exists in the project root
2. If it exists, read it to understand prior context
3. Use this context to:
   - Skip already-completed steps
   - Apply previously-chosen preferences
   - Understand what resources already exist
   - Continue from where the user left off

## When to Write

Update the memory bank after:

1. Completing any major step
2. User makes a significant decision
3. Creating or modifying resources
4. Encountering errors or issues
5. Before ending a session

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
- [x] Table permissions configured

## Created Resources

### Dataverse Tables

| Table Name | Display Name | Columns | Sample Data |
|------------|--------------|---------|-------------|
| cr_contactsubmission | Contact Submission | name, email, message, status | 3 records |
| cr_product | Product | name, description, price, category | 5 records |

### Site Settings

| Setting | Value |
|---------|-------|
| Webapi/cr_product/enabled | true |
| Webapi/cr_product/fields | * |

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

1. **Setup Dataverse Tables**: `/setup-dataverse`
2. **Update Site**: `/create-site` (will recognize existing project)
3. **Manual**: Navigate to [PROJECT_PATH] and continue development
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
