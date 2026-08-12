---
name: setup-push-wif
description: Use when provisioning, verifying, or repairing the keyless Entra-to-Google Workload Identity Federation used by a Power Automate FCM sender, including JWT claim discovery, Google STS, sender service-account impersonation, or Azure Key Vault RBAC.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: opus
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**WIF protocol: [push-flow-wif.md](${PLUGIN_ROOT}/shared/references/push-flow-wif.md)**.

# Set up push sender WIF

Provision and prove the keyless identity chain used by the push notification
flow:

`dedicated Entra sender app -> Google STS -> sender service account -> FCM`

Use `az` for Entra ID and Key Vault operations and `gcloud` for all Google
Cloud IAM/WIF operations. Never create or download a Google service-account
key.

## Safety and required inputs

Before creating or changing cloud resources:

1. Read `memory-bank.md` and the WIF reference.
2. Verify `az account show` and `gcloud config list account --format=json`.
3. Collect tenant ID, Azure subscription, Key Vault name/secret name, Google
   project ID/project number, pool/provider IDs, Firebase project ID, and the
   proposed sender service-account name.
4. Identify the Entra principal used by the Power Automate Azure Key Vault
   connection. Require its object ID; do not assume the flow maker, flow owner,
   or sender app reads Key Vault.
5. Show a resource/RBAC plan and obtain explicit confirmation before mutation.

Use a dedicated Entra application and dedicated Google service account. Reuse
only when the existing resources are demonstrably dedicated to this sender.

## 1. Create the Entra sender identity and secret

Create an app registration and service principal, then assign an application ID
URI dedicated to this token exchange. Create the credential with `az ad app
credential reset`, capture its password directly into a shell variable, write it
immediately to Azure Key Vault, and `unset` it in the same shell process.

Never print the credential, place it in command output captured by the
conversation, write it to a file, put it in `memory-bank.md`, or store it in a
Power Automate definition. Do not use `--append` indefinitely: record the
credential end date and define a rotation owner.

The active provisioning administrator may need `Key Vault Secrets Officer` at
the narrowest practical vault scope to create or update the secret. This writer
role is separate from flow runtime access; remove it when provisioning no
longer requires secret writes.

Grant the Key Vault connection principal only `Key Vault Secrets User`, scoped
to the one secret when the vault/RBAC configuration supports secret-level
scope; otherwise use vault scope and call out the wider scope. The sender app
does not need Key Vault read access. Treat `Forbidden`,
`AuthorizationFailed`, `ForbiddenByRbac`, or an empty role-assignment result as
a hard failure:

```text
BLOCKED: Key Vault connection principal <object-id> cannot read secret
<secret-name> in vault <vault-name>. Assign Key Vault Secrets User at the
narrowest supported scope, wait for RBAC propagation, and retry.
```

Do not continue by copying the secret into an environment variable or flow.

## 2. Obtain a token and discover its actual claims

Retrieve the secret into a shell variable and request one app-only access token.
With shell tracing disabled, pass the JWT only on stdin to the bundled local
helper; never place it in argv or use a web JWT inspector:

```bash
set +x
WIF_CLAIMS="$(
  printf '%s' "$ENTRA_TOKEN" |
    node "${PLUGIN_ROOT}/scripts/inspect-entra-wif-jwt.js"
)"
unset ENTRA_TOKEN
printf '%s\n' "$WIF_CLAIMS"
```

The helper decodes without verifying or signing, emits only non-secret `iss`,
`aud`, present `appid`/`azp`, `selectedAppClaim`, and
`googleProviderIssuer`, and fails if neither app identity claim exists. Use
those emitted values directly; do not independently reinterpret the JWT.

The provider configuration MUST be derived from this observed token:

- `issuer-uri` is the normalized observed `iss`.
- `allowed-audiences` contains the exact observed `aud`.
- For a tested v1 token whose issuer is
  `https://sts.windows.net/<tenant-id>/`, retain that exact value as the
  observed `iss`, but configure Google's provider with the helper's
  `googleProviderIssuer`: `https://sts.windows.net/<tenant-id>` (no trailing
  slash). Map `attribute.appid=assertion.appid` and restrict the condition to
  the dedicated sender client ID.
