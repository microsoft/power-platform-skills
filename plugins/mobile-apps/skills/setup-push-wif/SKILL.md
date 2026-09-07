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

## Google tool readiness gate

The official gcloud MCP requires Node.js 20+ and an installed `gcloud`
executable. Before MCP recovery, run `node --version` and `gcloud --version`.

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

1. Read `memory-bank.md`, `sender-auth.json` when present, the provisioning
   reference, and the handoff contract.
2. Verify the active Azure identity and gcloud MCP account. Gather the exact
   tenant/subscription, Firebase and Google project IDs, pool/provider,
   dedicated sender account, Key Vault reference, and the **actual Power
   Automate Key Vault connection principal**.
3. Inventory every live resource and binding in the reference. Acquire a fresh
   Entra app-only token and pass it only on stdin to
   `inspect-entra-wif-jwt.js`; provider trust follows observed `iss`, `aud`,
   and actual `appid`/`azp`, never portal assumptions.
4. Classify exactly one route: validate/reuse, approved repair, or approved new
   provisioning. Show the full state/diff, resource and RBAC mutations,
   security impact, and rollback. Obtain explicit confirmation before every
   repair/provision route and before any API enablement or broader FCM fallback.
5. Execute the selected route exactly as specified. Keep credentials/tokens
   only in non-echoed shell variables, write a created Entra credential
   directly to Key Vault, and unset values in the same process. Never put
   secrets in files, output, flow definitions, or memory.
6. Reread the entire compatibility checklist after mutation. A required narrow
   binding does not excuse a hidden broad binding; remaining drift blocks
   proof.
7. Perform a fresh four-stage proof: Entra token, Google STS, sender-account
   impersonation with the Firebase Messaging scope and `900s` lifetime, then
   FCM HTTP v1 `validateOnly: true`. Do not report success from resource
   existence or an old proof.
8. Only after all four stages succeed, write and validate version-1 mode-`wif`
   `sender-auth.json` from live values. The Key Vault handoff contains URI and
   secret name only. Record only non-secret state and validate every changed
   local file.

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
