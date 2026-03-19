---
name: list-connections
description: Lists Power Platform connections in the current environment. Use when you need a connection ID before adding a connector to a code app.
user-invocable: true
allowed-tools: Bash
model: haiku
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns (Windows CLI compatibility, memory bank, etc.).

# List Connections

Lists all Power Platform connections in the default environment using the Power Platform CLI (`pac`).

## Workflow

1. Fetch Connections → 2. Present Results

---

### Step 1: Fetch Connections

```bash
pwsh -NoProfile -Command "pac connection list"
```

If `pac` is not authenticated, tell the user to run `pwsh -NoProfile -Command "pac auth create"` and try again.

**Other failures:**
- Non-zero exit for any reason other than auth: Report the exact output. STOP.
- No output or timeout: Run `pwsh -NoProfile -Command "pac env list"` to verify pac can reach the environment, then retry once.

### Step 2: Present Results

Show the connection list to the user. The **Connection ID** is what goes into `-c <connection-id>` when adding a data source.

**If the needed connector is missing:**

1. Share the direct Connections URL using the active environment ID from context (from `power.config.json` or a prior step): `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection**
2. Search for and create the connector, then complete the sign-in/consent flow
3. Re-run `/list-connections` to get the new connection ID
