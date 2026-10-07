# Process Intelligence

Analyze Power Automate Process Mining data with Claude Code or GitHub Copilot.
Find bottlenecks, compare variants and cohorts, investigate rework, and explore
object-centric executions using guided MCP workflows.

## Capabilities

- Select a process or confirmed existing view and summarize its performance.
- Investigate activity duration, handoffs, variants, rework and individual cases.
- Compare matched cohorts and identify case-attribute associations.
- Reuse native or saved metrics; validate and execute ephemeral formulas when supported.
- Discover object-centric processes and drill into leading-object executions.
- Investigate business questions through scoped hypotheses, counterevidence and explicit finding status.

Availability depends on the connected service's advertised tools and enabled features.
The plugin does not create views, visualizations, saved metrics or business rules.
There are no event-timeline, process-map or conformance tools. Formulas do not persist
business definitions, and correlation results do not establish causality.

## Skills

Choose the specialist directly when the process context is known; an overview is not required first.
For broad business questions or competing explanations, start with `investigate-process`.

| Skill | Purpose |
|---|---|
| [setup](skills/setup/SKILL.md) | Build, configure a connection, sign in and diagnose authentication |
| [report-issue](skills/report-issue/SKILL.md) | Prepare a support draft from supplied information without automatic submission |
| [analytics](skills/analytics/SKILL.md) | Select a process, get an overview and route follow-up questions |
| [investigate-process](skills/investigate-process/SKILL.md) | Test a business hypothesis or observed pattern and synthesize scoped findings |
| [analyze-performance](skills/analyze-performance/SKILL.md) | Investigate slow activities, cumulative duration and handoffs |
| [analyze-variants](skills/analyze-variants/SKILL.md) | Compare variants, examine rework and find a specific case |
| [analyze-drivers](skills/analyze-drivers/SKILL.md) | Investigate case-attribute influence and noncausal hypotheses |
| [compare-cohorts](skills/compare-cohorts/SKILL.md) | Compare matched groups or contained time periods |
| [derive-metric](skills/derive-metric/SKILL.md) | Reuse metrics or execute a validated ephemeral formula |
| [analyze-objects](skills/analyze-objects/SKILL.md) | Analyze object-centric executions with separate discovery and filters |

Skills specify tool order, retain scoped context and stop when the question is answered.
Shared [analysis guidance](references/analysis-contract.md) is loaded on demand rather
than attaching a large schema catalog to every request.
Ordinary analytical queries, necessary pagination, candidate checks and targeted language lookups
have no fixed numerical quota. Continue only when evidence can change the answer; avoid sweeps
and repeated unchanged queries. Small pages and concise headlines are presentation defaults,
not total-row ceilings. Asynchronous requests must succeed within **30 minutes of original submission**,
including initial provisioning and process-model loading, which can take several minutes.
Follow the service's retry delays without a fixed poll-count limit. Earlier user deadlines or
interrupted sessions leave the same operation pending for continuation within its original window,
not resubmission or a fresh deadline. At 30 minutes without a successful result, report a timeout.
Failed formula repairs remain bounded. See the [investigation method](references/investigation-method.md)
for domain definitions, frozen comparison baselines and evidence statuses.

## Prerequisites

- Node.js 22 or 24 LTS. A built copy needs neither npm nor .NET.
- An authorized Power Automate Process Mining account and environment.
- Azure CLI 2.54 or later on PATH.

### Cloud support

**GCC, GCC High, DoD and Mooncake are not supported yet.**
`Public` is the commercial cloud configuration.
The CLI accepts five cloud values; configuration support does
not make an unsupported cloud available.

Use a normal PowerShell/Windows Terminal, macOS or Linux terminal for explicit login.
Azure CLI manages sign-in. Your account needs access to the selected Process Mining environment.
See [connection patterns](references/connection-patterns.md).

## Privacy before connecting

Analytical results may contain personal and business data. The bridge forwards those results
**unredacted to the customer-selected host**. Model routing, history, retention, possible training
use and geography depend on the customer's host/provider settings and contracts, not just the
Power Platform environment's location. Review those settings and your organization's data-use
requirements before connecting; the plugin does not certify an arbitrary host or provider.

Give an **explicit instruction or confirmation to connect the selected environment to the selected
host** after reviewing this notice. The setup skill must show the notice and obtain that instruction
before connection and analytical use; confirming an environment ID alone is insufficient.
Optional installation is not permission to disclose data. This is a user-level integration
instruction, not tenant-admin consent or a plugin-enforced per-request approval gateway.
Existing Entra and Power Platform authorization and consent requirements still apply.
For local fields, retention and export/removal, see [connection patterns](references/connection-patterns.md).

