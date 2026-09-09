# Push sender WIF provisioning

Canonical inventory, validate/reuse, repair, provisioning, proof, and handoff
workflow for:

`dedicated Entra sender app -> Google STS -> sender service account -> FCM`

Read `official-mcp-servers.md`, `sender-auth-contract.md`, and this reference
before any cloud operation. Never create or download a Google service-account
key.

## Internal orchestrated owner contract

This workflow has two invocation modes:

- **Direct mode** is the existing user-invoked workflow. It asks every existing
  identity, route, mutation, API-enablement, fallback-role, and installation
  question and writes the existing safe memory handoff.
- **Orchestrated worker mode** is enabled only by the exact internal
  `mobile-app:push-wif-worker` invocation contract below. This is not a new
  user-facing command.

The operation is a prompt field. Never infer it from or require a `Task` API
mode. Every worker prompt starts with only:

```yaml
contract_version: 1
run_id: <opaque parent-generated id>
working_dir: <canonical absolute project root>
plugin_root: <absolute plugin root>
worker_name: mobile-app:push-wif-worker
operation: preflight|plan|identity-bootstrap|execute
```

For `operation: preflight`, that common envelope is complete. It must perform
no cloud/network call, file read/write, project inspection, hashing, prompting,
delegation, or ownership acquisition.

For `operation: plan`, also require this exact read-only inventory envelope:

```yaml
plan_envelope:
  plan_phase: initial|post-identity-bootstrap
  firebase_project_id: <exact>
  google_project_id: <exact>
  google_execution_mode: mcp|approved-allowlisted-cli
  azure_tenant_id: <exact>
  azure_subscription_id: <exact>
  resource_group: <exact>
  wif_pool_id: <exact>
  wif_provider_id: <exact>
  sender_service_account: <exact>
  entra_sender_display_name: <exact>
  entra_sender_client_id: <exact|null>
  key_vault_uri: <safe URI>
  key_vault_secret_name: <safe name>
  runtime_connection_principal: <exact>
  identity_bootstrap_receipt: <null|exact safe receipt returned by identity-bootstrap>
```

`plan` may perform bounded cloud and non-secret local reads, including the
fresh claim inspection required by this workflow. It must not mutate cloud
state, enable an API, create/rotate a credential, acquire file ownership,
access `memory-bank.md`, or write any file. It returns a complete safe
plan; it does not approve that plan. `plan_phase: initial` requires a null
bootstrap receipt and may accept a null Entra client ID only to prove the exact
named dedicated identity is absent. `plan_phase: post-identity-bootstrap`
requires the exact server-generated client ID and unchanged accepted receipt.

When an initial plan proves that exact identity is absent, it returns only an
`identityBootstrapPlan`. The parent must approve that narrow stage before
invoking:

```yaml
operation: identity-bootstrap
decision_envelope:
  approved: true
  approved_identity_bootstrap_plan: <exact unchanged identityBootstrapPlan>
```

The bootstrap plan may contain only exact dedicated Entra
app/service-principal/application-ID-URI creation, one credential creation
with direct secret-safe storage in the pinned existing Key Vault, exact
temporary secret-writer RBAC required for that write, cleanup, and safe
read-back. Its ordered operation names are limited to `create-entra-app`,
`create-entra-service-principal`, `set-entra-application-id-uri`,
`grant-temporary-key-vault-secrets-officer`,
`create-entra-credential-and-store-key-vault-secret`, and
`remove-temporary-key-vault-secrets-officer`. It contains explicit empty
`googleMutations` and `apiEnablement` lists. The bootstrap operation does not
access memory, make a Google cloud call, or write a local file.

For `operation: execute`, require:

```yaml
memory_bank_path: <working_dir>/memory-bank.md
memory_bank_sha256: <pre-wave hash>
exclusive_files:
  - <working_dir>/sender-auth.json
decision_envelope:
  approved: true
  approved_plan: <exact unchanged proposedPlan from operation: plan>
```

The parent passes `proposedPlan` unchanged. The only field beside it is
`approved: true`.

Treat the plan envelope or approved plan as immutable authority. Do not mutate,
broaden, normalize, or fill it from discovered defaults. Resolve `working_dir`
with `realpath` and require it to equal the current project root. Require
Firebase and Google project IDs to match exactly, and live Azure
tenant/subscription, active Google context, pool/provider, sender account,
Entra app, Key Vault URI/secret name, resource group, runtime connection
principal, route, Google execution mode, mutation list, API-enablement list,
and role decisions to match the pinned plan. A convenient active subscription,
project, same-name resource, account, or remembered value is never a
substitute. `execute` verifies the supplied memory-bank hash at start and
before return; the hash is a concurrency guard, not permission to read
decisions from memory.

