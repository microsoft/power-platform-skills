---
name: setup
description: Use when Process Intelligence needs building, explicit cloud/account/environment configuration, sign-in, connection diagnostics, or recovery from an authentication error.
allowed-tools: Read, Bash, AskUserQuestion
---

# Set up Process Intelligence

Read the bundled [README](../../README.md) first. Use the absolute installed plugin directory
containing this skill for shell commands; host-provided `PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT` can
identify it. Do not assume the agent shell starts there. All scripts are inside this plugin.

**GCC, GCC High, DoD and Mooncake are not supported yet.**
`Public` is the commercial cloud configuration.
The CLI accepts five cloud values; configuration support does
not make an unsupported cloud available.

Confirm the user-approved cloud and environment ID. Do not ask for a tenant GUID up front for Public.
Resolve it from the selected environment; never infer it from `Default-<guid>`, access private
credential caches or guess the working environment.
Use `node server/mcp.mjs --help` for exact syntax and
[connection patterns](../../references/connection-patterns.md) for cloud/claims details.
Stop if the cloud is not one of the listed values; do not substitute Public or an arbitrary audience.

**Before connection or analytical use, show this privacy notice:** analytical results may contain
personal and business data, forwarded unredacted to the customer-selected host. Model routing,
history, retention, possible training use and geography depend on the customer's host/provider
settings and contracts. Review those settings and organizational requirements; do not certify
an arbitrary host/provider. Optional installation is not permission to disclose data.

Use AskUserQuestion to obtain explicit instruction or confirmation naming the selected environment
and host: "Do you instruct me to connect this selected environment to this selected host after
reviewing its data-handling settings?" Substitute the actual selections. Do not proceed to binding,
remote diagnostics or analytics until the user gives an explicit instruction covering both.
Environment-ID confirmation alone is insufficient. This is user-level integration instruction,
not tenant-admin consent or a plugin-enforced per-request gateway; existing authorization still applies.

1. Check Node.js 22/24 LTS and Azure CLI 2.54+ (`az version`).
   Use official installation guidance in the README; never install or change global settings automatically.
   The bundle is ready to run; source development uses `npm ci` then `npm run build`
   from this directory in a repository checkout, never during MCP launch.
   Profiles use `ProcessIntelligenceBridgeAzureCli` under the platform's per-user data directory.
2. Check the intended Azure CLI cloud and organizational account using supported read-only CLI commands.
   If sign-in is needed, have them run `az login --allow-no-subscriptions` themselves.
   Azure CLI owns shared credentials; login may affect other CLI consumers. The bridge never switches clouds/accounts.
3. For Public, run `node server/mcp.mjs resolve-environment --cloud Public --environment <environment-id>`.
   This explicit discovery step acquires a directory token and reads environment metadata. It needs
   directory-read access, creates no profile/cache, and returns a small JSON result on stderr.
   Confirm the returned target and the host-aware instruction above, then pass its `tenantId` and `environmentId` into
   `config --profile work --cloud Public --tenant <resolved-tenant-guid> --environment <environment-id>`.
   The config command remains offline. Discovery is Public-only: for another cloud or a lookup failure,
   preserve the error and use the manual path with an explicitly confirmed tenant GUID and selected cloud.
   Do not cycle tenants/resources, request extra consent or substitute the active CLI tenant.
   No `select`, custom client-id, browser/redirect flags, secrets or service-principal sessions.
4. The agent must run `node server/mcp.mjs login --profile work` using the absolute installed bundle
   path to bind the existing CLI session. This works without a TTY and opens no UI.
   Only `--sign-in true` requires a normal terminal; use direct terminal `az login` if device-code
   interaction is needed.
   Never collect tokens or raw auth output.
5. Run `diagnostics --profile work` for read-only CLI version/cloud/tenant/user-shape checks.
   Cold local diagnostics cannot verify the saved OID and report `boundAccountVerified: false`.
   Only with target authorization, use `--remote true` for token acquisition and MCP discovery.
   Confirm MCP discovery succeeds, not only token acquisition. No business tools are needed.
6. Call the discovered local `pi_activate_profile` with `{ "profile": "work", "remember": true }`.
   Confirm `pi_connection_status` is active, rediscover the analytical tools and use their actual
   schemas. Local activation notifies the host to refresh tools in this same session; do not restart
   Copilot, edit registrations or ask the user to set environment variables.
   The explicit choice is remembered for this client/installation, not machine-wide. Fresh server
   processes reuse it if the binding and Azure CLI session remain valid. Other active sessions keep
   their own selection. Explicit launch selection wins over the preference.

For repeated setup, check `pi_connection_status` first. If the intended profile is already active
and the integration instruction still applies, do not redo sign-in or config. Unchanged config and
silent binding preserve the revision. A stale/missing preference never selects another profile;
complete the indicated recovery and explicitly activate the intended name.
Marketplace loading supplies the MCP server before setup. Source development and `--plugin-dir`
examples are separate in the README; they are not steps for an already installed marketplace plugin.

Serve never opens UI. For a Conditional Access / CAE claims challenge, explain the policy failure
and ask the user to run `login --profile work --sign-in true` in a normal terminal, then call
`pi_activate_profile` in the existing session.
Do not store, decode or forward claims-challenge payloads. If the problem persists, ask the user's
administrator to review the policy; normal sign-in may not satisfy policies requiring specific claims.
Never change the client, resource or tenant as authentication recovery.
Account changes require explicit `login --profile work --switch-account true`; tenant/environment changes
require config, login and explicit activation. Revision/account changes cancel the stale remote
context but retain local recovery tools. Never replay interrupted business calls.
Logout invalidates only the plugin profile, never `az logout`.
Profiles are plaintext JSON without application-level encryption.
Account binding persists only the tenant-local OID alongside the tenant; usernames stay in RAM.
Use a non-personal profile label. Names can still contain identifying information.
For their exact fields, lifecycle and local export/removal, use connection patterns.

Preserve the safe error. Do not request admin consent, edit identity registrations or imply every AADSTS
failure is licensing. Direct access or consent problems to the user's administrator.
