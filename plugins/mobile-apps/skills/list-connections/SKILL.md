---
name: list-connections
description: Lists existing environment-scoped Power Platform connections and optional references for a mobile app without creating or changing them.
user-invocable: true
allowed-tools: Read, Bash, AskUserQuestion
model: haiku
---

**Shared instructions: [shared-instructions-core.md](${PLUGIN_ROOT}/shared/shared-instructions-core.md)** — read first.

# List Existing Connections

Read [selection and initialization](references/existing-selection.md).
The default, `--read-only`, and `--existing-only` paths are discovery only:
no connection creation, consent repair, environment initialization, or mutation.
Listing does not require an app `power.config.json` or Dataverse database.

## 1. Resolve the explicitly selected environment

Use the caller's exact `--environment-id` or ask which environment to inspect.
Do not substitute the current CLI environment or infer one from a display name.
In Player, use the selected catalogue environment and the shared question
transport for every clarification. Do not ask for credentials in chat.

## 2. Read the existing inventory

```bash
node "${PLUGIN_ROOT}/scripts/list-prototype-connections.js" \
  --environment-id "<environment-id>"
```

Optional `--api-id <exact-api-id>` limits the connector. Optional
`--references` additionally reads existing Dataverse connection references;
it never creates them. `--tenant-id` is an optional explicit auth tenant.
Output is JSON; do not add an unsupported `--json` flag.

The helper uses environment-scoped read-only APIs, bounded same-origin paging,
minimal fields and a stable `catalogRevision`. It does not derive connections
from `package.json`. Authentication/error responses are not empty inventories.
No references requested means `references: "not-requested"`, not “none exist”.
Reference discovery failures are surfaced; do not hide them as a complete list.

## 3. Present and preserve the exact selection

Show display name, exact API, connection ID or reference, environment and
availability. Only `availability: "available"` can be selected. Preserve the
selected ID/reference and catalogue revision; never pick the first match
automatically or silently switch references/connections.

Even caller-supplied IDs must match this environment/API inventory. A reference
is usable only when its exact bound connection is present and connected; another
connection for the same API is not an acceptable substitute.

Return the normalized selection documented in `existing-selection.md`.
Do not add a data source or initialize an app from this listing skill.

## Missing connections and explicit creation

An empty result means no existing connection was found in the selected
environment. Show **Create a connection in Power Apps, then refresh**, linking
to [Power Apps](https://make.powerapps.com/), plus a **Refresh** action.
Also show [Supported Power Apps connectors](https://learn.microsoft.com/en-us/connectors/connector-reference/connector-reference-powerapps-connectors).
That reference lists supported connector types, not the user's connections.
Do not scrape it into a claimed live inventory.

Do not create a connection/reference, repair consent, or initialize an app from
this listing. Authentication failures remain explicit errors, never empty-list
success. After the maker creates a connection in the portal, rerun the same
read-only listing and preserve the exact selected connection ID.
