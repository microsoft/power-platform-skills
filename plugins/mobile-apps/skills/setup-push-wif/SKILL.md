---
name: setup-push-wif
description: Use when provisioning, validating, reusing, or repairing the keyless Entra-to-Google Workload Identity Federation used by a Power Automate FCM sender, including JWT claim discovery, Google STS, sender service-account impersonation, or Azure Key Vault RBAC.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: opus
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**WIF protocol: [push-flow-wif.md](${PLUGIN_ROOT}/shared/references/push-flow-wif.md)**.

**Sender-auth handoff: [sender-auth-contract.md](${PLUGIN_ROOT}/shared/references/sender-auth-contract.md)**.

# Set up push sender WIF

Validate, reuse, repair, or provision—and then prove—the keyless identity chain
used by the push notification flow:

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
5. Show the discovered state, the selected route, and any resource/RBAC
   mutations. Obtain explicit confirmation before every repair or provision
   route.

Use a dedicated Entra application and dedicated Google service account. Reuse
only when the existing resources are demonstrably dedicated to this sender.

## 1. Inventory first and select exactly one route

Do not infer compatibility from names, IDs, or resource existence. Start with a
read-only inventory of the proposed Entra app/service principal, Key Vault
secret reference, runtime Key Vault connection principal, workload identity
pool/provider, sender service account, project IAM policy, and FCM custom role.
If `sender-auth.json` exists, validate it and use its non-secret IDs only as
inventory candidates; it is not evidence that the live resources still match.

Acquire a **fresh** Entra app-only token using the referenced Key Vault secret,
pipe it through `inspect-entra-wif-jwt.js` as described in Step 3, and use the
observed claim shape as the expected provider contract. A portal setting,
previous token, memory-bank entry, or old handoff is not a substitute.

Read back and compare all of the following:

| Area | Required compatible state |
|---|---|
| Provider | Enabled; issuer equals `googleProviderIssuer`; allowed audiences equal the singleton exact observed audience; mapping contains exactly `google.subject=assertion.sub` plus the observed `attribute.appid=assertion.appid` or `attribute.azp=assertion.azp`; condition is restricted to equality with the dedicated Entra client ID and contains no tenant-only, wildcard, or alternate-app path. |
| WIF principal binding | The sender service account IAM policy grants `roles/iam.workloadIdentityUser` to the exact `principalSet://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/<pool-id>/attribute.<appid-or-azp>/<client-id>` member. A whole-pool or differently restricted member is incompatible. |
| Sender service account | The exact account exists, is enabled, is dedicated to this sender, has no user-managed service-account keys created for this integration, and has none of Owner, Editor, or Service Account Token Creator. |
| FCM authorization | The Firebase project IAM policy binds only the sender service account to either the approved custom role or the explicitly approved admin fallback. For a custom role, read back the role and require it to be enabled and to contain exactly `cloudmessaging.messages.create`; role existence or a similarly named role is not enough. |
| Key Vault | The vault URI and secret name identify an enabled, non-expired secret reference. The reference comparison is metadata-only; never display or record its value. Read back role assignments for the **actual Power Automate Key Vault connection principal** and require `Key Vault Secrets User` at that secret or the narrowest supported vault scope. Contributor/control-plane access is not sufficient. Retrieve the value only into a shell variable when requesting the fresh Entra tokens, then unset it in the same process. |
| Live Entra claims | Fresh helper output has the expected tenant issuer, exact audience, and `appid` or `azp` value equal to the dedicated sender client ID. The provider must match this observed shape, not the reverse. |

Also enumerate relevant IAM/RBAC bindings so a broad binding cannot be hidden by
the presence of the required narrow one. Normalize only documented
representation differences (for example, audience list ordering and the
helper-provided trailing-slash normalization); do not rewrite expressions or
treat semantically broader conditions as equal.

Classify the inventory into exactly one route:

### Route A — validate and reuse

Choose reuse only when every comparison above is compatible and no mutation is
needed. State that reuse is provisional until the fresh end-to-end proof in
Step 5 succeeds. Resource existence, successful provider description, or an
old proof alone must never produce `sender-auth.json`.

### Route B — repair existing resources

