---
name: add-teams
description: Adds Microsoft Teams connector to a Power Apps code app. Use when sending Teams messages, posting to channels, or integrating with Teams chat.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add Teams

## Workflow

1. Check Memory Bank → 2. Add Connector → 3. Configure → 4. Build → 5. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Add Connector

Get the connection as described in [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md#connections).

**CLI 1.3.0+ (`PA_INLINE_CONNECTIONS=yes`):** tell the user that adding Teams may create a connection with their account, then run the add without `-c` and handle the result with the outcome table in connector-reference.md:

```bash
pa app add data-source --connector teams --non-interactive
```

**Older CLIs:** run `/list-connections` to find the Teams connection ID (if none exists, create one with `pa connection create` as described in connector-reference.md), then:

```bash
pa app add data-source --connector teams -c <connection-id>
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

Use `Grep` to find specific methods in `src/generated/services/TeamsService.ts` (generated files can be very large -- see [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)).

### Step 4: Build

```bash
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 5: Update Memory Bank

Update `memory-bank.md` with: connector added, configured operations, build status.
