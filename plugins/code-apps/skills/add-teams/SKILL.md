---
name: add-teams
description: Adds Microsoft Teams connector to a Power Apps code app. Use when sending Teams messages, posting to channels, or integrating with Teams chat.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add Teams

## Workflow

1. Check Memory Bank → 2. Add Connector → 3. Configure → 4. Build → 5. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Add Connector

**First, find the connection ID** (see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md)):

Run the `/list-connections` skill. Find the Teams connection in the output. If none exists, direct the user to create one using the environment-specific Connections URL — construct it from the active environment ID in context (from `power.config.json` or a prior step): `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** → search for the connector → Create.

```bash
pwsh -NoProfile -Command "pac code add-data-source -a teams -c <connection-id>"
```

### Step 3: Configure

Ask the user what Teams operations they need (send message, post to channel, etc.).

**PostMessageToConversation** -- sends a chat message via Flow bot:

```typescript
await TeamsService.PostMessageToConversation({
  "Post as": "Flow bot",
  "Post in": "Chat with Flow bot",
  "Post message request": {
    recipient: "<recipient-upn-or-id>", // UPN or Entra object ID
    messageBody: "<p>HTML message</p>", // HTML format
    isAlert: false,
    feedbackLoopEnabled: false
  }
});
```

Use `Grep` to find specific methods in `src/generated/services/TeamsService.ts` (generated files can be very large -- see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)).

### Step 4: Build

```powershell
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 5: Update Memory Bank

Update `memory-bank.md` with: connector added, configured operations, build status.