Worker-mode rules:

1. Never call `AskUserQuestion`. A missing, ambiguous, stale, or newly required
   decision returns `NEEDS_CONTEXT: <exact missing parent decision>` as the
   literal first line. This includes a changed route/diff, an unapproved
   mutation, API enablement, CLI fallback, machine-level install, credential
   rotation, or replacement.
2. Identity mismatch or live drift from the pinned project/environment stops
   before mutation and returns `BLOCKED: <safe identity mismatch>`. Do not
   switch context or manufacture a corrected envelope.
3. `plan` either returns the narrow cold `identityBootstrapPlan` or one exact
   `reuse`, `repair`, or `provision` route with the complete ordered remaining
   mutation/API-enablement lists. The parent owns each approval separately.
   Bootstrap approval does not authorize Google/provider/IAM, runtime RBAC,
   proof, or handoff work. Final `execute` authorizes only the exact second
   approved lists and does not authorize adjacent repairs, replacement,
   rotation, or API enablement.
4. Do not write `memory-bank.md`. The only permitted worker-mode project write
   is the exact regular non-symlink `sender-auth.json` in `exclusive_files`,
   only during final `execute`, and only after the fresh four-stage proof
   succeeds. A failed or partial proof leaves it untouched. `preflight`,
   `plan`, and `identity-bootstrap` write no local file.
5. Never invoke another agent, skill, flow, build, or runtime owner. The
   parent owns all questions, dispatch, joins, retries, and the one final
   memory merge.

### Exact worker return protocol

Every operation returns a literal first line, one blank line, and exactly one
single-line `WORKER_RESULT: {...}` with no additional prose. Status mapping is
exact:

| Literal first line | JSON `status` | Required matching array |
|---|---|---|
| `DONE` | `done` | `concerns`, `contextRequests`, and `blockers` are empty |
| `DONE_WITH_CONCERNS: <comma-separated concerns>` | `done_with_concerns` | `concerns` is the same non-empty ordered list; the other two are empty |
| `NEEDS_CONTEXT: <stable reason code>` | `needs_context` | `contextRequests` is exactly `[<stable reason code>]`; the other two are empty |
| `BLOCKED: <reason>` | `blocked` | `blockers` is exactly `[<reason>]`; the other two are empty |

Do not use another JSON status spelling.

Canonical `stage` values apply to successful and unsuccessful returns:

| `operation` | Required `stage` |
|---|---|
| `preflight` | `preflight` |
| initial `plan` that proves the identity absent | `identity-bootstrap-plan` |
| every other `plan` | `sender-auth-plan` |
| `identity-bootstrap` | `identity-bootstrap` |
| `execute` | `sender-auth` |

A successful `preflight` is exactly:

```text
DONE

WORKER_RESULT: {"contractVersion":1,"worker":"mobile-app:push-wif-worker","runId":"<id>","operation":"preflight","stage":"preflight","status":"done","capabilities":{"supportedOperations":["preflight","plan","identity-bootstrap","execute"],"preflightRequiresExecutionEnvelope":false,"preflightCloudCalls":false,"preflightFileReads":false,"preflightFileWrites":false,"mayPrompt":false,"mayDelegate":false,"memoryWrites":false,"planSupported":true,"planCloudReads":true,"planMutations":false,"planFileWrites":false,"identityBootstrapSupported":true,"identityBootstrapCloudMutations":true,"identityBootstrapFileWrites":false,"executeSupported":true,"executeWriteScope":"sender-auth.json-only"},"identities":{},"decisions":{},"changedFiles":[],"validatedFiles":[],"validations":[{"name":"capability-contract","ok":true}],"memoryPatch":{"sections":[]},"contextRequests":[],"concerns":[],"blockers":[],"summary":"Push WIF worker capability preflight succeeded."}
```

When initial inventory proves the exact dedicated Entra identity is absent, a
successful read-only `plan` uses this exact bootstrap-plan shape:

