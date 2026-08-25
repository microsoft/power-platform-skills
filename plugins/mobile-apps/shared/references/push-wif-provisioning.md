# Push sender WIF provisioning

Canonical inventory, validate/reuse, repair, provisioning, proof, and handoff
workflow for:

`dedicated Entra sender app -> Google STS -> sender service account -> FCM`

Read `official-mcp-servers.md`, `sender-auth-contract.md`, and this reference
before any cloud operation. Never create or download a Google service-account
key.

## Contents

1. [Tool and secret boundaries](#1-tool-and-secret-boundaries)
2. [Inputs and live inventory](#2-inputs-and-live-inventory)
3. [Choose exactly one route](#3-choose-exactly-one-route)
4. [Entra identity and Key Vault](#4-entra-identity-and-key-vault)
5. [Claim-driven provider contract](#5-claim-driven-provider-contract)
6. [Google WIF and IAM](#6-google-wif-and-iam)
7. [Fresh end-to-end proof](#7-fresh-end-to-end-proof)
8. [Handoff and final validation](#8-handoff-and-final-validation)

## 1. Tool and secret boundaries

- Use pinned `@google-cloud/gcloud-mcp@0.5.3` and `@azure/mcp@2.0.5`
  semantics.
- Use `mcp__gcloud__run_gcloud_command` for every Google Cloud read,
  mutation, IAM operation, and read-back. Its `args` is one tokenized command,
  starts with the subcommand, and contains no shell syntax.
- Use Azure namespace tools `mcp__azure__subscription`,
  `mcp__azure__group`, and `mcp__azure__role`; call the namespace tool plus
  routed command/parameters. Use `role_assignment_list` for RBAC inventory.
- The plugin does not expose the Azure MCP `keyvault` namespace because GA
  2.0.5 offers value-carrying Key Vault secret operations but no safe
  metadata-only list. Do not invent
  `mcp__azure__azmcp_role_assignment_list` or `keyvault_secret_list`.
- Keep `az` only for Entra app/service-principal/credential work and
  secret-safe Key Vault metadata/write operations. Never replace covered Azure
  MCP reads with `az`, and never use CLI/REST instead of gcloud MCP.

Never print, echo, persist, or place in argv, files, flow definitions,
`memory-bank.md`, or captured output any client secret, JWT, access token,
authorization header, Key Vault value, or full token/HTTP response. Disable
shell tracing. Keep secrets only in shell variables and unset them in the same
process.

## 2. Inputs and live inventory

Read `memory-bank.md`. Verify the active Azure identity and the gcloud MCP
account:

```json
{"args":["config","list","account","--format=json"]}
```

Collect tenant ID, subscription, Key Vault and secret names, Firebase/Google
project ID and number, pool/provider IDs, proposed sender service-account name,
and the object ID of the **actual Power Automate Key Vault connection
principal**. Never assume the maker, flow owner, or sender app is that principal.

If `sender-auth.json` exists, validate it and use only its non-secret IDs as
inventory candidates. It is not proof of live compatibility.

Inventory the Entra app/service principal, credential metadata, Key Vault
secret metadata, runtime RBAC, pool/provider, sender service account and its
keys/IAM policy, Firebase project IAM policy, and custom FCM role. Acquire a
fresh Entra app-only token through the referenced secret and inspect it as in
Section 5.

Require all of this compatible state:

| Area | Required state |
|---|---|
| Provider | Enabled; exact normalized issuer; singleton observed audience; exactly `google.subject=assertion.sub` plus the observed `appid` or `azp` mapping; app-ID equality condition with no tenant-only, wildcard, or alternate-app path. |
| WIF binding | `roles/iam.workloadIdentityUser` on the sender service account for the exact app-restricted `principalSet://.../attribute.<claim>/<client-id>`, never the whole pool. |
| Sender account | Exists, enabled, dedicated, no integration-created user-managed keys, and no Owner, Editor, or Service Account Token Creator. |
| FCM | Only the sender account is bound to the approved custom role, whose enabled permission set is exactly `cloudmessaging.messages.create`, or to an explicitly approved admin fallback. |
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

Show the discovered state, route, exact resources/settings/RBAC affected,
security impact, and rollback. Obtain explicit approval before the first
repair or provisioning mutation.

- **Validate/reuse:** every comparison is compatible and no mutation is
  needed. Reuse remains provisional until the fresh proof succeeds.
- **Repair:** intended dedicated resources exist but settings/bindings/RBAC
  drifted. Present a field-level diff. After approved changes, reread the
  entire inventory, not only changed fields.
- **Provision:** required dedicated resources do not exist or the user chooses
  isolation. Present the complete plan and confirm IDs. If an expected ID
  exists, return to reuse/repair; never overwrite or silently rename.

When repair and provision are both viable, present both. Inspection/reuse
approval is not repair approval; repair approval is not replacement approval.
Never broaden app restriction to tenant-only trust, use a whole-pool binding,
or substitute a broader FCM role without its separate explicit approval.

## 4. Entra identity and Key Vault

Create or repair a dedicated app registration/service principal and dedicated
application ID URI. For approved creation/rotation, use
`az ad app credential reset`, capture the password directly into a shell
variable, write it immediately to Key Vault, and unset it in the same shell
process. Do not append credentials indefinitely; record the expiry and rotation
owner.

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

Use one gcloud MCP call per command. Example read-back:

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
`cloudmessaging.messages.create`. If policy prohibits custom roles, explain the
difference and obtain explicit approval before
`roles/firebasecloudmessaging.admin`. Never grant Owner, Editor, Service
Account Token Creator, or create a service-account key.

Do not proactively enable APIs. If a command specifically reports STS, IAM
Credentials, IAM, or FCM disabled, show that API, obtain approval, issue one
explicit `services enable`, and reread the affected resource.

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
