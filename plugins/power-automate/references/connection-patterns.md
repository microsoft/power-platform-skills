# Connection Resolution Patterns

> Note: Shell commands below require the [FlowAgent engine repo](https://github.com/matow_microsoft/flow-agent) cloned and built. Plugin users should use MCP tools instead.

## Discovering Connections

```bash
# List all connections for a connector (queries Dataverse)
node dist/cli.js list-connections --env=$ENV --connector=shared_teams

# List via PowerApps API (alternative, doesn't need Dataverse)
node dist/cli.js get-connections --env=$ENV --connector=shared_teams
```

## Auto-Resolving Connection References

```bash
# Auto-discover connections for multiple connectors
node dist/cli.js resolve-refs --env=$ENV --connectors=shared_teams,shared_office365

# With auto-create for missing connections
node dist/cli.js resolve-refs --env=$ENV --connectors=shared_teams --auto-create

# Verify connection health
node dist/cli.js resolve-refs --env=$ENV --connectors=shared_teams --verify
```

## Connection Reference Format

```json
{
  "shared_teams": {
    "connectionName": "shared-teams-xxxxxxxx",
    "source": "Embedded",
    "id": "/providers/Microsoft.PowerApps/apis/shared_teams",
    "tier": "NotSpecified"
  }
}
```

## Connection Modes

- **Embedded** — Flow uses its own stored credentials (default, recommended for API-triggered flows)
- **Invoker** — Flow uses the caller's credentials (requires X-MS-APIM-Tokens header)

```bash
# Check current modes
node dist/cli.js list-connection-modes --env=$ENV --flow=$FLOW

# Switch a connector to Embedded
node dist/cli.js set-connection-mode --env=$ENV --flow=$FLOW --connector=shared_teams --mode=Embedded
```

### Dataverse Special Case
When switching `shared_commondataserviceforapps` to Embedded, the CLI auto-adds:
```json
"connectionProperties": { "authentication": { "type": "ManagedServiceIdentity" } }
```

## Creating Connections

```bash
# Interactive (opens browser for OAuth consent)
node dist/cli.js create-connection --env=$ENV --connector=shared_teams

# Non-interactive (returns consent URL for manual auth)
node dist/cli.js create-connection --env=$ENV --connector=shared_teams --no-browser
```

## Sharing Connections

```bash
# Share with a user (CanUse or CanUseAndShare)
node dist/cli.js share-connection --env=$ENV --connector=shared_teams --connection=<name> \
  --principal=<user-object-id> --role=CanUse
```

## Critical Rules

1. **Always use `"source": "Embedded"`** for flows triggered via API/CLI. Invoker mode causes `InvokerConnectionOverrideFailed`.
2. **`list-connections` requires Dataverse** — if the environment lacks it, use `get-connections` instead (PowerApps API fallback).
3. **`resolve-refs` fallback chain**: Tries Dataverse first → PowerApps API on failure → reports `NO_CONNECTION_FOUND`.