```text
DONE

WORKER_RESULT: {"contractVersion":1,"worker":"mobile-app:push-wif-worker","runId":"<id>","operation":"plan","stage":"identity-bootstrap-plan","status":"done","capabilities":null,"identities":{"firebaseProjectId":"<id>","googleProjectId":"<id>","azureTenantId":"<id>","azureSubscriptionId":"<id>","wifPoolId":"<id>","wifProviderId":"<id>","senderServiceAccount":"<safe id>","entraSenderDisplayName":"<exact>","entraSenderClientId":null},"decisions":{"planPhase":"initial","googleExecutionMode":"mcp","resourceGroup":"<exact>","keyVaultUri":"<safe URI>","keyVaultSecretName":"<safe name>","runtimeConnectionPrincipal":"<exact>","identityBootstrapReceipt":null},"changedFiles":[],"validatedFiles":[],"validations":[{"name":"live-inventory","ok":true},{"name":"entra-identity-absent","ok":true},{"name":"identity-bootstrap-plan-complete","ok":true}],"memoryPatch":{"sections":[]},"contextRequests":[],"concerns":[],"blockers":[],"summary":"Read-only inventory found no dedicated Entra sender identity and proposed only the bootstrap stage.","identityBootstrapPlan":{"inventoryObservedAt":"<UTC timestamp>","route":"identity-bootstrap","mutations":[{"resource":"<safe exact Entra or Key Vault resource>","operation":"<exact allowlisted bootstrap operation>"}],"googleMutations":[],"apiEnablement":[],"identities":{"firebaseProjectId":"<id>","googleProjectId":"<id>","azureTenantId":"<id>","azureSubscriptionId":"<id>","wifPoolId":"<id>","wifProviderId":"<id>","senderServiceAccount":"<safe id>","entraSenderDisplayName":"<exact>","entraSenderClientId":null},"decisions":{"planPhase":"initial","googleExecutionMode":"mcp","resourceGroup":"<exact>","keyVaultUri":"<safe URI>","keyVaultSecretName":"<safe name>","runtimeConnectionPrincipal":"<exact>","identityBootstrapReceipt":null}}}
```

The parent displays and approves only this plan, then passes it unchanged.
A successful `identity-bootstrap` uses this exact shape:

```text
DONE

WORKER_RESULT: {"contractVersion":1,"worker":"mobile-app:push-wif-worker","runId":"<id>","operation":"identity-bootstrap","stage":"identity-bootstrap","status":"done","capabilities":null,"identities":{"firebaseProjectId":"<id>","googleProjectId":"<id>","azureTenantId":"<id>","azureSubscriptionId":"<id>","wifPoolId":"<id>","wifProviderId":"<id>","senderServiceAccount":"<safe id>","entraSenderDisplayName":"<exact>","entraSenderClientId":"<server-generated id>","entraSenderAppObjectId":"<server-generated id>","entraSenderServicePrincipalObjectId":"<server-generated id>"},"decisions":{"approved":true,"planPhase":"initial","route":"identity-bootstrap","mutations":[{"resource":"<safe exact Entra or Key Vault resource>","operation":"<exact approved bootstrap operation>"}],"googleMutations":[],"apiEnablement":[],"googleExecutionMode":"mcp","resourceGroup":"<exact>","keyVaultUri":"<safe URI>","keyVaultSecretName":"<safe name>","runtimeConnectionPrincipal":"<exact>","identityBootstrapReceipt":null,"inventoryObservedAt":"<UTC timestamp>"},"changedFiles":[],"validatedFiles":[],"validations":[{"name":"approved-bootstrap-plan-equality","ok":true},{"name":"entra-identity-readback","ok":true},{"name":"credential-stored-secret-safe","ok":true},{"name":"key-vault-metadata-readback","ok":true},{"name":"no-google-mutations","ok":true}],"memoryPatch":{"sections":[]},"contextRequests":[],"concerns":[],"blockers":[],"summary":"Dedicated Entra sender identity was created and its credential was stored without disclosure; remaining WIF work still requires a fresh plan and approval.","identityBootstrapReceipt":{"bootstrapCompletedAt":"<UTC timestamp>","entraSenderDisplayName":"<exact>","entraSenderClientId":"<server-generated id>","entraSenderAppObjectId":"<server-generated id>","entraSenderServicePrincipalObjectId":"<server-generated id>","applicationIdUri":"<safe exact URI>","credentialExpiresAt":"<UTC timestamp>","keyVaultUri":"<safe URI>","keyVaultSecretName":"<safe name>"}}
```

