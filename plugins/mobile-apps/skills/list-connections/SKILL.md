---
name: list-connections
description: Use to find or create a Power Platform connection ID or reference for an Expo/React Native Power Apps mobile app.
user-invocable: true
allowed-tools: Bash
model: haiku
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — cross-cutting concerns (Windows CLI compatibility, memory bank, etc.).

# List Connections

Finds or creates a Power Platform connection with the Power Apps CLI. Returns the **Connection ID** or **Connection Reference** that callers feed into `npx pa app add data-source --non-interactive`.

## Workflow

1. Get Connection → 2. Present Results

---

### Step 1 — Get Connection

Use one of the supported paths below.

If the caller already provided a connection ID, validate the connector/API ID from context and return it as-is for `--connection-id`.

If the caller provided a connector API ID and needs a new connection, create it from the app root:

```bash
npx pa connection create --connector <api-id> --json --non-interactive
```

Use the returned `connectionId` for `--connection-id <connectionId>`. Optional display names are supported:

```bash
npx pa connection create --connector <api-id> --display-name '<display-name>' --json --non-interactive
```

Browser-based connection creation is disabled by default. If the connector is not SSO-eligible and the command reports that browser creation is disabled, tell the user to either set `POWERAPPS_CLI_ENABLE_BROWSER_CONNECTION=true` and rerun the command, or create the connection in the maker portal.

### Step 1b — Fetch Connection References When Solution-Aware

If the caller provided a solution ID and needs a connection reference name, list connection references from the app root:

```bash
npx pa connection list-references --solution-id <solution-id> --non-interactive
```

If a matching connection reference exists, return its reference name for `--connection-ref <connection-ref>`.

If `npx pa connection create --non-interactive` or `npx pa connection list-references --non-interactive` fails because of auth, wrong user, multiple accounts, no output, or timeout, follow shared-instructions command-failure handling and retry once.

**Other failures:**
- Non-zero exit for any reason other than auth: report the exact output. STOP.

### Step 2 — Present Results

Show the supported add path. A **Connection ID** goes into `--connection-id <connection-id>` when adding a data source. When Step 1b was requested, also show matching connection references; a **Connection Reference** goes into `--connection-ref <connection-ref>`.

**If the needed connector is missing:**

1. Share the direct Connections URL using the active environment ID from context (read from `power.config.json` `environmentId`):
   `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection**
2. Search for and create the connector, then complete the sign-in / consent flow
3. Rerun `/list-connections <api-id>` or provide the portal connection ID so the data-source skill can continue
