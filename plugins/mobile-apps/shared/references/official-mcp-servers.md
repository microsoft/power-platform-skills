# Official MCP server bootstrap pins

The mobile-apps plugin ships four MCP entries in `.mcp.json`:

- `firebase` — official Firebase CLI MCP bootstrap via `firebase-tools@15.27.0`
- `gcloud` — official Google Cloud MCP bootstrap via `@google-cloud/gcloud-mcp@0.5.3`
- `azure` — official Azure MCP bootstrap via `@azure/mcp@2.0.5`
- `microsoft-learn` — hosted Microsoft Learn MCP at `https://learn.microsoft.com/api/mcp`

## Capability boundaries

### Firebase

The plugin narrows Firebase to the exact project/app/bootstrap tools it needs for
mobile push setup. Firebase's `--tools` filter requires the complete MCP tool
names, including the `firebase_` core prefix:

- `firebase_get_environment`
- `firebase_login`
- `firebase_update_environment`
- `firebase_list_projects`
- `firebase_get_project`
- `firebase_create_project`
- `firebase_list_apps`
- `firebase_create_app`
- `firebase_get_sdk_config`

This intentionally excludes deploy and security-rules helpers while retaining
the authentication and active-project tools required by `/setup-fcm` and
`/setup-apns`.

### gcloud

`@google-cloud/gcloud-mcp` exposes a single `run_gcloud_command` tool, so the
plugin constrains it with a checked-in allowlist at
`${PLUGIN_ROOT}/shared/mcp/gcloud-allowlist.json`.

`run_gcloud_command` prepends the `gcloud` executable itself, so workflow
examples and callers must pass `args` starting with the subcommand (`config`,
`iam`, `services`, etc.), not a literal `"gcloud"` first token.

The allowlist is scoped to the Google-side operations the push/WIF workflows
actually need today: project inspection, API enablement, workload-identity
pool/provider management, service-account IAM, and custom-role management.

### Azure

The Azure MCP bootstrap stays in namespace mode and exposes only these
namespaces:

- `subscription`
- `group`
- `role`
- `appservice`
- `functionapp`

`keyvault` is intentionally not exposed because GA `2.0.5` publishes
value-carrying secret operations but no safe vault/secret metadata-list tool.
`deploy` is also excluded because the push workflows do not use its generic
planning/guidance tools for Function deployment. Secret-safe Key Vault writes
and unsupported Function deployment edges remain the explicitly documented
`az` exceptions.

The pin for `firebase-tools` stays on `15.27.0` because live npm metadata on
2026-08-24 showed `15.28.1` only on GitHub main / unpublished.

The pin for `@azure/mcp` was resolved from npm metadata on 2026-08-24 by taking
the latest non-prerelease GA version (`2.0.5`) instead of the prerelease
`latest` dist-tag.

## Workflow readiness gates and `/mcp` recovery

These push workflows require the listed official MCP server/tool surfaces
before any cloud mutation or read-back. If a required server is missing,
disconnected, or missing a required tool, give these
Copilot CLI steps in this exact order:

```text
/mcp
/setup
/restart
/mcp
```

Require the second `/mcp` check to show the named server as **connected** and
the required tool(s) present before continuing. Firebase and Azure workflows
remain blocked when their required MCP surfaces are unavailable. The sole
pre-readiness exception is `/setup-push-wif`: after the recovery sequence
fails, it may use the official authenticated `gcloud` CLI through
`scripts/run-allowlisted-gcloud.js`. Never call `gcloud` directly for
provisioning, add commands outside the checked-in allowlist during an active
provisioning run, or extend this exception to Firebase or Azure.

| Workflow | Required server(s) | Required tool(s) that must be visible before the workflow continues |
|---|---|---|
| `/setup-fcm` | `firebase` | `mcp__firebase__firebase_get_environment`, `mcp__firebase__firebase_login`, `mcp__firebase__firebase_update_environment`, `mcp__firebase__firebase_list_projects`, `mcp__firebase__firebase_get_project`, `mcp__firebase__firebase_create_project`, `mcp__firebase__firebase_list_apps`, `mcp__firebase__firebase_create_app`, `mcp__firebase__firebase_get_sdk_config` |
| `/setup-apns` | `firebase` | `mcp__firebase__firebase_get_environment`, `mcp__firebase__firebase_login`, `mcp__firebase__firebase_update_environment`, `mcp__firebase__firebase_list_projects`, `mcp__firebase__firebase_get_project`, `mcp__firebase__firebase_list_apps` |
| `/setup-push-wif` | `azure`; `gcloud` preferred | `mcp__azure__subscription`, `mcp__azure__group`, `mcp__azure__role`; use `mcp__gcloud__run_gcloud_command` when available, otherwise the guarded official CLI fallback |
| `/setup-push-service-account` | `azure` | `mcp__azure__subscription`, `mcp__azure__group`, `mcp__azure__role`, `mcp__azure__functionapp`, `mcp__azure__appservice` |
