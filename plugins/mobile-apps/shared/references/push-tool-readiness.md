# Push tool readiness and failure classification

Use this reference before a push owner performs its first local-tool, MCP,
cloud, flow, build, or physical-verification operation. Readiness is
**stage-specific**: check only the next selected lifecycle stage and do not
block an app-configuration run on later WIF, FlowAgent, build, or device
requirements.

## Local probe

Run the deterministic probe from the app root:

```bash
node "${PLUGIN_ROOT}/scripts/check-push-prerequisites.js" \
  --stage "<firebase-client|wif|flow-authoring|android-build|ios-build|android-verify|ios-verify>"
```

The probe reports only executable names, bounded version strings, and stable
issue codes. It does not inspect accounts, tokens, projects, subscriptions,
tenants, environments, MCP connections, cloud permissions, signing assets, or
physical devices.

PAC CLI availability is proved with the non-interactive `pac help` command.
PAC does not provide a portable `pac --version` command; when the help banner
contains `Version: <value>`, the probe records that bounded value.

An exit code of `0` means every local prerequisite checked for that stage is
ready. Exit code `2` means one or more local prerequisites are missing or
unsupported. A successful local probe does **not** prove that an MCP server is
connected, a user is authenticated, or a cloud resource is accessible.

Android's `apksigner`, `aapt`, and `unzip` checks reuse the same trusted
discovery rules as `verify-android-apk.js`. iOS checks require macOS and
`xcodebuild` but never inspect certificates, profiles, identities, keychains,
or Apple credentials **for the build stage**. A later iOS verification may run
where the exact validated IPA handoff and physical device are available; it
does not invoke Xcode and therefore does not re-require `xcodebuild`.

## Stage matrix

| Stage | Local readiness | Host/tool readiness | Live proof |
|---|---|---|---|
| Firebase client | Node.js 20+, npm, npx | `firebase` connected with the complete `/setup-fcm` tool set | Firebase account, project directory, active project, exact project read-back |
| WIF sender auth | Node.js 20+, npm, npx, `gcloud`, and narrow `az` gap support | `azure` connected | Active Azure and Google identities/context, resource inventory, IAM/API/policy state |
| Flow authoring | Node.js 20+, npm, npx, local `power-apps`, `pac`, `az` | `flowagent` connected with the tools used by the requested operation | Power Apps/PAC/Azure/FlowAgent environment and tenant continuity; connector state |
| Android build | Node.js 20+, npm, npx, Android SDK Build-Tools `apksigner` + `aapt`, `unzip` | none | Existing external signing boundary and fresh APK verification |
| iOS build | macOS, Node.js 20+, npm, npx, `xcodebuild` | none | User-confirmed Apple/Xcode signing boundary and fresh IPA handoff |
| Android verification | Android build prerequisites plus flow-authoring prerequisites | read-only FlowAgent tools | Exact APK/install continuity, connected flow references, physical Android device |
| iOS verification | Node.js 20+, npm, npx, local `power-apps`, `pac`, `az` | read-only FlowAgent tools | Exact IPA/install continuity, connected flow references, physical registered iOS device |

Firebase MCP is launched through pinned `firebase-tools` by `npx`; a separately
installed `firebase` executable is not required. The Firebase client stage does
not require gcloud CLI or Application Default Credentials.

WIF uses the locally installed Google Cloud CLI directly through the checked-in
allowlisted wrapper. No separate Google Cloud server is registered in
`.mcp.json`.

## Manual setup sources

When automatic installation is not supported or the user chooses manual
installation, direct them to the owning official source and wait:

- Node.js/npm/npx: <https://nodejs.org/en/download>
- Google Cloud CLI: <https://cloud.google.com/sdk/docs/install>
- Azure CLI: <https://learn.microsoft.com/cli/azure/install-azure-cli>
- Power Platform CLI/PAC:
  <https://learn.microsoft.com/power-platform/developer/cli/introduction>
- Android SDK Build-Tools:
  <https://developer.android.com/tools/releases/build-tools>
- Xcode: the Mac App Store and Apple's Xcode documentation

The project-local `power-apps` command is restored through the app's existing
package manifest (`npm install`) and checked with
`npx --no-install power-apps --version`; do not perform an unreviewed global
install.

## Stable failure categories

Classify from observed evidence before proposing recovery:

| Code | Evidence | Recovery |
|---|---|---|
| `local-runtime-missing` | Required executable cannot be resolved or invoked. | Offer only the supported installation path for that executable. |
| `local-runtime-unsupported` | Executable is present but its proved version/platform is unsupported. | Give official upgrade/platform guidance. |
| `mcp-server-missing` | The named server is absent from `/mcp`. | Run `/setup`, restart when required, then recheck `/mcp`. |
| `mcp-server-disconnected` | The server is listed but not connected. | Run `/setup`, `/restart`, then recheck `/mcp`. |
| `mcp-tool-missing` | Server is connected but an exact required tool is absent. | Repair/update the configured plugin/server; do not invent a replacement tool. |
| `plugin-missing` | The Power Automate plugin/FlowAgent is not installed. | Give the documented marketplace/install/restart/setup sequence. |
| `not-authenticated` | The owning read-only identity probe reports no valid session or expired credentials. | Use the owning login flow and rerun the same identity probe. |
| `wrong-account` | A valid session exists for a different account/tenant. | Ask the user to select or authenticate the intended account; never silently switch tenants. |
| `active-context-missing` | No active project, subscription, environment, or flow context is set. | Set it through the owning tool, then require exact read-back. |
| `active-context-mismatch` | Read-back differs from the pinned project/tenant/subscription/environment. | Stop before mutation and repair the owning context. |
| `permission-denied` | Provider returns 401/403, `PERMISSION_DENIED`, or a named missing permission. | Surface the bounded error and exact permission when available; recommend least privilege, never automatic Owner/Editor. |
| `api-disabled` | Error explicitly names a disabled/not-used API or service and enabling it is supported by the owner. | Present the exact API enablement as a separate mutation requiring approval. |
| `service-unavailable` | Provider reports outage, 429/5xx, deadline, transport, or service unavailability without a durable policy cause. | Retry only bounded idempotent reads; do not replay mutations. |
| `billing-policy-blocked` | Error names billing, organization policy, VPC Service Controls, location constraint, or administrative denial. | Report the administrator-owned blocker; installation and login do not fix it. |
| `propagation-pending` | A just-created/updated resource is not yet visible and the workflow defines a propagation window. | Poll only the documented read-back until its deadline. |
| `transient-readback` | An idempotent read fails with a retryable transport/429/5xx condition outside a mutation response. | Retry the same read with bounded delay; preserve a resumable timeout. |
| `unknown-safe-blocker` | Evidence does not safely fit another category. | Stop with sanitized provider/tool error, completed probes, and the owning next diagnostic step. |

Do not infer a category from a product name in the error. In particular, a
Firebase MCP project read may mention Google Cloud Resource Manager because
Firebase projects are backed by Google Cloud projects. That message alone does
not prove that gcloud CLI is missing.

## Installation, login, restart, and resume protocol

1. Show the failed probe, stable category, affected stage, and why later work
   is blocked.
2. Offer automatic installation only when the owner already documents a safe,
   supported package-manager path and the user separately approves the exact
   machine-level command. Never install a package manager, use `sudo`, add an
   OS repository, or run a downloaded installer implicitly.
3. Otherwise give the official manual instructions and immediately invoke
   `AskUserQuestion` with a confirmation such as **Installation is complete**
   plus **Cancel this setup**. A missing executable is a resumable user-action
   gate, not a terminal `BLOCKED` result.
4. Keep the current skill invocation open while waiting for the user's answer.
   Do not return, end the session, or hand the user a command to run later
   unless they explicitly cancel. For several missing executables, guide the
   installations one at a time and then rerun the complete stage probe.
5. Rerun the **same** local, `/mcp`, identity, or context probe. Confirmation
   is not proof.
6. If the executable is still missing, show the bounded failed recheck and
   invoke `AskUserQuestion` again with **I have restarted and installation is
   complete**, **Show installation guidance again**, and **Cancel this setup**.
   Repeat the confirmation/recheck loop without a fixed retry limit because
   installation and host restart are user-paced.
7. Continue from the blocked stage only after the recheck passes. Preserve
   already proved upstream stages and immutable decisions. Return a blocker
   only when the user cancels or the recheck proves a non-installation failure
   that requires a different owner.

For Copilot CLI MCP recovery, use:

```text
/mcp
/setup
/restart
/mcp
```

The second `/mcp` result must show the named server connected and every exact
required tool present. Firebase and Azure remain blocked without their required
MCP surfaces. Google Cloud CLI readiness is separate and stage-lazy:
`/setup-push-wif` reruns `gcloud --version` and the read-only account/context
checks after installation, login, or PATH repair.

## Error handling rules

- Parse only bounded status/code/message fields. Never print tokens, auth
  headers, credential values, complete HTTP responses, or secure flow
  inputs/outputs.
- Retry reads, not persistent creates/updates, unless the owner first rereads
  state and proves the mutation did not take effect.
- Authentication failures route to login; authorization failures route to
  least-privilege access; API/policy failures route to the owning
  administrator. Do not suggest installation for those categories.
- Tool installation, MCP recovery, authentication, context proof, and every
  MCP call remain responsibilities of the serial owner skill for that stage.
  Push orchestration does not delegate readiness or execution to background
  agents.
