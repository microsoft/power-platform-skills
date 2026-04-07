---
name: add-mcscopilot
description: Adds Microsoft Copilot Studio connector to a Power Apps code app. Use when invoking Copilot Studio agents, sending prompts to agents, or integrating agent responses.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, LSP, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Add Microsoft Copilot Studio

## Workflow

1. Check Memory Bank → 2. Add Connector → 3. Configure → 4. Build → 5. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` per [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md).

### Step 2: Add Connector

**First, find the connection ID** (see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md)):

Run the `/list-connections` skill. Find the Microsoft Copilot Studio connection in the output. If none exists, direct the user to create one using the environment-specific Connections URL — construct it from the active environment ID in context (from `power.config.json` or a prior step): `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** → search for the connector → Create.

```bash
pwsh -NoProfile -Command "pac code add-data-source -a microsoftcopilotstudio -c <connection-id>"
```

### Step 3: Configure

Ask the user which Copilot Studio agent they want to invoke and what operations they need.

**Agent Setup Prerequisites** (manual steps the user must complete in Copilot Studio):

1. **Publish the agent**: In Copilot Studio, click Channels → select Teams → add to Teams → click Publish.
2. **Get the agent name**: Under Channels, click "Web app". The connection string URL contains the agent name. Example: `https://...api.powerplatform.com/copilotstudio/dataverse-backed/authenticated/bots/cr3e1_myAgent/conversations?...` — the agent name is `cr3e1_myAgent`.

**ExecuteCopilotAsyncV2** -- execute an agent and wait for the response:

Use the `ExecuteCopilotAsyncV2` operation (path: `/proactivecopilot/executeAsyncV2`). This is the **only** endpoint that reliably returns agent responses synchronously. It is the same endpoint used by Power Automate's "Execute Agent and wait" action.

```typescript
const result = await MicrosoftCopilotStudioService.ExecuteCopilotAsyncV2({
  message: "Your prompt or data here", // Can be a JSON string
  notificationUrl: "https://notificationurlplaceholder" // Required by API but unused; any URL works
});

// Response structure:
// result.responses — Array of response strings from the agent
// result.conversationId — The conversation ID
// result.lastResponse — The last response from the agent
// result.completed — Boolean indicating if the agent finished
```

**Important:** Agents often return responses as JSON strings. Parse the `responses` array to extract meaningful data:

```typescript
const agentResponse = result.responses?.[0];
if (agentResponse) {
  const parsed = JSON.parse(agentResponse);
  // Extract specific fields, e.g., parsed.trend_summary
}
```

Use `Grep` to find specific methods in the generated service file (generated files can be very large — see [connector-reference.md](${CLAUDE_PLUGIN_ROOT}/shared/connector-reference.md#inspecting-large-generated-files)).

#### Known Issues

- **ExecuteCopilot** (`/execute`) -- fire-and-forget, only returns `ConversationId`, not the actual response. Do NOT use this.
- **ExecuteCopilotAsync** (`/executeAsync`) -- returns 502 "Cannot read server response" errors. Do NOT use this.
- **Conversation turn model** (`/conversations/{ConversationId}`) -- only works after `/execute`, which doesn't provide responses. Do NOT use this.
- **Response casing varies** -- check all variations: `conversationId`, `ConversationId`, `conversationID`.

### Step 4: Build

```powershell
npm run build
```

Fix TypeScript errors before proceeding. Do NOT deploy yet.

### Step 5: Update Memory Bank

Update `memory-bank.md` with: connector added, agent name configured, configured operations, build status.
