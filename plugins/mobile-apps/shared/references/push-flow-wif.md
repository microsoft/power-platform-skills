# Keyless FCM runtime protocol for Power Automate

This reference is canonical only for the **runtime flow action sequence** used
when a fresh project-local `sender-auth.json` selects mode `wif` for the same
Firebase project as the native client. Provisioning, reuse, repair, IAM/RBAC,
live proof, and handoff creation belong to
`push-wif-provisioning.md` and `/setup-push-wif`.

A `function-endpoint` flow must not contain any action from this sequence, even
as a fallback. Its validated Entra-protected Function owns Google
authentication and FCM.

## Provisioning ownership boundary

The provisioning owner prefers pinned `@google-cloud/gcloud-mcp@0.5.3` and
uses `@azure/mcp@2.0.5`. Google administration uses
`mcp__gcloud__run_gcloud_command`, or the provisioning reference's guarded
official CLI fallback when MCP recovery fails.
Azure covered reads use
`mcp__azure__subscription`, `mcp__azure__group`, and `mcp__azure__role`.
Call the namespace tool with routed command/parameters; use
`role_assignment_list` for RBAC inventory.

The plugin does not expose its `keyvault` namespace because GA 2.0.5 has
value-carrying secret operations and no safe metadata-only route. Runtime flow
authoring must not invoke `keyvault_secret_get` or
`keyvault_secret_create`; it uses the discovered Power Automate Key Vault
connector action. See `push-wif-provisioning.md` for all resource work.

## Validated handoff gate

Before discovery or authoring:

1. Validate `sender-auth.json` with
   `validate-sender-auth-contract.js --expected-firebase-project`.
2. Require version `1`, mode `wif`, verifier `setup-push-wif`, a current proof,
   and all four proof steps true.
3. Derive tenant/client/application-ID URI, Key Vault URI/secret name, project
   number, pool/provider IDs, sender service-account email, Firebase project,
   audience, issuer, and selected `appid`/`azp` claim only from the validated
   handoff.
4. Never rediscover or substitute another sender, translate another auth mode,
   or author from a stale/project-mismatched contract.

## Runtime HTTP sequence

Retrieve the Entra client credential through the exact discovered Azure Key
Vault connection whose principal was proven during setup. The secret value may
exist only in secure action outputs and downstream secure inputs.

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

The audience and observed claim contract must come from the handoff. Do not
weaken or reinterpret `appid`/`azp` conditions in the flow.

### 3. Sender service-account impersonation

```http
POST https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{sender-service-account}:generateAccessToken
Authorization: ******
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
Authorization: ******
Content-Type: application/json
```

Use `message.topic`, never a condition assembled from untrusted text. `User`
delivery requires a GUID-validated lowercase Entra OID topic. `AllUsers`
requires an empty Target OID and exact case-sensitive `allUsers`.

Send only approved generic notification title/body plus string-valued
`data.schemaVersion` and allowlisted internal `data.deepLink`, together with
the discovered Android/APNs fields. OID topics are routing convenience, not an
authorization boundary.

## Action security and failure handling

- Mark secure inputs/outputs on secret retrieval, Entra token, STS exchange,
  service-account impersonation, and authorized FCM actions.
- Never copy token responses, authorization headers, secret values, raw
  connector errors, response bodies, or outbox payloads into diagnostics.
- Validate every configurable resource ID against the handoff before composing
  URLs.
- Keep the sender account dedicated and token lifetime short. Never embed a
  Google service-account key or implement RS256 in flow expressions.
- Retry only transient `429`/`5xx` responses with bounded exponential backoff;
  do not retry authentication, authorization, or validation errors
  indefinitely.
- On success retain only the bounded provider message ID. On failure retain
  only bounded sanitized code/message.

The authoring workflow must read the persisted flow back and prove this exact
Key Vault -> Entra -> STS -> impersonation -> FCM action tree, secure settings,
and mode-specific connections. Any Function branch, generic fallback,
service-account JSON, or mixed-mode path is a blocker.

References:

- https://cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token
- https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken
- https://firebase.google.com/docs/cloud-messaging/auth-server