That success is not sender-auth completion. The parent must validate the
receipt, then invoke a fresh post-bootstrap `plan` with the returned client ID.
A successful post-bootstrap or reuse/repair plan uses this shape:

```text
DONE

WORKER_RESULT: {"contractVersion":1,"worker":"mobile-app:push-wif-worker","runId":"<id>","operation":"plan","stage":"sender-auth-plan","status":"done","capabilities":null,"identities":{"firebaseProjectId":"<id>","googleProjectId":"<id>","azureTenantId":"<id>","azureSubscriptionId":"<id>","wifPoolId":"<id>","wifProviderId":"<id>","senderServiceAccount":"<safe id>","entraSenderDisplayName":"<exact>","entraSenderClientId":"<id>"},"decisions":{"planPhase":"initial|post-identity-bootstrap","googleExecutionMode":"mcp","resourceGroup":"<exact>","keyVaultUri":"<safe URI>","keyVaultSecretName":"<safe name>","runtimeConnectionPrincipal":"<exact>","identityBootstrapReceipt":"<null|exact accepted safe receipt>"},"changedFiles":[],"validatedFiles":[],"validations":[{"name":"live-inventory","ok":true},{"name":"fresh-entra-claims","ok":true},{"name":"safe-plan-complete","ok":true}],"memoryPatch":{"sections":[]},"contextRequests":[],"concerns":[],"blockers":[],"summary":"Read-only WIF inventory and exact remaining proposal completed.","proposedPlan":{"inventoryObservedAt":"<UTC timestamp>","route":"repair","mutations":[{"resource":"<safe exact remaining resource id>","operation":"<exact remaining operation>"}],"apiEnablement":["<exact API>"],"leastPrivilegeRole":"<exact role>","claimContract":{"iss":"<observed issuer>","aud":"<observed audience>","appid":"<observed id|null>","azp":"<observed id|null>","selectedAppClaim":"appid|azp","applicationId":"<same client ID>","googleProviderIssuer":"<observed normalized issuer>"},"identities":{"firebaseProjectId":"<id>","googleProjectId":"<id>","azureTenantId":"<id>","azureSubscriptionId":"<id>","wifPoolId":"<id>","wifProviderId":"<id>","senderServiceAccount":"<safe id>","entraSenderDisplayName":"<exact>","entraSenderClientId":"<id>"},"decisions":{"planPhase":"initial|post-identity-bootstrap","googleExecutionMode":"mcp","resourceGroup":"<exact>","keyVaultUri":"<safe URI>","keyVaultSecretName":"<safe name>","runtimeConnectionPrincipal":"<exact>","identityBootstrapReceipt":"<null|exact accepted safe receipt>"}}}
```

Use explicit empty `mutations: []` and `apiEnablement: []` lists when no
remaining action is required. The parent must display and separately approve
the complete remaining plan, then pass the entire `proposedPlan` unchanged.

A successful `execute` uses this exact shape:

```text
DONE

WORKER_RESULT: {"contractVersion":1,"worker":"mobile-app:push-wif-worker","runId":"<id>","operation":"execute","stage":"sender-auth","status":"done","capabilities":null,"identities":{"firebaseProjectId":"<id>","googleProjectId":"<id>","azureTenantId":"<id>","azureSubscriptionId":"<id>","wifPoolId":"<id>","wifProviderId":"<id>","senderServiceAccount":"<safe id>","entraSenderDisplayName":"<exact>","entraSenderClientId":"<id>"},"decisions":{"approved":true,"planPhase":"initial|post-identity-bootstrap","route":"repair","mutations":[{"resource":"<safe exact remaining resource id>","operation":"<exact remaining operation>"}],"apiEnablement":["<exact API>"],"googleExecutionMode":"mcp","leastPrivilegeRole":"<exact role>","claimContract":{"iss":"<observed issuer>","aud":"<observed audience>","appid":"<observed id|null>","azp":"<observed id|null>","selectedAppClaim":"appid|azp","applicationId":"<same client ID>","googleProviderIssuer":"<observed normalized issuer>"},"resourceGroup":"<exact>","keyVaultUri":"<safe URI>","keyVaultSecretName":"<safe name>","runtimeConnectionPrincipal":"<exact>","identityBootstrapReceipt":"<null|exact accepted safe receipt>","inventoryObservedAt":"<UTC timestamp>"},"changedFiles":["sender-auth.json"],"validatedFiles":["sender-auth.json"],"validations":[{"name":"live-inventory","ok":true},{"name":"approved-plan-equality","ok":true},{"name":"four-stage-proof","ok":true},{"name":"sender-auth-contract","ok":true}],"memoryPatch":{"sections":[]},"contextRequests":[],"concerns":[],"blockers":[],"summary":"<one safe sentence>","senderAuthPath":"sender-auth.json","senderAuthMode":"wif","verifiedAt":"<UTC timestamp>","validUntil":"<UTC timestamp>","proofComplete":true}
```

