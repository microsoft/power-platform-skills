---
name: setup
description: Use when Process Intelligence needs building, explicit cloud/account/environment configuration, sign-in, connection diagnostics, or recovery from an authentication error.
allowed-tools: Read, Bash, AskUserQuestion
---

# Set up Process Intelligence

Read the bundled [README](../../README.md) first. Resolve the root from `PLUGIN_ROOT`, then
`CLAUDE_PLUGIN_ROOT`, then the current plugin directory. All scripts are inside this plugin.

**GCC, GCC High, DoD and Mooncake are not supported yet.**
`Public` is the commercial cloud configuration. TIP1 and TIP2 are internal configurations,
not public onboarding options. The CLI accepts seven cloud values; configuration support does
not make an unsupported cloud available.

Confirm the user-approved cloud and environment ID. Do not ask for a tenant GUID up front for Public.
Resolve it from the selected environment; never infer it from `Default-<guid>`, access private
credential caches or guess the working environment.
Use `node server/mcp.mjs --help` for exact syntax and
[connection patterns](../../references/connection-patterns.md) for cloud/claims details.

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

1. Check Node.js 22/24 LTS and Azure CLI 2.54+ (`az version`); claims login needs 2.80+.
   Use official installation guidance in the README; never install or change global settings automatically.
   The bundle is ready to run; source development uses `npm ci` then `npm run build`
   from this directory in a repository checkout, never during MCP launch.
   Profiles use `ProcessIntelligenceBridgeAzureCli` storage with no migration from other stores.
2. Have the user verify the intended Azure CLI cloud and organizational account in a normal terminal.
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
4. Ask the user to run `node server/mcp.mjs login --profile work` in their terminal to bind that session.
   This opens no UI. `--sign-in true` explicitly permits Azure CLI browser login; use direct terminal
   `az login` if device-code interaction is needed. Never collect tokens or raw auth output.
5. Run `diagnostics --profile work` for read-only CLI version/cloud/tenant/user-shape checks.
   Cold local diagnostics cannot verify the saved OID and report `boundAccountVerified: false`.
   Only with target authorization, use `--remote true` for token acquisition and MCP discovery.
   Confirm MCP discovery succeeds, not only token acquisition. No business tools are needed.
6. Set `PM_BRIDGE_PROFILE=work` and an absolute `PLUGIN_ROOT` in the host environment.
   Use `copilot --plugin-dir <absolute-plugin-directory> -C "$HOME"` to start outside the plugin
   directory, avoiding an additional workspace load of its `.mcp.json`; Claude Code has an equivalent local loader.
   Do not change global registrations.

Serve never opens UI. A validated claims challenge requires explicit `login --profile work --sign-in true`
on CLI 2.80+, then restart. Do not omit claims or change the client, resource or tenant to bypass authentication.
Account changes require explicit `login --profile work --switch-account true`; tenant/environment changes
require config, login and restart. Logout invalidates only the plugin profile, never `az logout`.
Profile/challenge files are plaintext JSON protected by user ACLs/modes, not application encryption.
Account binding persists only the tenant-local OID alongside the tenant; usernames stay in RAM.
Use a non-personal profile label. Names and pending claims can still contain identifying information.
For their exact fields, lifecycle and secure local export/removal, use connection patterns.

Preserve the safe error. Do not request admin consent, edit identity registrations or imply every AADSTS
failure is licensing. Direct access or consent problems to the user's administrator.
