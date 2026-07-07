---
name: add-datasource
description: Use when the user wants to add a data source to a mobile app but hasn't said which kind (Dataverse table, SharePoint list, or other connector).
user-invocable: true
allowed-tools: Read, Grep, Glob, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

# Add Data Source

Router skill that understands the user's goal and connects them to the right data source — without requiring them to know Power Platform terminology.

## Workflow

### Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md).

### Understand the Goal

1. **If `$ARGUMENTS` is provided or the caller already specified what's needed**, use it directly and skip the question below.
2. Otherwise, ask the user **what they want their app to do** — not which connector to use. Focus on the end goal. Example questions:
   - "What kind of data does your app need to work with?"
   - "What should your app be able to do? (e.g., search company info, manage tasks, send messages)"
3. Based on their answer, **recommend the best approach** and explain *why* it's the right fit. The user shouldn't need to know the difference between Dataverse, SharePoint, or other connectors — that's our job.

### Route to the Right Skill

| User's goal | Best approach | Invoke |
|---|---|---|
| Store and manage structured business data (custom tables, forms, CRUD) | Dataverse is the platform's native database | `/add-dataverse` |
| Invoke an existing Dataverse action/function/API | Discover with Power Apps CLI `find-dataverse-api`; this plugin only adds Dataverse table CRUD | `/add-connector` |
| Read lists, manage documents, integrate with SharePoint sites | SharePoint Online — dedicated skill with list creation support | `/add-sharepoint` |
| Invoke an existing Power Automate cloud flow | Use Power Apps CLI `list-flows` / `add-flow` support through the generic connector workflow | `/add-connector` |
| Anything else — Teams messages, Excel data, OneDrive files, Office 365 email/calendar, Azure DevOps, Copilot Studio, custom connectors | Generic connector (we'll figure out the right one) | `/add-connector` |

**Note:** Dedicated skills for Teams, Excel, OneDrive, Office 365, and Azure DevOps are planned for v1. Until then, `/add-connector` handles all of them — it covers every connector the platform supports and generates the same `src/generated/` service layer.

**Important routing rules:**
- When the user wants to **perform actions** (send an email, post a Teams message, create a file), route to `/add-connector` with the connector name as the argument (e.g., `/add-connector office365`, `/add-connector teams`).
- When the user wants to **invoke a cloud flow**, route to `/add-connector` and tell it to use `npx power-apps list-flows --json` followed by `npx power-apps add-flow --flow-id <flow-guid> --non-interactive` from the app root.
- When the user wants to **invoke a Dataverse action/function/API** rather than table CRUD, route to `/add-connector` and tell it to use `npx power-apps find-dataverse-api --search '<operation-name>' --json`; then stop and explain that this plugin only adds Dataverse table CRUD.
- When the user wants to **store or query structured business data** with custom schema, route to `/add-dataverse`.

4. If the user wants multiple capabilities, invoke each skill in sequence.

### When the User Isn't Sure

If the user describes a vague goal (e.g., "I need data for my app"), guide them:

1. Ask what their app does and who uses it
2. Ask what data they need to display or interact with
3. Recommend the simplest approach that meets their needs
4. Explain the recommendation in plain language (avoid jargon like "connector", "Dataverse", "tabular data source" unless the user uses those terms first)