All safe identities, route, execution mode, resource group, Key Vault
URI/secret name, runtime connection principal, ordered approval lists, role
fields, and inventory timestamp must equal the plan envelope or unchanged
approved plan. All result paths are normalized `/`-separated project-relative
paths, never absolute; `senderAuthPath`, `changedFiles`, and `validatedFiles`
must be exactly `sender-auth.json`. The parent resolves those paths against
`working_dir` before comparing them with the absolute exclusive path. Never
compare raw relative and absolute strings. Never include prompts, account
identity, tokens, secrets, authorization headers, credential values, or raw
cloud responses.

Direct mode remains unchanged unless all worker contract markers are present
and `worker_name` is exactly `mobile-app:push-wif-worker`. In fallback
orchestration, `/setup-push-wif` consumes these same `operation: plan`,
`operation: identity-bootstrap`, and `operation: execute` envelopes and
returns the same single worker result; it must not write memory.

## Contents

0. [Internal orchestrated owner contract](#internal-orchestrated-owner-contract)
1. [Tool and secret boundaries](#1-tool-and-secret-boundaries)
2. [Inputs and live inventory](#2-inputs-and-live-inventory)
3. [Choose exactly one route](#3-choose-exactly-one-route)
4. [Entra identity and Key Vault](#4-entra-identity-and-key-vault)
5. [Claim-driven provider contract](#5-claim-driven-provider-contract)
6. [Google WIF and IAM](#6-google-wif-and-iam)
7. [Fresh end-to-end proof](#7-fresh-end-to-end-proof)
8. [Handoff and final validation](#8-handoff-and-final-validation)

## 1. Tool and secret boundaries

- Prefer pinned `@google-cloud/gcloud-mcp@0.5.3` and use
  `@azure/mcp@2.0.5` semantics.
- When available, use `mcp__gcloud__run_gcloud_command` for every Google Cloud
  read, mutation, IAM operation, and read-back. Its `args` is one tokenized
  command, starts with the subcommand, and contains no shell syntax.
- If gcloud MCP remains unavailable after `/mcp`, `/setup`, `/restart`, and
  `/mcp`, the user may approve the official CLI fallback. Require `gcloud
  --version`, confirm the active account, and execute every Google operation as
  `node "${PLUGIN_ROOT}/scripts/run-allowlisted-gcloud.js" -- <args>`. The
  wrapper invokes no shell and rejects command families outside
  `shared/mcp/gcloud-allowlist.json`. Keep explicit project/location flags and
  the same read-back and mutation confirmations as the MCP path.
- Use Azure namespace tools `mcp__azure__subscription`,
  `mcp__azure__group`, and `mcp__azure__role`; call the namespace tool plus
  routed command/parameters. Use `role_assignment_list` for RBAC inventory.
- The plugin does not expose the Azure MCP `keyvault` namespace because GA
  2.0.5 offers value-carrying Key Vault secret operations but no safe
  metadata-only list. Do not invent
  `mcp__azure__azmcp_role_assignment_list` or `keyvault_secret_list`.
- Keep `az` only for Entra app/service-principal/credential work and
  secret-safe Key Vault metadata/write operations. Never replace covered Azure
  MCP reads with `az`. Do not call `gcloud` directly; the guarded wrapper is
  the only CLI fallback.

Never print, echo, persist, or place in argv, files, flow definitions,
`memory-bank.md`, or captured output any client secret, JWT, access token,
authorization header, Key Vault value, or full token/HTTP response. Disable
shell tracing. Keep secrets only in shell variables and unset them in the same
process.

## 2. Inputs and live inventory

In direct mode, read `memory-bank.md`. In worker `operation: plan`,
`operation: identity-bootstrap`, and `operation: execute`, do not read memory;
use only the pinned plan envelope or unchanged approved stage plan, with the
raw-byte hash used only by final `execute` as a concurrency guard. Verify the
active Azure identity and Google Cloud account.
With gcloud MCP:

```json
{"args":["config","list","account","--format=json"]}
```

With the approved CLI fallback:

```bash
node "${PLUGIN_ROOT}/scripts/run-allowlisted-gcloud.js" -- \
  config list account --format=json
```

Collect tenant ID, subscription, Key Vault and secret names, Firebase/Google
project ID and number, pool/provider IDs, proposed sender service-account name,
and the object ID of the **actual Power Automate Key Vault connection
principal**. Never assume the maker, flow owner, or sender app is that principal.

If `sender-auth.json` exists, validate it and use only its non-secret IDs as
inventory candidates. It is not proof of live compatibility.

Inventory the Entra app/service principal, credential metadata, Key Vault
secret metadata, runtime RBAC, pool/provider, sender service account and its
keys/IAM policy, Firebase project IAM policy, and custom FCM role. An initial
worker plan may carry `entra_sender_client_id: null`; in that case, inventory
the exact pinned display name and prove absence rather than inventing a client
ID. Acquire a fresh Entra app-only token through the referenced secret and
inspect it as in Section 5 only when an exact existing or just-bootstrapped
client ID is available.

When a custom FCM role is created successfully but FCM authorization still
returns `PERMISSION_DENIED`, use the read-only
`iam list-testable-permissions` command against the exact project resource to
confirm whether `cloudmessaging.messages.create` currently supports custom
roles before proposing the broader Firebase Cloud Messaging Admin fallback.
This diagnostic does not authorize API enablement or IAM mutation.

Require all of this compatible state:

| Area | Required state |
|---|---|
| Provider | Enabled; exact normalized issuer; singleton observed audience; exactly `google.subject=assertion.sub` plus the observed `appid` or `azp` mapping; app-ID equality condition with no tenant-only, wildcard, or alternate-app path. |
| WIF binding | `roles/iam.workloadIdentityUser` on the sender service account for the exact app-restricted `principalSet://.../attribute.<claim>/<client-id>`, never the whole pool. |
| Sender account | Exists, enabled, dedicated, no integration-created user-managed keys, and no Owner, Editor, or Service Account Token Creator. |
| FCM | Only the sender account is bound to the approved custom role, whose enabled permission set is exactly `cloudmessaging.messages.create`. Broader Firebase roles are incompatible with this WIF flow. |
| Key Vault | Exact URI/name, enabled and unexpired metadata; runtime connection principal has `Key Vault Secrets User` at the secret or narrowest supported vault scope. Contributor is insufficient. |
| Live claims | Fresh helper output has the expected tenant issuer, exact audience, and `appid`/`azp` equal to the dedicated client ID. |

Enumerate relevant IAM/RBAC bindings so a broad grant cannot hide behind the
required narrow one. Normalize only documented representation differences,
such as list ordering and the helper-provided terminal-slash normalization.

Use Azure MCP `role_assignment_list` for RBAC read-back. Use only:

```bash
az keyvault secret show \
  --query '{id:id,enabled:attributes.enabled,expires:attributes.expires}'
```

for metadata because the safe MCP metadata route is absent. Never display the
secret value.

## 3. Choose exactly one route

In direct mode, show the discovered state, route, exact
resources/settings/RBAC affected, security impact, and rollback. Obtain
explicit approval before the first repair or provisioning mutation.

In worker `operation: plan`, return the discovered state and exactly one
complete safe plan. A genuinely absent dedicated Entra identity returns
`identityBootstrapPlan` with only the narrow identity/credential and
secret-safe Key Vault stage. Existing identity paths, and the mandatory fresh
plan after bootstrap, return `proposedPlan` with the exact remaining
reuse/repair/provision route, ordered mutation and API-enablement lists,
least-privilege role, and inventory timestamp. Do not ask, approve, or mutate.
The parent displays each whole plan and owns its distinct
`AskUserQuestion` approval.

In worker `operation: identity-bootstrap`, the unchanged approved bootstrap
plan authorizes only its exact narrow mutations. In worker `operation:
execute`, the unchanged `approved_plan` replaces the interactive prompt only
for its exact remaining route and ordered lists. Any discovered addition,
deletion, reorder, route change, execution-mode change, resource change, API
enablement, or replacement/rotation is `NEEDS_CONTEXT:
wif-route-approval-required`; never call `AskUserQuestion` or treat parent
orchestration or first-stage approval as blanket approval.

- **Validate/reuse:** every comparison is compatible and no mutation is
  needed. Reuse remains provisional until the fresh proof succeeds.
- **Repair:** intended dedicated resources exist but settings/bindings/RBAC
  drifted. Present a field-level diff. After approved changes, reread the
  entire inventory, not only changed fields.
- **Provision:** required dedicated resources do not exist or the user chooses
  isolation. Present the complete plan and confirm IDs. In worker mode, a
  missing Entra identity is first split into the narrow bootstrap stage; only
  its fresh post-bootstrap plan may classify and propose the remaining Google,
  API, IAM, runtime RBAC, proof, and handoff work. If an expected ID exists,
  return to reuse/repair; never overwrite or silently rename.

In direct mode, when repair and provision are both viable, present both. In
worker `operation: plan`, return `NEEDS_CONTEXT` with a stable safe route-choice
code rather than returning alternatives or guessing. Inspection/reuse approval
is not repair approval; repair approval is not replacement approval. Never
broaden app restriction to tenant-only trust, use a whole-pool binding, or
substitute a broader FCM role.

## 4. Entra identity and Key Vault

Create or repair a dedicated app registration/service principal and dedicated
application ID URI. For approved creation/rotation, use
`az ad app credential reset`, capture the password directly into a shell
variable, write it immediately to Key Vault, and unset it in the same shell
process. Do not append credentials indefinitely; record the expiry and rotation
owner.

For a truly absent identity in orchestrated mode, this work is an explicit
serial `identity-bootstrap` stage. Freshly reread absence before the first
mutation, execute only the unchanged approved bootstrap list, and return only
the safe server-generated client/app/service-principal IDs, application ID
URI, credential expiry, and Key Vault URI/name. The credential value must flow
directly to Key Vault in the same non-echoing process. Do not call any Google
mutation, enable an API, grant final runtime RBAC, run the four-stage proof, or
write `sender-auth.json`. The next action is always a new read-only plan using
the generated client ID and a fresh token; bootstrap completion is never
sender-auth completion.

The provisioning administrator may temporarily need `Key Vault Secrets
Officer` at the narrowest scope. Runtime is separate: grant the actual Power
Automate Key Vault connection principal only `Key Vault Secrets User` at the
secret or narrowest supported vault scope. The sender app needs no Key Vault
read access. Remove the temporary writer role when provisioning no longer
requires secret writes.

Treat `Forbidden`, `AuthorizationFailed`, `ForbiddenByRbac`, empty assignment
results, or propagation failure as blockers. Never copy the secret into the
flow as a workaround. Report:

```text
BLOCKED: Key Vault connection principal <object-id> cannot read secret
<secret-name> in vault <vault-name>. Assign Key Vault Secrets User at the
narrowest supported scope, wait for RBAC propagation, and retry.
```

Reuse must not rotate a healthy credential; repair must list credential
rotation as a separate mutation.

## 5. Claim-driven provider contract

Request a fresh app-only token and pass it only on stdin to the local helper:

```bash
set +x
WIF_CLAIMS="$(
  printf '%s' "$ENTRA_TOKEN" |
    node "${PLUGIN_ROOT}/scripts/inspect-entra-wif-jwt.js"
)"
unset ENTRA_TOKEN
printf '%s\n' "$WIF_CLAIMS"
```

The helper emits only non-secret `iss`, `aud`, present `appid`/`azp`,
`selectedAppClaim`, and `googleProviderIssuer`. Use those values directly:

- provider issuer = `googleProviderIssuer`;
- allowed audiences = singleton exact observed `aud`;
- mapping = `google.subject=assertion.sub` plus only the observed
  `attribute.appid=assertion.appid` or `attribute.azp=assertion.azp`;
- condition = equality between that mapped attribute and the dedicated client
  ID.

A v1 token may report `iss=https://sts.windows.net/<tenant>/`; preserve the
observed claim but use the helper's no-trailing-slash provider issuer. Do not
rewrite it to `login.microsoftonline.com`. A v2 endpoint does not prove `azp`.
Stop if neither app claim exists; never weaken to tenant-only trust.

## 6. Google WIF and IAM

Use one gcloud MCP call per command, or one guarded wrapper invocation per
command in fallback mode. Example MCP read-back:

```json
{
  "args": [
    "iam", "workload-identity-pools", "providers", "describe",
    "<provider-id>", "--location=global",
    "--workload-identity-pool=<pool-id>", "--project=<project-id>",
    "--format=json"
  ]
}
```

Create/repair the pool and OIDC provider from the observed contract, then read
back issuer, audience, mapping, and condition before IAM mutation. A mismatch
returns to the approved repair route; do not compensate with broader trust.

Use these gcloud MCP command families as the provisioning templates, always
with explicit project/location/resource flags and JSON read-back:

| Resource | Mutate | Read back |
|---|---|---|
| Pool | `iam workload-identity-pools create` | `iam workload-identity-pools describe` |
| OIDC provider | `iam workload-identity-pools providers create-oidc` or approved `update-oidc` | `iam workload-identity-pools providers describe` |
| Sender account | `iam service-accounts create` | `iam service-accounts describe` and `keys list` |
| WIF binding | `iam service-accounts add-iam-policy-binding` | `iam service-accounts get-iam-policy` |
| FCM role | `iam roles create` or approved `update` | `iam roles describe` |
| Project binding | `projects add-iam-policy-binding` | `projects get-iam-policy` |

Never run blind create-on-conflict or mutation without its selected route's
confirmation. Repair only fields in the approved diff and reread the complete
resource afterward.

Create/reuse a dedicated sender service account. Bind
`roles/iam.workloadIdentityUser` only to the exact app-restricted principal set.
Prefer a project custom role containing only
`cloudmessaging.messages.create`. This is the only supported FCM project role
for the WIF sender; Firebase Admin SDK access and
`roles/firebasecloudmessaging.admin` are unnecessary and must not be offered.
If organization policy prohibits the custom role, stop with
`wif-custom-role-policy-blocked` rather than asking to broaden access. Never
grant Owner, Editor, Service Account Token Creator, or create a service-account
key.

Do not proactively enable APIs. If inventory specifically reports STS, IAM
Credentials, IAM, or FCM disabled, direct mode shows that API and obtains
approval. Worker `plan` lists the exact API in `apiEnablement` without enabling
it; worker `execute` enables only an exact approved list entry. Then issue one
explicit `services enable` and reread the affected resource.

## 7. Fresh end-to-end proof

Using current read-back resources and fresh values held only in shell
variables:

1. issue and inspect a new Entra app-only JWT;
2. exchange it at Google STS using the provider's canonical audience;
3. call `generateAccessToken` for the dedicated sender account with only
   `https://www.googleapis.com/auth/firebase.messaging` and lifetime `900s`;
4. call FCM HTTP v1 with `validateOnly: true` and a syntactically valid
   `allUsers` topic message.

Parse only status and bounded error fields. Distinguish:

- Entra `invalid_client`: credential/app configuration;
- STS `invalid_grant`: issuer/audience/mapping/condition;
- IAM Credentials `403`: workload-identity-user binding;
- FCM `403`: messaging permission, project, or API.

All four stages must succeed in this run. Resource existence, old proof, or
provider creation alone is never sufficient.

## 8. Handoff and final validation

Only after proof succeeds, write version-1 mode-`wif` `sender-auth.json` from
live read-back values and current claims. Set verifier `setup-push-wif`, all
four proof steps true, canonical UTC `verifiedAt`, `validUntil` no more than 24
hours later, and only the Key Vault URI/secret name—not value or payload
version. Never create or overwrite the handoff after partial/failed proof.

```bash
node "${PLUGIN_ROOT}/scripts/validate-sender-auth-contract.js" \
  --project-root "<working_dir>" --file sender-auth.json \
  --expected-firebase-project "<firebase-project-id>"
```

Exit `0` is required. Exit `2` means repair the non-secret contract and
revalidate; exit `1` is a file/input failure. The validator does not replace
live read-backs or the four-stage proof.

Record only non-secret IDs, claim shape, issuer/audience, selected route,
read-back result, RBAC scopes, proof times, handoff version/path, and credential
expiry in `memory-bank.md`; state that no token or secret was persisted. Run
`validate-mobile-files.js` for every changed local file:

```bash
node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" \
  --project-root "<working_dir>" --file "<changed-file>"
```

If none changed, say so rather than inventing a target.

In worker `operation: plan` or `operation: identity-bootstrap`, do not write
any local file and return only the required empty `memoryPatch: { sections:
[] }`. In worker `operation: execute`, do not perform the `memory-bank.md`
write above. Return only allowlisted non-secret state in
`WORKER_RESULT.memoryPatch.sections` for the parent to merge once after every
track joins and the pre-wave SHA-256 still matches. Validate only
`sender-auth.json`, because it is the only local file this worker may create or
update after live proof.
