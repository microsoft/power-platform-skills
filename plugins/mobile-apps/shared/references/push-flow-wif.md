# Keyless FCM authorization from Power Automate

Use Google Workload Identity Federation (WIF) so the cloud flow never stores a
Firebase service-account private key and never has to implement RS256.

This reference applies only when a freshly validated project-local
`sender-auth.json` selects mode `wif` for the same Firebase project as the
native client. A flow using mode `function-endpoint` must not include any action
from this sequence, even as a fallback; the Entra-protected Function owns
Google authentication and FCM in that mode.

## Identity setup, reuse, and repair

Run `/setup-push-wif`. It uses `az` for Entra/Key Vault and `gcloud` for Google
Cloud. It first inventories live resources, then explicitly selects
validate/reuse, approved repair, or approved new provisioning. Every route must
complete a fresh end-to-end token proof before writing `sender-auth.json` or
before flow authoring. Resource existence and old handoff proof are not proof
of current authorization.

1. Validate or create a dedicated Entra app registration/service principal for
   notification sending, with a dedicated application ID URI and time-bounded
   client credential.
2. For creation or approved rotation, capture the credential directly into a
   shell variable, write it immediately to Azure Key Vault, then unset it. Never
   print it or persist it in a file, flow definition, environment file, or
   memory bank.
3. Request an app-only access token and pipe it only on stdin to
   `${PLUGIN_ROOT}/scripts/inspect-entra-wif-jwt.js`. The local helper decodes
   without verifying/signing and emits only non-secret `iss`, `aud`, present
   `appid`/`azp`, `selectedAppClaim`, and `googleProviderIssuer`. Provider
   configuration is based on this output, not assumptions about the endpoint.
4. In Google Cloud, validate or create an OIDC workload identity provider with:
   - issuer: the normalized, observed `iss`;
   - allowed audience: the exact, observed `aud`;
   - `google.subject=assertion.sub`;
   - an app identity mapping and condition based on the claim actually present.
5. Grant the exact app-restricted principal set
   `roles/iam.workloadIdentityUser` on a dedicated sender service account.
6. Grant the sender account a custom project role containing only
   `cloudmessaging.messages.create`. Use
   `roles/firebasecloudmessaging.admin` only when custom roles are prohibited
   and the administrator explicitly accepts its broader scope.

### Claim-driven provider configuration

Do not assume that a v2 token endpoint guarantees a v2-shaped token or an
`azp` claim.

- A tested v1 app-only token can use
  `iss=https://sts.windows.net/<tenant-id>/` and `appid=<sender-client-id>`.
  Preserve that exact observed `iss`, but configure the Google provider with
  `https://sts.windows.net/<tenant-id>` (no trailing slash), as emitted in
  `googleProviderIssuer`. Map
  `attribute.appid=assertion.appid` and condition on that attribute.
- Use `attribute.azp=assertion.azp` only when `azp` is present in the observed
  token.
- Never rewrite `sts.windows.net` to `login.microsoftonline.com`, guess an
  audience from an app registration field, or fall back to tenant-only trust.
- If neither `appid` nor `azp` is present, stop and repair the token contract.

Read the provider back with `gcloud` and verify issuer, audience, mapping, and
condition before adding IAM bindings. For reuse, also read back the exact
app-restricted `roles/iam.workloadIdentityUser` principal-set binding, sender
service account, FCM project binding/custom-role permission set, Key Vault
secret reference, and the Power Automate Key Vault connection principal's
effective `Key Vault Secrets User` assignment. Missing or mismatched state
requires an explicit repair choice; it must not silently fall through to
provisioning.

Keep tenant ID, client ID, audience, project identifiers, pool/provider IDs, and
service-account email as non-secret environment variables. Keep the Entra
client credential only in Azure Key Vault. The active provisioning
administrator may need `Key Vault Secrets Officer` at the narrowest practical
vault scope to create/update the secret. Separately, the Power Automate Key
Vault connection's actual Entra principal—not merely the flow owner—needs
`Key Vault Secrets User` at the narrowest supported secret scope to read it.
Azure Contributor does not grant secret data-plane access. Treat `Forbidden`,
`ForbiddenByRbac`, and RBAC propagation failures as blockers; never work around
them by copying the secret into the flow.

