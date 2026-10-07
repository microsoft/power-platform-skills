# Development and transport

## Layout

```text
process-intelligence/
  plugin.json               # Agent Plugins 1.0.0 metadata
  mcp.json                  # Agent Plugins 1.0.0 stdio configuration
  .plugin/plugin.json
  .claude-plugin/plugin.json
  .mcp.json
  AGENTS.md
  CLAUDE.md
  README.md
  references/
  skills/
  server/mcp.mjs
  server/bundle-meta.json    # esbuild included-module evidence
  package.json
  package-lock.json
  scripts/build.mjs
  scripts/test.mjs
  src/                      # Plain JavaScript ESM, runtime guards, no compiler
  tests/
```

The portable root files target the canonical **Agent Plugins 1.0.0** schemas. Both legacy
manifests remain equal, and portable metadata equals their common fields except for `$schema`.
There are no component-path overrides: all formats use shared `skills/` and `server/mcp.mjs`.
Portable `mcp.json` adds its schema envelope and explicit `type: "stdio"` to the unchanged
legacy `.mcp.json` server identity, command, arguments and environment semantics.

In Copilot CLI versions recognizing these schemas, root `plugin.json` has precedence and
portable/legacy components are not merged. An unsupported declared schema is rejected;
retaining legacy files does not guarantee fallback in that case. Claude Code retains its
documented legacy `.claude-plugin/plugin.json` and `.mcp.json` path, not an assumed new-format
loader. See the [Copilot reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
and [published specification](https://agent-plugins.org/specification).
Keep both root files in the distributed plugin directory, without duplicating the runtime or
registering both MCP configurations. The package's version remains independent of the schema version.

All runtime files and references stay inside the installed subtree, with no symlinks or
root-shared dependencies. `server/mcp.mjs` follows the packaged MCP entry-point pattern.
The bridge uses official `@modelcontextprotocol/sdk` 1.30.0 and Zod 4.6.5.
Build-only esbuild 0.28.2 produces one complete Node.js ESM runtime; the installed bundle
needs no .NET, npm, node_modules or source. Azure CLI is an external prerequisite.
`process.mjs` invokes supported commands with bounded output/cancellation/timeouts;
`authentication.mjs` binds the explicit tenant and user OID and checks token consistency.
Username pinning is RAM-only, persists across token eviction/expiry, and resets on disposal or
explicit binding. Cold local diagnostics check cloud/tenant/user shape without verifying the OID;
token acquisition verifies the saved principal before MCP traffic. Tests inspect actual config,
login and logout profile-file bytes for the exact seven fields and absence of username data.
`environment-resolution.mjs` performs only the explicit Public setup lookup. Its fixed BAP
audience shares those identity checks but never shares a token-cache entry with the MCP audience.
It writes no profiles or metadata cache; `config` remains offline. The resolver's stderr result
contains the selected environment and tenant for setup, unlike general diagnostics.

## Build and checks

From this plugin directory in a repository checkout, with Node.js 22 or 24 LTS
(tests use fake Azure CLI processes):

```powershell
npm ci --no-audit --no-fund
npm run build
npm test
```

The same commands work on macOS/Linux. The plugin's path-filtered
`process-intelligence-script-tests` CI workflow runs them on Windows, Linux and macOS with
Node.js 22 and 24. It runs for plugin changes, its own workflow and the root `LICENSE` embedded
by the build; repository-wide metadata checks remain separate. CI has read-only repository
permissions and needs no secrets, Azure login or live service access.
Build uses the integrity-locked npm graph and esbuild metadata, rejects external non-builtin
runtime imports, and embeds full required license texts in the runtime before replacing output.
Keep the lockfile's registry integrity values and TLS verification intact.
Do not disable TLS verification or change global npm settings to recover a failed restore.
MCP startup never builds, restores or downloads a runtime.

Tests use fake tokens and HTTP plus a real SDK stdio client, including the manifest/Node bootstrap
with test-only HTTP preload fixtures. Production code has no fake-auth mode.
`dual-format.test.mjs` exercises both MCP configurations through `PLUGIN_ROOT`,
`CLAUDE_PLUGIN_ROOT` and the current-directory fallback, including external working directories
and paths with spaces. Each selected configuration starts one server. These SDK tests execute
the actual bundled launcher, not an installed Copilot/Claude loader or a client-compatibility matrix.
All test runs check the actual bundle in an isolated subtree with spaces, no source/node_modules
and no dotnet on PATH, plus direct/manifest launch, missing Azure CLI/profile and clean stdout.
Tests never sign in or access real AppData. Tests route fetch to an official SDK fake server;
they do not add arbitrary-token/endpoint environment switches to production.
Mocked subprocess tests cover expiry, cloud/account/tenant drift, claims, no-subscription users,
invalid responses, redaction, timeout/cancellation, actual Windows `.cmd` fixtures and executable
Unix/shebang fixtures on native Unix. Windows ACLs are verified with native utilities.
EOF-before-overflow tests use controlled streams and process-local spawn stubs: writes are
released only after parent-side EOF, and rejection must wait for owned cleanup. This is distinct
from native `.cmd`/shebang overflow and descendant-liveness checks. Closing a Node standard
descriptor does not reliably produce native Windows EOF before exit.
Native test diagnostics retain startup/overflow/cleanup/close timings and a 4-second benchmark
indicator. The benchmark is not a functional SLA: invocation and Windows cleanup have separate
deadlines. Exceeding it remains visible as unresolved latency; it is not claimed fixed.
Live token acquisition and MCP deployment/access checks are separate, explicit operations.
Environment-resolution tests use synthetic directory records and token-free challenge replies,
including wrong/ambiguous IDs, unsupported clouds, principal drift, resource isolation,
redirect rejection, response-size limits and cancellation/deadlines. An isolated actual-bundle
test checks the same command with no profile or source/dependency tree in the installed fixture.
The actual isolated bundle has no source/node_modules or configuration sidecar.
Tests also check the exact shared `x-ms-client-request-id` wire marker, random client-session
IDs, independent internal owners and MCP request/cancellation IDs, rejected obsolete commands
and absence of diagnostic storage writes. The marker does not provide unique request correlation
or proof of origin; see [connection patterns](connection-patterns.md).

For skill/reference-only edits:

```powershell
node --test .\tests\analysis-behavior.test.mjs .\tests\investigation-behavior.test.mjs .\tests\packaging.test.mjs
```

Synthetic scenarios in `tests/analysis-scenarios.json` support evaluator-generated call traces,
not real MCP calls. `node tests/analysis-behavior.mjs GROUP RAW-TRACE-JSON` checks exact calls,
arguments/order and recovery safeguards. Inspect answers for semantics too. Fixture and Markdown
checks alone do not exercise tool selection or answer quality. Keep raw evaluation outputs outside the package.
`tests/investigation-scenarios.mjs GROUP` emits isolated synthetic inputs;
`node tests/investigation-behavior.mjs GROUP RAW-TRACE-JSON` checks selected calls against
fixture replies plus scope, evidence status and continuation. Trials use eight analytical
workflows, including investigation routing. Exact-call assertions are scenario-specific
completion/no-replay checks, not ordinary query quotas. Transport behavior is covered by the
offline SDK fixtures rather than these analytical scenarios.

Keep manifest mirrors equal, keyword/skill names kebab-case, descriptions trigger-based and
under 1024 characters, and `allowed-tools` a scalar. Run the repository's plugin-name,
legacy-compatibility, skill-description and keyword-case validators when integrating the subtree.
`node scripts/validate-legacy-compatibility.js` checks marketplace metadata and legacy manifest
mirrors; it does not validate the portable root manifests.
The plugin's `dual-format.test.mjs` checks matching portable/legacy metadata and stdio
configuration and exercises both launchers against the shared runtime.
Marketplace entries contain only `name` and `source`; the root index need not duplicate plugin metadata.

## Protocol and failures

The SDK forwards dynamic tool definitions, schemas, annotations, content blocks,
`structuredContent` and `isError`. Remote JSON-RPC errors remain protocol errors.
The host discovers the environment's current tools at the start of each MCP session through
`tools/list`. The bridge forwards explicit discovery requests without a catalog cache or
background refresh. It neither advertises `tools.listChanged` nor handles/forwards backend
tool-list-change notifications, including after reconnect. Start a new MCP session to discover
backend additions through the host's normal initialization flow.
Pagination cursors pass through unchanged as opaque backend values; the backend validates them
and any expiry errors remain protocol errors. There are no bridge-owned catalog generations
or cursor maps. Operation progress notifications still propagate with the caller's progress token.
Only transient initialization may retry once. Tool calls are never replayed.
The SDK negotiates a supported protocol; fixtures use service version 2025-06-18 and verify
subsequent HTTP headers.
The official low-level Client.request and Server fallback-handler APIs avoid destructive
convenience conversions. Official schemas validate without replacing the original result;
extension fields and content blocks remain intact. No custom JSON-RPC parser is used.
The public transport interface observes SDK-parsed error messages before SDK error normalization,
preserving reserved error codes and sibling elicitation data as wire errors rather than local
timeouts/disconnects. Upstream library source is not patched. A deadline covers the entire
initialization handshake, including its initialized notification. Queued cancellation remains
prompt without letting later operations bypass the active operation.
No SDK authProvider is supplied; OAuth discovery/upscope cannot bypass the authenticated fetch
boundary. SDK automatic HTTP/SSE reconnection is disabled, so it cannot resume uncertain calls.
Raw non-success HTTP bodies are discarded before they can enter SDK error messages.

The bridge explicitly selects `post-only` in the SDK's public custom-fetch hook; it is not a
profile setting or an SDK source patch. SDK 1.30.0 starts an optional GET/SSE probe after the
initialized notification's 202 response, even with zero reconnection retries. After validating
the exact HTTPS MCP endpoint and cancellation, the adapter returns an empty **local 405 with
Allow: POST** for that probe, before token acquisition or network I/O. This is a client policy,
not a response observed from the server and not a translation of any actual 404.
See the [MCP transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#listening-for-messages-from-the-server).

All POST requests retain SDK JSON/SSE response parsing, authentication, correlation and HTTP
failure handling. Do not make the POST Accept header JSON-only. GET with Last-Event-ID fails
explicitly as unsupported; no stream resumption or uncertain-call replay is attempted.
Unsolicited notifications on a standalone GET stream are unavailable; request-related progress
can still arrive within POST SSE responses. Tool-list-change notifications are ignored.
Backend request results must arrive as POST JSON/SSE responses. Discovered operation-result tools
are ordinary POST calls.
The separate environment-resolution HTTP path is unchanged.
Tests cover stateless POST-only fixtures returning RouteNotFound404 for any real GET, both
JSON/SSE POST responses, early/late probe failures, zero GET/token acquisition for probes,
endpoint/abort guards, explicit resumption rejection and actual isolated bundle execution.

### Tool contract compatibility

`tool-contracts.mjs` applies only two explicit exceptions to transparent discovery/forwarding.
It is not a static catalog and never adds a service capability:

- The operation-result description and MCP initialization instructions share one local polling
  policy: 1800 seconds from original submission, same operation ID, full retry delay, no automatic
  replay and retention of the first completed payload. This is agent guidance, not a new server
  timeout, polling loop or proof of server-side result caching/consumption.
- Formula-reference descriptions use targeted `search` when `functionNames` is absent from the
  current input schema. No parameter is added. A future schema advertising exact-name lookup
  passes through unchanged; the input schema always wins over conflicting prose.

All tool call arguments, result content, annotations, extensions and unrelated schemas remain
intact. Source and isolated-bundle fixtures cover guidance, schema defaults, filters,
multi-page controls, counts and unchanged tool calls across configured clouds.

Cancellation closes the local request/transport but does not prove business cancellation.
Use only the discovered operation-result tool and returned retry delay. Preserve the first
completed result because retrieval consumes it. The operation must succeed within 30 minutes
of original submission, including cold start and any pauses; this deadline never resets per poll.
See the
[analysis contract](analysis-contract.md) for cold-start-aware polling and resumable pending operations.

The entry point runs directly or imports exactly once; SIGINT/SIGTERM cancel owned work.
Azure CLI uses validated argument arrays; Windows `.cmd` expansion is constrained and quoted.
Cancellation/output limits/timeouts kill only the owned process tree (Windows taskkill by PID;
Unix process group), never by process name. Stdout is MCP-only; diagnostics/auth use stderr.
The plugin stores profiles/challenges only in `ProcessIntelligenceBridgeAzureCli`; there is no
migration or legacy-store lookup. Azure CLI 2.54+ supplies `expires_on`; ambiguous local `expiresOn` is not parsed.
CLI 2.80+ supports explicit `login --claims-challenge` (base64), not claims on `get-access-token`.
Forced acquisition clears the bridge memory cache but does not force refresh of Azure CLI's cache.
Read-only local diagnostics run CLI version/cloud/account commands; only remote diagnostics acquire
tokens and connect. CLI subprocess output is captured, never forwarded to MCP stdout or diagnostics.

A claims challenge received on the first 401 is saved for explicit sign-in. If a new challenge
appears only after the single authentication retry, the request fails without a further retry.

## Dependency management and licenses

`package.json` and `package-lock.json` pin MCP SDK 1.30.0, Zod 4.6.5 and build-only esbuild 0.28.2.
When updating dependencies, review their licenses and upstream release notes, then regenerate
the bundle and metadata together. The build includes full LICENSE/NOTICE texts for packages
present in esbuild's output, plus the Microsoft MIT notice, in [server/mcp.mjs](../server/mcp.mjs).
These comments travel with the installed runtime; there is no separate inventory or audit command.
Missing or empty license files stop the build. Build-only and unused npm dependencies are not
redistributed in the runtime. Node and Azure CLI are external products with their own licenses.

Source builds read the repository's root `LICENSE` for the Microsoft MIT notice.
Packaging tests verify that full dependency and project license texts are present in the bundle.
Build also requires byte-identical legacy plugin manifests. Portable metadata/MCP consistency
is checked by the repository validator and packaging tests, not by rewriting the runtime.
Installed execution has no dependency
on the repository root.
