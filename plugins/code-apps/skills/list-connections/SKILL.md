---
name: list-connections
description: Lists Power Platform connections in the current environment. Use when you need a connection ID before adding a connector to a code app (required on Power Apps CLI versions before 1.3.0), to choose between several connections, or to troubleshoot a connection.
user-invocable: true
allowed-tools: Bash
model: haiku
---

**📋 Shared Instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns (Windows CLI compatibility, memory bank, etc.).

# List Connections

Lists all Power Platform connections in the current environment using the Power Apps CLI.

On CLI 1.3.0+ (`PA_INLINE_CONNECTIONS=yes`), connector skills don't need this first: `pa app add data-source` finds or creates the connection itself (see [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md#connections)). Use this skill there to choose between several connections or to check what exists. On older CLIs it's the required first step before adding a connector.

## Workflow

1. Fetch Connections → 2. Present Results

---

### Step 1: Fetch Connections

> Resolve the CLI first (see [cli-binary.md](${PLUGIN_ROOT}/shared/cli-binary.md)): run as `$PA connection list` (`npx --no-install pa …`), never a bare `pa`. On `power-apps`-only projects, translate to `power-apps list-connections`.

```bash
pa connection list
```

To show only one connector's connections, add `--search '<connector name or ID>'`.

If the CLI reports that you're not signed in, run `pa auth login` (it opens the browser for sign-in), then retry.

**Other failures:**
- Non-zero exit for any reason other than auth: Report the exact output. STOP.
- No output or empty results: Verify the correct environment ID is set in `power.config.json`, then retry once.

### Step 2: Present Results

Show the connection list to the user. The **Connection ID** is what goes into `-c <connection-id>` when adding a data source. If the connector has several connections, let the user choose; don't pick one for them.

**If the needed connector has no connection:**

1. On CLI 1.3.0+, the connector's `/add-*` skill usually handles this: the add creates single sign-on connections itself, and otherwise hands creation to the user (see [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md#connections)).
2. To create one now, confirm with the user, then run `pa connection create --connector <connector-id>` yourself (`power-apps create-connection -a <connector-id>` on `power-apps`-only projects). Connectors whose only sign-in option is the user's Microsoft account are created silently. If the CLI says the connection needs a browser sign-in it can't do here, ask the user to run the same command in their own terminal from the project folder (or `npx --no-install pa connection create --connector <connector-id>` if `pa` isn't recognized). As a last resort, share the Connections URL using the active environment ID from context (from `power.config.json` or a prior step): `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection**.
3. Re-run `/list-connections` to get the new connection ID.