## Required authorization proof

Before flow creation, use fresh values held only in shell variables to prove:

1. Entra client-credentials token issuance.
2. Google STS exchange using the provider's canonical audience.
3. Sender service-account impersonation with
   `https://www.googleapis.com/auth/firebase.messaging` and a 900-second
   lifetime.
4. FCM HTTP v1 authorization using a `validateOnly: true` request so no
   notification is delivered.

Provider creation alone is not proof. Report Entra `invalid_client`, STS
`invalid_grant`, IAM Credentials `403`, and FCM `403` separately so RBAC and
claim-contract failures remain actionable. Never log token responses or
authorization headers.

After all four stages succeed, write the versioned, non-secret WIF handoff
defined in `sender-auth-contract.md` from the live read-back values and latest
observed claims, then validate it with
`${PLUGIN_ROOT}/scripts/validate-sender-auth-contract.js`. A failed or partial
proof must not create or overwrite the handoff.

## Flow HTTP sequence

Populate the sequence from the validated handoff's exact WIF resource
identifiers and observed claim shape. Do not rediscover a second sender,
translate a Function handoff into WIF, or continue when the handoff proof is
expired or project-mismatched.

### 1. Entra client-credentials token

```http
POST https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

client_id={client-id}
&client_secret={secret}
&scope={url-encoded-application-id-uri}/.default
&grant_type=client_credentials
```

Use the returned `access_token` only as the WIF subject token.

### 2. Google STS exchange

```http
POST https://sts.googleapis.com/v1/token
Content-Type: application/json
```

```json
{
  "audience": "//iam.googleapis.com/projects/{project-number}/locations/global/workloadIdentityPools/{pool-id}/providers/{provider-id}",
  "grantType": "urn:ietf:params:oauth:grant-type:token-exchange",
  "requestedTokenType": "urn:ietf:params:oauth:token-type:access_token",
  "scope": "https://www.googleapis.com/auth/cloud-platform",
  "subjectToken": "{entra-access-token}",
  "subjectTokenType": "urn:ietf:params:oauth:token-type:jwt"
}
```

### 3. Sender service-account impersonation

```http
POST https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{sender-service-account}:generateAccessToken
Authorization: Bearer {sts-access-token}
Content-Type: application/json
```

```json
{
  "scope": [
    "https://www.googleapis.com/auth/firebase.messaging"
  ],
  "lifetime": "900s"
}
```

### 4. FCM HTTP v1 send

```http
POST https://fcm.googleapis.com/v1/projects/{firebase-project-id}/messages:send
Authorization: Bearer {impersonated-access-token}
Content-Type: application/json
```

Use `message.topic`, never a condition assembled from untrusted text.

## Security requirements

- Mark inputs/outputs secure on the secret retrieval and all three token actions.
- Never log token bodies or copy them into outbox error text.
- Validate every configurable resource ID against an administrator-approved
  environment variable before composing URLs.
- Restrict the Google provider by audience and app identity. Tenant-only trust
  is too broad.
- Use a dedicated sender service account and short token lifetime.
- Grant `roles/iam.workloadIdentityUser` only to the exact app-restricted
  principal set; never grant it to the whole pool.
- Do not grant Owner, Editor, Service Account Token Creator, or create a Google
  service-account key.
- Retry transient `429` and `5xx` responses with bounded exponential backoff;
  do not retry validation or authorization failures indefinitely.

References:

- https://cloud.google.com/iam/docs/workload-identity-federation-with-other-providers
- https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines
- https://cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token
- https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken
- https://firebase.google.com/docs/cloud-messaging/auth-server
- https://learn.microsoft.com/entra/identity-platform/access-token-claims-reference
- https://learn.microsoft.com/azure/key-vault/general/rbac-guide