Choose repair when the intended dedicated resources exist but one or more
settings, IAM bindings, RBAC assignments, or permissions are missing or
incompatible. Present a field-level diff, the exact commands/resources to be
changed, security impact, and rollback approach. Obtain explicit approval for
the repair route before the first mutation. Do not silently broaden a provider,
replace an app restriction with tenant-only trust, add a whole-pool binding, or
substitute a broader FCM role.

After repair, read back and compare the **entire** checklist again—not only the
fields changed. Any remaining mismatch blocks proof and handoff creation.

### Route C — provision new resources

Choose provisioning only when the required dedicated resources do not exist or
the user explicitly prefers isolation over repair. Present the complete new
resource and RBAC plan and obtain explicit approval before creation. If an
expected ID already exists, stop and return to Route A or B; do not overwrite or
adopt it merely because creation reported a conflict. If new IDs are required,
show them and obtain confirmation rather than silently changing names.

When both repair and new provisioning are viable, show them as distinct choices
with their affected resources. Approval to inspect or reuse is not approval to
repair, and approval to repair is not approval to provision replacements.

## 2. Create or repair the Entra sender identity and secret

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

For Route A, do not rotate or rewrite a compatible credential just to validate
reuse. Retrieve it only for the fresh token proof, keep it in a shell variable,
and unset it in the same shell process. For Route B, credential rotation or
secret replacement is a separate listed mutation requiring approval; preserve
the existing secret when it is healthy and compatible.

## 3. Obtain a token and discover its actual claims

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

Compare the fresh helper output with the configured tenant/client/audience and
the live provider. A provider/claim mismatch is Route B material, not a reason
to weaken the condition. Stop before proof until the user explicitly approves
and the repair is read back successfully.

## 4. Provision or repair Google WIF with gcloud

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
incompatible with reuse; do not compensate by broadening the condition. Repair
only through the approved Route B plan, then read it back again.

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

For existing resources, read back both the service-account IAM policy and
Firebase project IAM policy before proof. Missing
`roles/iam.workloadIdentityUser`, missing Key Vault runtime RBAC, missing FCM
permission, an unapproved broad binding, or a custom role whose permission set
has drifted is not valid reuse. Route it to an explicitly approved repair or
stop.

## 5. Prove the complete exchange

Run a proof with fresh tokens, keeping every token in shell variables and
redacting HTTP bodies:

1. Get a new Entra app-only JWT using the Key Vault secret and inspect its
   non-secret claims again. The proof token must not be the earlier inventory
   token.
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

Do not report success from provider creation, IAM/RBAC presence, or a previous
proof alone. All four stages must use the currently read-back resources and
complete in this run.

## 6. Write the versioned sender-auth handoff

Only after the complete fresh proof succeeds, write `sender-auth.json` in the
app project root using version `1`, mode `wif`, and the exact schema in
`sender-auth-contract.md`. Populate it from the read-back resources and latest
observed claims—not from proposed values. Set:

- `proof.verifier` to `setup-push-wif`;
- all four WIF proof steps to `true`;
- `verifiedAt` to the completed proof time in canonical UTC ISO 8601;
- `validUntil` to no more than 24 hours after `verifiedAt`;
- the Key Vault **URI and secret name only**, never its value or version
  payload.

Write no route label, command output, role policy, token response, or
credential into the handoff. Do not create or overwrite the file after a
partial/failed proof. Validate it before reporting success:

```bash
node "${PLUGIN_ROOT}/scripts/validate-sender-auth-contract.js" \
  --project-root "<working_dir>" \
  --file sender-auth.json \
  --expected-firebase-project "<firebase-project-id>"
```

Exit `2` requires correcting the non-secret handoff and rerunning validation.
Exit `1` is a file/input failure. Exit `0` is required. This validator proves
contract shape and freshness only; it does not replace the live read-backs or
the Entra -> STS -> impersonation -> FCM `validateOnly` proof.

## 7. Record and validate

Record only non-secret resource IDs, observed claim shape, normalized issuer,
audience, selected app claim, selected route, read-back compatibility result,
RBAC scopes, proof timestamp/result, handoff path/version, and credential expiry
in `memory-bank.md`. Explicitly state that no token or secret was persisted.

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
