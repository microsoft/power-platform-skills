---
name: setup-push-wif
description: Use when provisioning, validating, reusing, or repairing the keyless Entra-to-Google Workload Identity Federation sender-auth stage for a Power Automate FCM sender, including JWT claim discovery, Google STS, sender service-account impersonation, or Azure Key Vault RBAC. Owns only the non-secret sender-auth handoff, not Firebase client setup, flow authoring, wrapped builds, installation, or delivery.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, mcp__gcloud__run_gcloud_command, mcp__azure__subscription, mcp__azure__group, mcp__azure__role
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

# Set up push sender WIF

Provision or prove:

`dedicated Entra sender app -> Google STS -> sender service account -> FCM`

Never create or download a Google service-account key.

## Internal orchestrated worker mode

Direct user invocation follows the workflow below unchanged. A parent may
instead invoke this owner through the immutable
`mobile-app:push-wif-worker` contract defined in
`push-wif-provisioning.md`. The operation is a normal prompt field, never a
`Task` API mode.

Enter worker mode only for the exact common fields `contract_version: 1`,
`run_id`, canonical `working_dir`, `plugin_root`,
`worker_name: mobile-app:push-wif-worker`, and one supported `operation`:

- `operation: preflight` receives no project, memory, or cloud envelope and
  returns only the exact no-read/no-write capability result from the reference;
- `operation: plan` receives the complete phase-marked `plan_envelope`,
  performs bounded read-only live inventory, and returns either the narrow
  `identityBootstrapPlan` for a truly absent Entra sender identity or the exact
  remaining `proposedPlan`;
- `operation: identity-bootstrap` receives only explicit approval plus the
  unchanged `identityBootstrapPlan`, creates the dedicated Entra
  identity/credential and stores the credential directly in the pinned Key
  Vault without disclosure, returns the generated client ID and safe receipt,
  and performs no Google mutation or local write;
- `operation: execute` receives the pre-wave memory hash, exclusive absolute
  `sender-auth.json` path, `approved: true`, the exact unchanged
  post-bootstrap/reuse/repair `approved_plan`.

In that mode:

- pin and echo the canonical project root, Firebase/Google project, Azure
  tenant/subscription/resource group, Google execution mode, pool/provider,
  sender service account, Entra sender app, Key Vault URI/secret name, runtime
  connection principal, route, ordered mutation/API-enablement approval lists,
  and the exact least-privilege role, and stop on any mismatch;
- never call `AskUserQuestion`; return
  `NEEDS_CONTEXT: <exact missing or newly required parent decision>` when an
  approval, route, mutation, API enablement, fallback, installation, rotation,
  or replacement was not pre-approved;
- keep `preflight` entirely inert and `plan` read-only. Planning never grants
  mutation permission. If initial inventory proves the named dedicated Entra
  identity is absent, the parent must display and approve only the bootstrap
  plan, run `identity-bootstrap`, validate its safe receipt, and then request a
  fresh read-only plan using the server-generated client ID and a fresh
  app-only token. The parent separately displays and approves that complete
  remaining `proposedPlan` before `execute`;
- preserve all inventory, least-privilege, secret-handling, cloud-safety,
  read-back, and fresh-proof gates;
- never write `memory-bank.md` or any project file other than
  `sender-auth.json`; only final `execute` may write it, and only after all
  four live proof stages succeed. `identity-bootstrap` writes credentials
  directly to Key Vault and writes no local file;
- return exactly one safe single-line `WORKER_RESULT` for parent merge as
  specified by the reference, after the existing literal first-line `DONE` /
  `DONE_WITH_CONCERNS:` / `NEEDS_CONTEXT:` / `BLOCKED:` protocol.

Each envelope is immutable and narrowly authorizing. The initial cold plan must
return explicit empty Google mutation and API-enablement lists.
`identity-bootstrap` must consume exactly its first approved list.
The fresh remaining plan must return explicit empty approval lists when no
remaining action is needed, and final `execute` must consume exactly those
second approved lists. Do not infer a missing decision from memory or live
defaults, reuse first-stage consent, or broaden an approval because a nearby
mutation would be convenient. Result paths are normalized
project-relative paths: require `senderAuthPath`, `changedFiles`, and
`validatedFiles` to be exactly `sender-auth.json`, resolve them against
`working_dir`, and only then compare them with the absolute exclusive path.

## Google tool readiness gate

The official gcloud MCP requires Node.js 20+ and an installed `gcloud`
executable. Before MCP recovery, run `node --version` and `gcloud --version`.

If `gcloud` is missing, explain that it is a machine-level prerequisite and use
`AskUserQuestion` with these choices:

1. **Install Google Cloud CLI for me**
2. **I will install it manually**
3. **Use the manual Power Automate authentication option instead**

In orchestrated worker mode, do not ask this question. `preflight` does not
inspect tooling. `plan`, `identity-bootstrap`, and `execute` continue only
when the exact Google execution mode and any machine-level installation or
guarded-CLI approval are already established by the parent; otherwise return
`NEEDS_CONTEXT` before machine or cloud changes. Identity bootstrap itself
makes no Google cloud call; the pinned execution mode is preserved for the
fresh plan that follows.

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
host before continuing.