- Use `attribute.azp=assertion.azp` only when the observed token actually has
  `azp`. A v2 endpoint or `/v2.0` issuer does not by itself prove that `azp`
  exists.
- If neither `appid` nor `azp` is present, stop. Do not weaken the provider to
  tenant-only trust.

Do not add a trailing slash to Google's provider issuer. The helper validates
the tenant GUID and removes only the terminal slash from the observed
`sts.windows.net` form; it must not rewrite the authority to
`login.microsoftonline.com` or v2.

Use a stable `google.subject` mapping from an observed stable claim (normally
`assertion.sub`) plus the app identity attribute. Do not guess claim names from
portal settings or documentation examples.

## 3. Provision Google WIF with gcloud

Enable the STS, IAM Credentials, IAM, and FCM APIs. Use `gcloud iam
workload-identity-pools` and
`gcloud iam workload-identity-pools providers create-oidc` with:

- the observed normalized issuer;
- the exact observed audience;
- `google.subject=assertion.sub`;
- exactly one observed app mapping (`attribute.appid=assertion.appid` or
  `attribute.azp=assertion.azp`);
- an attribute condition comparing that mapped attribute to the dedicated
  Entra sender client ID.

Read the provider back with `gcloud ... providers describe` and compare issuer,
audience, mapping, and condition before granting access. A mismatch is
`BLOCKED`; do not compensate by broadening the condition.

Create a dedicated sender service account. Grant
`roles/iam.workloadIdentityUser` on that service account only to the exact
principal set for the mapped sender client ID. Do not grant it to the entire
pool.

For FCM send permission, prefer a project custom role containing only
`cloudmessaging.messages.create` and bind it only to the sender service account.
If organization policy prevents custom roles, explain the difference and
require explicit approval before using `roles/firebasecloudmessaging.admin`.
Do not grant Owner, Editor, Service Account Token Creator, or a Firebase
service-account key.

## 4. Prove the complete exchange

Run a proof with fresh tokens, keeping every token in shell variables and
redacting HTTP bodies:

1. Get the Entra app-only JWT using the Key Vault secret.
2. Exchange it at `https://sts.googleapis.com/v1/token` with the provider's
   canonical audience resource name.
3. Call `generateAccessToken` for the dedicated sender service account with
   only `https://www.googleapis.com/auth/firebase.messaging` and a 900-second
   lifetime.
4. Call FCM HTTP v1 with `validateOnly: true` and a syntactically valid
   `allUsers` topic message. This proves the final permission without delivery.

Check HTTP status and parse only bounded error fields. Never echo request
headers, JWTs, access tokens, client secrets, or complete token responses.
Success requires all four stages. Distinguish failures explicitly:

- Entra `invalid_client`: sender credential or app configuration.
- STS `invalid_grant`: issuer/audience/claim mapping mismatch; re-decode a fresh
  token and compare it to the provider.
- IAM Credentials `403`: missing or incorrectly scoped
  `roles/iam.workloadIdentityUser`.
- FCM `403`: missing `cloudmessaging.messages.create`, wrong Firebase project,
  or disabled API.

Do not report success from provider creation alone.

## 5. Record and validate

Record only non-secret resource IDs, observed claim shape, normalized issuer,
audience, selected app claim, RBAC scopes, proof timestamp/result, and
credential expiry in `memory-bank.md`. Explicitly state that no token or secret
was persisted.

Track every local file changed by this skill. Before success, validate each one
explicitly:

```bash
node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" \
  --project-root "<working_dir>" \
  --file "<changed-file-1>" \
  --file "<changed-file-2>"
```

Omit nonexistent placeholders and pass no directory. Exit `2` requires repair
and rerun; exit `0` is required. If no local file changed, say so explicitly
and do not invent a validation target.
