---
name: list-connections
description: Use when the user asks to list, find, or look up a Power Platform connection ID for the current environment.
user-invocable: true
allowed-tools: Bash
model: haiku
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — cross-cutting concerns (Windows CLI compatibility, memory bank, etc.).

# List Connections

Lists Power Platform connections with the Power Apps CLI. Returns the **Connection ID** or **Connection Reference** that callers feed into `npx power-apps add-data-source`.

## Workflow

1. Fetch Connections → 2. Present Results

---

### Step 1 — Fetch Connections

Prefer the Power Apps CLI command first because it returns raw connection IDs in the same shape expected by `npx power-apps add-data-source --connection-id`:

```bash
npx power-apps list-connections --json
```

If the user names a connector, filter by display name or connector ID:

```bash
npx power-apps list-connections --search '<connector-name-or-api-id>' --json
```

Return its `apiId` and `connectionId` for `--api-id <apiId> --connection-id <connectionId>`.

### Step 1b — Fetch Connection References When Solution-Aware

If the caller provided a solution ID and needs a connection reference name, list connection references from the app root:

```bash
npx power-apps list-connection-references --solution-id <solution-id> --json
```

If a matching connection reference exists, return its reference name for `--connection-ref <connection-ref>`.

If `npx power-apps list-connections` fails because of auth, wrong user, multiple accounts, no output, or timeout, follow shared-instructions command-failure handling and retry once.

**Other failures:**
- Non-zero exit for any reason other than auth: report the exact output. STOP.

### Step 2 — Present Results

Show raw connections first. A **Connection ID** goes into `--connection-id <connection-id>` when adding a data source. When Step 1b was requested, also show matching connection references; a **Connection Reference** goes into `--connection-ref <connection-ref>`.

**If the needed connector is missing:**

1. Share the direct Connections URL using the active environment ID from context (read from `power.config.json` `environmentId`):
   `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection**
2. Search for and create the connector, then complete the sign-in / consent flow
3. Re-run `/list-connections` to get the new connection ID