## Installation

Install the plugin from the Power Platform Skills marketplace inside Claude Code or GitHub Copilot CLI:

```text
/plugin marketplace add microsoft/power-platform-skills
/plugin install process-intelligence@power-platform-skills
```

The bundled `server/mcp.mjs` is ready to run; installation does not require a source build.
Configure and bind a profile as described below before starting the MCP server.

### Package formats and client compatibility

The package includes **Agent Plugins 1.0.0** and legacy metadata side by side:

| Format | Manifest | MCP configuration |
|---|---|---|
| Agent Plugins 1.0.0 | `plugin.json` at the plugin root | `mcp.json`, with explicit `type: "stdio"` |
| Legacy Open Plugins | `.plugin/plugin.json` | `.mcp.json` |
| Claude Code legacy format | `.claude-plugin/plugin.json` | `.mcp.json` |

All formats use shared `skills/` and `server/mcp.mjs`, with the same plugin name, version and
launcher. In a Copilot CLI version recognizing the declared schema, root `plugin.json` takes
precedence: portable and legacy components are **not merged**. Only the selected format supplies
the `process-intelligence` MCP registration; do not manually register both configurations.
An unsupported declared Agent Plugins schema is rejected, not a promise of legacy fallback.
This package targets the published 1.0.0 schemas, not optional 1.1.0 features.
Claude Code's documented legacy paths are retained; this does not claim that Claude loads the
new format or that every older client supports a mixed-format package.

