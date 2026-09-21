---
name: setup-push-wif
description: Use when provisioning, validating, reusing, or repairing the keyless Entra-to-Google Workload Identity Federation sender-auth stage for a Power Automate FCM sender, including selecting the app registration, another same-tenant existing registration, or a new dedicated registration; JWT claim discovery; Google STS; sender service-account impersonation; or Azure Key Vault RBAC. Owns only the non-secret sender-auth handoff, not Firebase client setup, flow authoring, wrapped builds, installation, or delivery.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, mcp__azure__subscription, mcp__azure__group, mcp__azure__role
model: opus
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Provisioning workflow: [push-wif-provisioning.md](${PLUGIN_ROOT}/shared/references/push-wif-provisioning.md)** —
read in full. It is canonical for inventory, validate/reuse, approved repair,
new provisioning, live proof, and handoff creation.

**Runtime flow protocol: [push-flow-wif.md](${PLUGIN_ROOT}/shared/references/push-flow-wif.md)** —
do not author the Power Automate HTTP sequence here.

**Sender-auth handoff: [sender-auth-contract.md](${PLUGIN_ROOT}/shared/references/sender-auth-contract.md)**.

**Official MCP readiness: [official-mcp-servers.md](${PLUGIN_ROOT}/shared/references/official-mcp-servers.md)** —
use the `/setup-push-wif` row as a hard preflight.

**Push tool readiness: [push-tool-readiness.md](${PLUGIN_ROOT}/shared/references/push-tool-readiness.md)** —
use its local probe, stable failure categories, bounded retry rules, and
confirmation/recheck protocol.

# Set up push sender WIF

Provision or prove:

`selected same-tenant Entra registration -> Google STS -> dedicated sender service account -> FCM`

Never create or download a Google service-account key.

Require one explicit immutable `registration_mode`:

- `reuse-app-registration` — use the validated client ID and tenant from
  `auth.config.json`;
- `use-existing-registration` — use a user-supplied client ID validated in the
  same resolved tenant without editing `auth.config.json`;
- `create-dedicated-registration` — create a new sender registration through
  the separately approved identity-bootstrap path.

Never silently substitute one mode for another. Existing-registration modes
must start with a non-null client ID and may plan approved application ID URI,
credential, Key Vault, and RBAC mutations, but they must not create another
Entra application. Only `create-dedicated-registration` may start with a null
client ID or enter `identity-bootstrap`.

## Google tool readiness gate

Before local readiness checks, Azure MCP recovery, or cloud read-back, run:

```bash
node "${PLUGIN_ROOT}/scripts/check-push-prerequisites.js" --stage wif
```

The WIF workflow requires Node.js 20+, an installed Google Cloud CLI, and the
narrow documented `az` gaps for Entra and secret-safe Key Vault operations.
Branch on the probe's exact
`local-runtime-missing` or `local-runtime-unsupported` result rather than
assuming an authentication or IAM error means a tool is absent.

If `gcloud` is missing, explain that it is a machine-level prerequisite and use
`AskUserQuestion` with these choices:

1. **Install Google Cloud CLI for me**
2. **I will install it manually**
3. **Use the manual Power Automate authentication option instead**

For **Install Google Cloud CLI for me**, show the exact official installation
command and its machine-level impact, then obtain a separate explicit
confirmation before running it. Use only a supported package manager already
installed on the machine:

- macOS with Homebrew:
  `brew update && brew install --cask gcloud-cli`
- Debian/Ubuntu: follow the current official Google package-repository steps;
  do not pipe a remote installer directly into a shell.
- Windows: launch the signed Google Cloud CLI installer from the official
  Google download path; do not silently install it.

Do not install Homebrew, add an OS package repository, use `sudo`, or run a
downloaded installer without separate explicit approval. If no supported
package manager is available, give the official installation URL and wait for
the user to complete it. After installation, require a fresh
`gcloud --version`; if PATH changed, ask the user to restart the terminal or
host, wait for confirmation, and rerun the complete WIF local probe before
continuing. Apply the same wait-and-recheck rule when the user manually installs
or upgrades Node, npm/npx, or Azure CLI.

Before any cloud read-back, require the Azure MCP surfaces, a successful
`gcloud --version`, and a confirmed active Google account. Authentication or
account repair is user-owned: wait for completion, then rerun the exact
read-only account probe. Route every Google operation through
`scripts/run-allowlisted-gcloud.js`; never call `gcloud` directly. If Azure MCP
is unavailable, use the documented MCP recovery sequence and stop until its
required surfaces reconnect; it has no general CLI fallback.

If the account probe reports no active account, instruct the user to run
`gcloud auth login` in their terminal. If the wrong account is active, instruct
them to select or authenticate the intended account. Do not execute interactive
authentication through Bash or add `auth` commands to the allowlist. Wait for
confirmation, then rerun the wrapper-based `config list account` probe.

