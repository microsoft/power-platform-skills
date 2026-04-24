# Memory Bank Instructions

This document defines the memory bank system used to persist context across conversations and skill invocations. **All skills in this plugin follow these instructions.**

## Overview

The memory bank (`memory-bank.md`) is a markdown file stored in the project root that tracks:

- Project configuration and metadata
- Completed steps and progress
- User decisions and preferences
- Created resources (data sources, connectors, etc.)
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

| Information                  | Purpose                                 |
| ---------------------------- | --------------------------------------- |
| Project path, name, version  | Know what you're working with           |
| Completed steps (checkboxes) | Skip steps already done                 |
| User preferences             | Don't re-ask answered questions         |
| Created resources            | Know what data sources/connectors exist |
| Current status               | Understand where to resume              |

### Step 3: Resume or Continue

- **If the current skill's steps are already marked complete**: Ask if they want to modify, add more, or skip to next steps
- **If partially complete**: Inform the user and resume from the incomplete step
- **If not started**: Begin from the first step

### Step 4: Inform the User

Always tell the user what you found:

> "I found your project memory bank. [Summary: project name, version, what's been completed]. Let's continue from [next step]."

---

## After Each Major Step

Update the memory bank immediately after completing each major step. This ensures progress is saved even if the session ends unexpectedly.

### What to Update

1. **Mark completed steps** with `[x]`
2. **Record created resources** (data sources, connectors, files)
3. **Save user decisions** (connector choice, table names, etc.)
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

| Scenario                    | Action                                                          |
| --------------------------- | --------------------------------------------------------------- |
| Memory bank doesn't exist   | Create it after the first major step (e.g., after app creation) |
| Memory bank exists          | Update it - preserve existing content, add new information      |
| Continuing previous session | Read first, then update as you progress                         |

## Template Structure

```markdown
# Power Apps Code App Memory Bank

> Last Updated: [TIMESTAMP]
> Session: [SESSION_ID or conversation context]

## Project Overview

| Property       | Value                          |
| -------------- | ------------------------------ |
| App Name       | [APP_NAME]                     |
| Project Path   | [FULL_PATH]                    |
| Environment    | [ENVIRONMENT_NAME]             |
| Environment ID | [ENVIRONMENT_GUID]             |
| App URL        | [APP_URL]                      |
| Created Date   | [DATE]                         |
| Status         | [In Progress/Created/Deployed] |

## User Preferences

### Design Preferences
- Theme: [Dark/Light]

### Technical Preferences
- Data Sources: [Dataverse, Azure DevOps, Teams, Excel, etc.]

## Completed Steps

### /create-code-app
- [x] Prerequisites validated (Node.js, pac CLI)
- [x] Authenticated and selected environment
- [x] Scaffolded from template
- [x] Initialized with pac code init
- [x] Built successfully
- [x] Deployed to Power Platform
- App URL: [URL]

### /add-dataverse
- [x] Added table: [TABLE_NAME]
- [x] Generated models and services
- [x] Built successfully

### /add-azuredevops
- [x] Added Azure DevOps connector
- [x] Applied HttpRequest fix
- [x] Built successfully

### /add-teams
- [x] Added Teams connector
- [x] Configured message parameters
- [x] Built successfully

### /add-excel
- [x] Added Excel Online connector
- [x] Configured workbook and table
- [x] Built successfully

### /add-onedrive
- [x] Added OneDrive for Business connector
- [x] Configured file operations
- [x] Built successfully

### /add-sharepoint
- [x] Added SharePoint Online connector
- [x] Configured list/library access
- [x] Built successfully

### /add-connector
- [x] Added connector: [CONNECTOR_NAME]
- [x] Built successfully

## Created Resources

### Data Sources

| Source       | Type      | Details                      |
| ------------ | --------- | ---------------------------- |
| [TABLE_NAME] | Dataverse | Columns: name, status, ...   |
| Azure DevOps | Connector | Operations: HttpRequest, ... |

### Generated Files

| File                                       | Source          |
| ------------------------------------------ | --------------- |
| `src/generated/models/[Table]Model.ts`     | Dataverse table |
| `src/generated/services/[Table]Service.ts` | Dataverse table |

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

1. **Create App**: `/create-code-app` (scaffolds and deploys a new code app)
2. **Add Dataverse**: `/add-dataverse` (adds Dataverse table with generated services)
3. **Add Azure DevOps**: `/add-azuredevops` (adds ADO connector with HttpRequest fix)
4. **Add Teams**: `/add-teams` (adds Teams messaging)
5. **Add Excel**: `/add-excel` (adds Excel Online connector)
6. **Add OneDrive**: `/add-onedrive` (adds OneDrive for Business connector)
7. **Add SharePoint**: `/add-sharepoint` (adds SharePoint Online connector)
8. **Add Office 365**: `/add-office365` (adds Office 365 Outlook connector)
9. **Add Connector**: `/add-connector` (adds any other connector)
10. **Manual**: Navigate to [PROJECT_PATH] and continue development
```

## Reading the Memory Bank

When reading the memory bank, extract:

1. **Project context**: Path, app name, environment, version
2. **Completed work**: Check checkboxes to know what's done
3. **User preferences**: Apply these without re-asking
4. **Created resources**: Know what data sources/connectors exist
5. **Current status**: Understand where to resume

## Writing Guidelines

1. **Be concise**: Use tables and lists, not paragraphs
2. **Be specific**: Include exact values, paths, GUIDs
3. **Timestamp updates**: Always update "Last Updated"
4. **Preserve history**: Add to notes, don't overwrite
5. **Track decisions**: Record why choices were made

## Integration with Skills

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
