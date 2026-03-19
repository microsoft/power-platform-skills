---
name: add-datasource
description: Adds a data source or connector to a Power Apps code app. Asks what the user wants to accomplish and routes to the appropriate specialized skill.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add Data Source

Router skill that understands the user's goal and connects them to the right data source -- without requiring them to know Power Platform terminology.

## Workflow

### Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md).

### Understand the Goal

1. **If `$ARGUMENTS` is provided or the caller already specified what's needed**, use it directly and skip the question below.
2. Otherwise, ask the user **what they want their app to do** -- not which connector to use. Focus on the end goal. Example questions:
   - "What kind of data does your app need to work with?"
   - "What should your app be able to do? (e.g., search company info, manage tasks, send messages)"
3. Based on their answer, **recommend the best approach** and explain *why* it's the right fit. The user shouldn't need to know the difference between Dataverse, SharePoint, or other connectors -- that's our job.

### Route to the Right Skill

Map the user's goal to the appropriate skill:

| User's goal | Best approach | Invoke |
|-------------|---------------|--------|
| Store and manage structured business data (custom tables, forms, CRUD) | Dataverse is the platform's native database | `/add-dataverse` |
| Track work items, bugs, builds, or pipelines | Azure DevOps connector | `/add-azuredevops` |
| Send or read Teams messages, post to channels | Teams connector | `/add-teams` |
| Read/write Excel spreadsheet data | Excel Online (Business) connector | `/add-excel` |
| Upload, download, or manage files | OneDrive for Business connector | `/add-onedrive` |
| Work with SharePoint lists or document libraries | SharePoint Online connector | `/add-sharepoint` |
| Send emails, read inbox, manage calendar events | Office 365 Outlook connector | `/add-office365` |
| Invoke an AI agent or copilot built in Copilot Studio | Copilot Studio connector | `/add-mcscopilot` |
| Something else or not sure | Generic connector (we'll figure it out) | `/add-connector` |

**Important routing rules:**
- When the user wants to **perform actions** (send an email, post a message, create a file), use the specific connector for that action (e.g., `/add-office365` for sending email, `/add-teams` for posting messages).

4. If the user wants multiple capabilities, invoke each skill in sequence.

### When the User Isn't Sure

If the user describes a vague goal (e.g., "I need data for my app"), guide them:

1. Ask what their app does and who uses it
2. Ask what data they need to display or interact with
3. Recommend the simplest approach that meets their needs
4. Explain the recommendation in plain language (avoid jargon like "connector", "Dataverse", "tabular data source" unless the user uses those terms first)