After local and Azure MCP readiness succeeds, prove the active Google and
Azure identities and pinned project/tenant/subscription through read-only calls.
Classify no session as `not-authenticated`, a different identity as
`wrong-account`, and missing/drifted project or subscription as an active
context failure. IAM, API enablement, billing/policy, and propagation failures
must retain those categories; installation or `/mcp` recovery is not a fix for
an authenticated provider denial. Retry only bounded idempotent inventory
reads. Never replay identity, credential, API, IAM, or WIF mutations after an
uncertain response without first rereading live state.

The supported boundary is the guarded official Google Cloud CLI plus
`@azure/mcp@2.0.5`:

- Route every Google Cloud operation through:

  ```bash
  node "${PLUGIN_ROOT}/scripts/run-allowlisted-gcloud.js" -- \
    config list account --format=json
  ```

  Pass tokenized arguments after `--`, beginning with the gcloud subcommand.
  The wrapper invokes `gcloud` with `shell: false`, disables prompts, and
  rejects command families outside `shared/mcp/gcloud-allowlist.json`. On
  Windows, where the SDK exposes `gcloud.cmd`, it resolves that installation
  and invokes its Python entry point directly so arguments never pass through
  command-script parsing.

  Never invoke `gcloud` directly for inventory, mutation, IAM, or API
  enablement.
- Azure MCP uses `mcp__azure__subscription`, `mcp__azure__group`, and
  `mcp__azure__role`; call the namespace tool plus
  routed command/parameters, including `role_assignment_list` for RBAC
  inventory.
- The plugin does not expose the `keyvault` namespace because GA 2.0.5 has
  value-carrying Key Vault secret operations but no safe metadata-only list.
  Do not invent `mcp__azure__azmcp_role_assignment_list` or
  `keyvault_secret_list`.
- Keep `az` only for Entra identity/credential work and the documented
  secret-safe Key Vault metadata/write gap. Do not replace covered Azure MCP
  reads with ad-hoc CLI calls.

## Required execution order

**Telemetry checkpoint: `configure_push_wif`**

1. Read `memory-bank.md`, `sender-auth.json` when present, the provisioning
   reference, and the handoff contract.
2. Verify the active Azure identity and Google execution context. Gather or
   validate the exact
   tenant/subscription/resource group, Firebase and Google project IDs,
   pool/provider, dedicated sender account, Key Vault URI/secret name, and the
   **actual Power Automate Key Vault connection principal**. Pin the exact
   registration mode. Existing-registration modes require a non-null client ID
   validated in the resolved tenant. Only `create-dedicated-registration`
   pins a sender display name and may carry a null client ID while proving that
   identity is absent.
3. Inventory every live resource and binding in the reference. When the exact
   Entra sender identity exists, acquire a fresh Entra app-only token and pass
   it only on stdin to `inspect-entra-wif-jwt.js`; provider trust follows
   observed `iss`, `aud`, and actual `appid`/`azp`, never portal assumptions.
   If create-new inventory proves the identity is absent, stop before token
   acquisition and present only the exact safe bootstrap proposal.
4. Classify exactly one route: validate/reuse, approved repair, or approved new
   provisioning. Show the full state/diff, resource and RBAC mutations,
   security impact, and rollback. Obtain explicit confirmation before every
   repair/provision route and before any API enablement. The WIF sender always
   uses the least-privilege custom role containing only
   `cloudmessaging.messages.create`; do not offer or ask about a broader Firebase
   role or Firebase Admin SDK access.
   When the exact dedicated identity is absent, present and approve only the
   narrow Entra/credential/Key Vault bootstrap plan. Execute only that list,
   reread the server-generated client ID, then produce a fresh claim-driven
   plan for all remaining Google/API/RBAC work and obtain a second explicit
   approval. The first approval never authorizes the second stage.
5. Execute only the selected approved stage. Keep credentials/tokens only in
   non-echoed shell variables, write a created Entra credential directly to
   Key Vault, and unset values in the same process. Never put secrets in files,
   output, flow definitions, or memory. Bootstrap must not mutate Google,
   final runtime RBAC, or `sender-auth.json`.
6. Reread the entire compatibility checklist after mutation. A required narrow
   binding does not excuse a hidden broad binding; remaining drift blocks
   proof.
7. Perform a fresh four-stage proof: Entra token, Google STS, sender-account
   impersonation with the Firebase Messaging scope and `900s` lifetime, then
   FCM HTTP v1 `validateOnly: true`. Do not report success from resource
   existence or an old proof.
8. Only after all four stages succeed, write and validate version-2 mode-`wif`
   `sender-auth.json` from
   live values, including the exact approved registration mode. The Key Vault
   handoff contains URI and secret name only.
   Record only non-secret state and validate every changed local file.

## Completion

The workflow is complete only when the live inventory matches, the fresh proof
succeeds, and this exits `0`:

```bash
node "${PLUGIN_ROOT}/scripts/validate-sender-auth-contract.js" \
  --project-root "<working_dir>" --file sender-auth.json \
  --expected-firebase-project "<firebase-project-id>"
```

The contract validator checks shape/freshness; it never replaces resource
read-back or the live proof. Hand the validated contract to
`/create-push-notification-flow`, which alone authors the runtime sequence from
`push-flow-wif.md`.