Before any cloud read-back, require the Azure MCP surfaces and prefer the
official gcloud MCP surface. If gcloud MCP is unavailable after `gcloud`
readiness is proven, first give:

```text
/mcp
/setup
/restart
/mcp
```

If the second `/mcp` still lacks gcloud, offer the official CLI fallback.
Continue only after explicit approval, `gcloud --version` succeeds, the active
Google account is confirmed, and every Google operation is routed through
`scripts/run-allowlisted-gcloud.js`. If Azure MCP is unavailable, stop; it has
no general CLI fallback.

The supported boundary is pinned `@google-cloud/gcloud-mcp@0.5.3` or the
guarded official CLI fallback, plus `@azure/mcp@2.0.5`:

- `mcp__gcloud__run_gcloud_command` owns every Google Cloud operation. It
  prepends the `gcloud` executable itself, so pass one tokenized command whose
  first argument is a subcommand:

  ```json
  {"args":["config","list","account","--format=json"]}
  ```

- In fallback mode, replace each MCP call with:

  ```bash
  node "${PLUGIN_ROOT}/scripts/run-allowlisted-gcloud.js" -- \
    config list account --format=json
  ```

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

1. In direct mode, read `memory-bank.md`, `sender-auth.json` when present, the
   provisioning reference, and the handoff contract. In worker mode,
   `preflight` performs only its inert capability handshake; `plan`,
   `identity-bootstrap`, and `execute` must not parse memory. They consume the
   exact plan/approved-stage envelope, and final `execute` hashes memory raw
   bytes only as a concurrency guard.
2. For direct mode, `plan`, `identity-bootstrap`, and `execute`, verify the active
   Azure identity and Google execution context. Gather or validate the exact
   tenant/subscription/resource group, Firebase and Google project IDs,
   pool/provider, dedicated sender account, Key Vault URI/secret name, and the
   **actual Power Automate Key Vault connection principal**. The initial
   worker plan also pins an exact Entra sender display name and may carry a
   null client ID only while proving that identity is absent.
3. Inventory every live resource and binding in the reference. When the exact
   Entra sender identity exists, acquire a fresh Entra app-only token and pass
   it only on stdin to `inspect-entra-wif-jwt.js`; provider trust follows
   observed `iss`, `aud`, and actual `appid`/`azp`, never portal assumptions.
   If the initial worker plan proves the identity is absent, stop before token
   acquisition and return only the exact safe bootstrap proposal.
4. Classify exactly one route: validate/reuse, approved repair, or approved new
   provisioning. Show the full state/diff, resource and RBAC mutations,
   security impact, and rollback. Obtain explicit confirmation before every
   repair/provision route and before any API enablement. The WIF sender always
   uses the least-privilege custom role containing only
   `cloudmessaging.messages.create`; do not offer or ask about a broader Firebase
   role or Firebase Admin SDK access.
   In orchestrated `operation: plan`, an absent identity returns only its
   narrow Entra/credential/Key Vault bootstrap plan. After separate parent
   approval, `identity-bootstrap` executes only that list, returns safe
   generated identity fields, and stops. A new post-bootstrap read-only plan
   must then use that client ID and a fresh token to return the exact remaining
   route, safe field-level diff, ordered Google/API/RBAC mutation lists, pinned
   identities/decisions, and least-privilege role. The parent obtains a second
   approval. In final `operation: execute`, compare the
   fresh inventory with the unchanged second approved plan; any addition or
   change is `NEEDS_CONTEXT` rather than an interactive prompt.
5. In direct mode, worker `identity-bootstrap`, or worker final `execute`,
   execute only the selected approved stage. Keep credentials/tokens only in
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
8. Only in direct mode or worker final `execute`, and only after all four stages
   succeed, write and validate version-1 mode-`wif` `sender-auth.json` from
   live values. The Key Vault handoff contains URI and secret name only.
   Record only non-secret state and validate every changed local file. In
   orchestrated worker mode, this is the only permitted local write; return
   safe fields in `WORKER_RESULT.memoryPatch.sections` instead of writing
   `memory-bank.md`.

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

For orchestrated worker mode, use the reference's exact status/JSON mapping and
finish with its one single-line `WORKER_RESULT`. `preflight` returns only the
exact capability record. Initial absent-identity `plan` returns
`stage: "identity-bootstrap-plan"`; `identity-bootstrap` returns
`stage: "identity-bootstrap"` with the safe generated receipt and no changed
files; the mandatory fresh plan returns `stage: "sender-auth-plan"` with no
changed files and only the required empty memory patch. Final `execute` returns
`stage: "sender-auth"` and must echo every second-approved safe
identity/decision plus the project-relative sender-auth paths and fresh
four-stage proof fields. Accept these stages only in that order. Reuse/repair
retains the fast path `sender-auth-plan` -> `sender-auth`. Direct mode keeps the
existing user-facing completion and memory behavior.
