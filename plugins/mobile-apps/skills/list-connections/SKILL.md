---
name: list-connections
description: Use when the user asks to find, create, or look up a Power Platform connection ID or connection reference for the current environment.
user-invocable: true
allowed-tools: Bash
model: haiku
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — cross-cutting concerns (Windows CLI compatibility, memory bank, etc.).

# List Connections

Finds or creates a Power Platform connection with the Power Apps CLI. Returns the **Connection ID** or **Connection Reference** that callers feed into `npx power-apps add-data-source`.

## Workflow

1. Get Connection → 2. Present Results

---

### Step 1 — Get Connection

Use one of the supported paths below.

If the caller already provided a connection ID, validate the connector/API ID from context and return it as-is for `--connection-id`.

If the caller provided a connector API ID and needs a new connection, create it from the app root:

```bash
npx power-apps create-connection --api-id <api-id> --json
```

Use the returned `connectionId` for `--connection-id <connectionId>`. Optional display names are supported:

```bash
npx power-apps create-connection --api-id <api-id> --display-name '<display-name>' --json
```

Browser-based connection creation is disabled by default. If the connector is not SSO-eligible and the command reports that browser creation is disabled, tell the user to either set `POWERAPPS_CLI_ENABLE_BROWSER_CONNECTION=true` and rerun the command, or create the connection in the maker portal.

### Step 1b — Fetch Connection References When Solution-Aware

If the caller provided a solution ID and needs a connection reference name, list connection references from the app root:

```bash
npx power-apps list-connection-references --solution-id <solution-id> --json
```

If a matching connection reference exists, return its reference name for `--connection-ref <connection-ref>`.

If `npx power-apps create-connection` or `list-connection-references` fails because of auth, wrong user, multiple accounts, no output, or timeout, follow shared-instructions command-failure handling and retry once.

**Other failures:**
- Non-zero exit for any reason other than auth: report the exact output. STOP.

### Step 2 — Present Results

Show the supported add path. A **Connection ID** goes into `--connection-id <connection-id>` when adding a data source. When Step 1b was requested, also show matching connection references; a **Connection Reference** goes into `--connection-ref <connection-ref>`.

**If the needed connector is missing:**

1. Share the direct Connections URL using the active environment ID from context (read from `power.config.json` `environmentId`):
   `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection**
2. Search for and create the connector, then complete the sign-in / consent flow
3. Rerun `/list-connections <api-id>` or provide the portal connection ID so the data-source skill can continue