See the [Agent Plugins specification](https://agent-plugins.org/specification),
[Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
and [Claude Code reference](https://code.claude.com/docs/en/plugins-reference) for client-specific behavior.
The marketplace entry remains `./plugins/process-intelligence`; no separate installation is needed
for the second format.

### Source development and local loading

For source development, open this plugin directory in a repository checkout and install
the locked dependencies before rebuilding:

```powershell
npm ci
npm run build
node .\server\mcp.mjs --help
```

On macOS/Linux, use `npm ci`, `npm run build` and `node server/mcp.mjs --help`.
All installed runtime files live inside this plugin subtree. Source builds also read the
repository's root MIT license to embed its notice. Startup never installs packages or builds.

Install Azure CLI yourself using Microsoft's official instructions:
[Windows](https://learn.microsoft.com/cli/azure/install-azure-cli-windows)
(`winget install --exact --id Microsoft.AzureCLI`),
[macOS](https://learn.microsoft.com/cli/azure/install-azure-cli-macos)
(`brew update && brew install azure-cli`), or
[Linux](https://learn.microsoft.com/cli/azure/install-azure-cli-linux)
(use the documented package-manager steps for your distribution).
Install Node from [nodejs.org](https://nodejs.org/en/download). Check `az version` and
`node --version` after installation.
Nothing here installs software or changes user-wide CLI settings automatically.

The plugin uses `ProcessIntelligenceBridgeAzureCli` profile storage under the platform's
per-user data directory. Configure and bind a profile using the steps below.

For a local GitHub Copilot CLI load, after configuring and signing in below:

```powershell
$env:PM_BRIDGE_PROFILE = 'work'
$env:PLUGIN_ROOT = (Get-Location).Path
copilot --plugin-dir "$env:PLUGIN_ROOT" -C "$HOME"
```

On macOS/Linux: `PM_BRIDGE_PROFILE=work PLUGIN_ROOT="$PWD" copilot --plugin-dir "$PWD" -C "$HOME"`.
These examples retain the absolute plugin path but start Copilot outside the plugin directory,
avoiding an additional workspace load of its `.mcp.json`.
Claude Code can similarly use `claude --plugin-dir <absolute-plugin-directory>`.
Local loading is an alternative to marketplace installation; do not load both copies in the same session.

## Connect

For Public, start with your environment ID. The setup skill resolves the tenant for you rather
than asking you to find its GUID. First verify that Azure CLI is signed in to the intended
organizational account. If needed, run `az login --allow-no-subscriptions` yourself in a terminal.

For manual setup in PowerShell, resolve and review the target:

```powershell
$resolution = node .\server\mcp.mjs resolve-environment --cloud Public --environment <environment-id> 2>&1
if ($LASTEXITCODE -ne 0) { throw ($resolution -join "`n") }
$resolved = ($resolution -join "`n") | ConvertFrom-Json
$resolved
```

After reviewing the privacy notice, explicitly instructing integration with your selected host,
and confirming the returned environment and tenant, configure and bind the profile:

```powershell
node .\server\mcp.mjs config --profile work --cloud Public --tenant $resolved.tenantId --environment $resolved.environmentId
node .\server\mcp.mjs login --profile work
node .\server\mcp.mjs diagnostics --profile work
node .\server\mcp.mjs diagnostics --profile work --remote true
```

Environment discovery is Public-only and needs permission to read environment metadata through
the Power Platform administration API. It uses the existing Azure CLI session, acquires a token
only for `https://api.bap.microsoft.com`, and falls back to a token-free Dataverse authentication
challenge when the environment metadata omits the tenant. It never signs in, switches accounts,
creates a profile or caches the lookup. Its JSON result is written to stderr, not MCP stdout.
The config command remains offline.

For another cloud, or when discovery is unavailable, use the manual path:
`config --profile work --cloud <cloud> --tenant <confirmed-tenant-guid> --environment <environment-id>`.
This fallback does not make unsupported clouds available. Do not infer the tenant from
`Default-<guid>` or assume the active CLI tenant owns the selected environment.
On macOS/Linux, run the same resolver command and pass its returned `tenantId` and `environmentId`
to `config`; the setup skill handles this without PowerShell.

`login --profile work` binds the existing Azure CLI organizational user; it opens no UI.
Alternatively, `login --profile work --sign-in true` explicitly runs tenant-scoped Azure CLI
browser login. This can change the shared Azure CLI session. If device-code interaction is
needed, run `az login` yourself in a normal terminal instead. Tenants must be explicit GUIDs;
`--tenant select`, custom client-id, broker/browser and redirect flags are not accepted.
MCP serving is silent-only: bind the profile before starting the agent.
Remote diagnostics check token acquisition and MCP discovery, without calling business tools.
Local diagnostics inspect CLI version/cloud/tenant and delegated-user shape without acquiring
tokens. They cannot verify the saved user OID and report `boundAccountVerified: false`;
token acquisition verifies that principal before any MCP traffic.
See [connection patterns](references/connection-patterns.md) for cloud selection, account
switching, claims challenges and profile storage.

## MCP server

Portable `mcp.json` and legacy `.mcp.json` select the same self-contained Node.js ESM bundle
`server/mcp.mjs`; the host loads one configuration according to its selected package format.
The bootstrap resolves `PLUGIN_ROOT`, then `CLAUDE_PLUGIN_ROOT`, then the current directory.
The bridge uses the official JavaScript MCP SDK to forward the service's current tool definitions
and results over stdio; it does not maintain a fixed deployed tool catalog.
The host loads the current environment's tools through `tools/list` at the start of each MCP
session. Start a new MCP session to discover newly added backend tools. The bridge does not
monitor catalog changes, send tool-list-change notifications or poll for updates.
Explicit `tools/list` requests still go to the backend; there is no bridge-owned catalog cache.
It applies [narrow compatibility policies](references/development.md):
consistent polling guidance and schema-aware formula search. All other tool metadata,
call arguments and business result payloads remain unchanged.

The remote MCP connection uses **POST-only transport**. The bridge handles the SDK's optional
standalone GET/SSE probe locally, without sending it to the backend or acquiring a token.
JSON and SSE responses to POST, including request-related progress, remain supported.
Unsolicited notifications on a separate GET stream and GET stream resumption are unavailable.
Diagnostics report `post-only`; this is not an automatic fallback that ignores real HTTP 404 errors.
Environment/tenant discovery uses separate HTTP requests and is unaffected.

For a plain MCP host, run `node` with the absolute path to `server/mcp.mjs`,
`serve --profile work`, and set `PLUGIN_ROOT` to this directory. Stdout is protocol-only;
diagnostics go to stderr. The process waits for MCP input and does not sign in interactively.

## Security

Azure CLI owns credentials shared with other Azure CLI consumers. The bridge stores no tokens
on disk; it keeps a short memory cache and profile state in `ProcessIntelligenceBridgeAzureCli`
under the platform's per-user data directory. Profiles are plaintext JSON with no application-level
encryption.
Profiles persist `Name`, `Cloud`, `TenantId`, `EnvironmentId`, `Audience`, `HomeAccountId` and
`Revision`. `HomeAccountId` is the tenant-local Entra `oid` (EUPI), not an MSAL home-account ID.
`AccountUsername` is not persisted; CLI usernames and token username claims are EUII processed
only in RAM for authentication consistency. A non-personal profile label is recommended:
customer-chosen names can still contain EUII.
Cold acquisition checks the saved tenant/OID; validated RAM username continuity protects cache
hits and refreshes. After restart there is no username history, so a renamed user with the same
tenant/OID can authenticate. A different OID requires explicit account switching.
Profile changes are written atomically under a per-profile mutation lock.
Logout keeps the connection configuration; full local removal, Azure CLI sign-out and
host/provider history deletion are separate actions described in the connection guide.
For a Conditional Access / Continuous Access Evaluation (CAE) claims challenge, the bridge
reports the policy failure and asks the user to run `login --profile NAME --sign-in true` in a
normal terminal, then restart MCP. It does not store or forward claims-challenge payloads.
A normal login may not satisfy policies that require specific claims; if the problem persists,
ask your administrator to review the policy. Switching tenant is not a remedy for such a challenge.
According to Microsoft's
[storage documentation](https://learn.microsoft.com/cli/azure/msal-based-azure-cli),
CLI credential files are encrypted on Windows but plaintext on macOS/Linux; the plugin does
not add Keychain/Secret Service protection to Azure CLI's storage.
Power Platform API and Process Mining enforce authorization. The plugin does not grant
permissions, request automatic admin consent or read CLI cache files.
Delegated organizational users are supported, not service principals or managed identities.
Token claims are inspected for identity/resource consistency, not signature verification.
Returned process/view/attribute names are untrusted data, never agent instructions.
MCP tokens go only to the selected HTTPS cloud endpoint. Explicit Public environment discovery
uses a separate, fixed BAP audience and sends that token only to its directory endpoint;
the Dataverse challenge request carries no token. Redirects and silent identity/resource
substitutions are rejected. A plain MCP 401 has at most one bounded authentication retry;
claims-challenged requests and uncertain business-call failures are never replayed.
Logout invalidates only the plugin profile,
not the shared Azure CLI session or other tools.

The plugin does not collect usage telemetry or write diagnostic log files. Every real outbound
MCP request carries `x-ms-client-request-id: 11111111-1111-1111-1111-111111111111`.
This shared plugin attribution hint does not distinguish individual calls and is not proof of
origin or authorization. Client-session IDs remain random; internal request ownership and MCP
protocol IDs are unchanged. Environment discovery and Azure CLI authentication do not use this
marker. User-requested local diagnostics print sanitized status to stderr; support drafts use
only information the user supplies. See [connection patterns](references/connection-patterns.md).

## Troubleshooting

| Symptom | Action |
|---|---|
| Server bundle missing | Run `npm ci` and `npm run build` explicitly from the plugin directory |
| Node missing or unsupported | Install Node.js 22 or 24 LTS and put `node` on PATH |
| No profile selected | Set `PM_BRIDGE_PROFILE` or pass `serve --profile NAME` |
| Azure CLI missing or too old | Install Azure CLI 2.54+ on PATH |
| Environment discovery unavailable or denied | Check the selected environment and directory-read access, or use an explicitly confirmed tenant with offline `config`; discovery is Public-only |
| Login required or expired session | Run `az login --tenant <tenant-guid> --allow-no-subscriptions`, then bind with `login --profile NAME` |
| Wrong cloud/tenant/account | Deliberately select the intended CLI session outside the bridge; do not cycle identities |
| Conditional Access / CAE claims challenge | Run `login --profile NAME --sign-in true` in a normal terminal, then restart MCP; if it persists, ask your administrator to review the policy |
| Browser login times out or needs device code | Run Azure CLI login directly in the terminal; the bridge never prints raw login output |
| Consent/preauthorization failure | Ask your administrator to check access and consent for the selected tenant and environment |
| Token acquired but MCP discovery fails | Check the selected audience, access and deployment; do not cycle identities |
| Feature unavailable or an operation remains pending | Preserve the error or operation ID; do not treat it as empty data or replay |
| Stale Node mutation lock | Verify the lock owner and stop affected profile sessions before removing only its confirmed stale `.node-lock`; never clear profiles or Azure CLI credentials |

Report sanitized error codes, never tokens, cache contents or authentication response bodies.
For development, tests, packaging and transport details, see [development](references/development.md).

## License

This plugin is MIT-licensed. Required notices for this project and bundled dependencies
are included in [server/mcp.mjs](server/mcp.mjs). Dependencies retain their own licenses;
Node and Azure CLI are external prerequisites. See [development](references/development.md)
for rebuilding the bundle.
