# Dataverse Prerequisites

Shared prerequisite steps for skills that interact with the Dataverse OData Web API. Used by `setup-datamodel`, `add-sample-data`, and any future skills that need Dataverse API access.

---

## 1. Check PAC CLI

Run `pac env who` to get the current environment URL:

```bash
pac env who
```

Extract the `Environment URL` (e.g., `https://org12345.crm.dynamics.com`). Store as `envUrl`.

**If `pac env who` fails**: Tell the user to authenticate first with `pac auth create`.

## 2. Get Azure CLI Token & Verify API Access

Run the shared script to obtain an Azure CLI token and verify Dataverse API access in one step:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-dataverse-access.js" <envUrl>
```

On success (exit 0), it outputs JSON to stdout with `token`, `userId`, `organizationId`, and `tenantId`. On failure (exit 1), stderr explains the issue (missing `az login`, expired token, etc.).
