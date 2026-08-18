# Azure Function endpoint security and proof

Use this reference for both existing-endpoint validation and confirmed
deployment. Azure CLI syntax can change; query Microsoft Learn before mutation
when the installed CLI does not expose the documented authsettingsV2 fields.

## Runtime contract

The bundled Node.js Azure Function accepts only this strict JSON shape:

```json
{
  "topic": "allUsers",
  "title": "You have a new notification.",
  "body": "Open the app to view it.",
  "schemaVersion": "1",
  "deepLink": "/notifications",
  "validateOnly": true
}
```

- Topic is exact `allUsers` or a lowercase Entra OID GUID.
- Title/body must exactly match configured generic allowlists.
- Schema version is exact string `"1"`.
- Deep link must match an configured internal prefix and must not contain an
  HTTP(S)/JavaScript scheme, traversal, query, fragment, backslash, control
  character, or encoded path separator/dot.
- Unknown/missing fields are rejected.
- `validateOnly` is a required Boolean. Setup proof requires `true`.

The FCM request uses `message.topic`, a notification title/body, string-only
`data.schemaVersion`/`data.deepLink`, and top-level `validate_only`.

## App settings

Store only non-secret policy and references:

| Setting | Value |
| --- | --- |
| `KEY_VAULT_URL` | `https://<vault>.vault.azure.net/` |
| `FIREBASE_SERVICE_ACCOUNT_SECRET_NAME` | One Key Vault secret name |
| `FIREBASE_PROJECT_ID` | Exact target Firebase project |
| `ALLOWED_DEEP_LINK_PREFIXES` | JSON string array, for example `["/(app)/","/notifications"]` |
| `ALLOWED_NOTIFICATION_TITLES` | JSON string array of generic titles |
| `ALLOWED_NOTIFICATION_BODIES` | JSON string array of generic bodies |

Never place service-account JSON, private keys, tokens, auth headers, client
secrets, Key Vault secret values, or credential-bearing URLs in app settings.

## Entra endpoint protection

Require Azure App Service authentication (authsettingsV2):

- `platform.enabled = true`;
- `globalValidation.requireAuthentication = true`;
- `globalValidation.unauthenticatedClientAction = "Return401"`;
- Microsoft Entra issuer identifies the exact tenant;
- allowed audiences contain only the endpoint's application ID URI/audience;
- default authorization policy `allowedApplications` contains only the exact
  Power Automate connection caller application ID.

Read the live configuration back after every mutation. A 401-only test proves
authentication is enabled, not that the intended flow principal is authorized;
the final `validateOnly` call must use that actual identity.

References:

- https://learn.microsoft.com/azure/app-service/configure-authentication-provider-aad
- https://learn.microsoft.com/azure/app-service/configure-authentication-provider-aad#configure-client-apps-to-access-your-app-service
- https://learn.microsoft.com/azure/app-service/configure-authentication-api-version

## Least privilege

- Function identity: `Key Vault Secrets User` scoped to the one secret when
  Azure supports that scope; otherwise vault scope, reported as wider.
- Flow invoke identity: authorization to invoke this endpoint only. It gets no
  Key Vault, Function management, subscription, or Firebase role.
- Provisioning operator: temporary deployment/configuration rights only; remove
  temporary secret-writer access after upload.
- Firebase service account: a custom Google role containing only
  `cloudmessaging.messages.create` on the intended project. If policy prevents a
  custom role, require explicit approval before the broader
  `roles/firebasecloudmessaging.admin`; never grant Owner/Editor.

Key Vault RBAC reference:
https://learn.microsoft.com/azure/key-vault/general/rbac-guide

FCM permission reference:
https://firebase.google.com/docs/cloud-messaging/auth-server

## Existing endpoint read-back checklist

1. `az functionapp show`: exact resource ID, HTTPS-only, identity principal.
2. `az functionapp auth show`: authsettingsV2 fields above.
3. `az functionapp config appsettings list`: inspect names and non-secret policy;
   stop if any credential value is present. Do not print all settings in shared
   logs.
4. `az role assignment list --assignee <function-principal>`: exact Key Vault
   role/scope and no unnecessary broad roles.
5. Key Vault secret metadata query: ID and enabled state only, never value.
6. Google IAM policy read-back: exact project, service account, and send role.
7. Unauthenticated endpoint request: exact 401.
8. Intended flow identity `validateOnly` request: accepted with a bounded safe
   provider message ID/result.
9. Negative validation probes: safe 400 responses before Google/FCM calls.

## Retry and error policy

The scaffold retries only HTTP 429, 500, 502, 503, and 504, at most three total
attempts with bounded backoff. Validation, authentication, authorization, and
other 4xx failures are not retried.

Responses expose only stable categories such as:

- `INVALID_REQUEST`
- `ENTRA_AUTH_REQUIRED` (normally emitted by App Service before the Function)
- `KEY_VAULT_UNAVAILABLE`
- `KEY_VAULT_CONFIGURATION_INVALID`
- `FIREBASE_CREDENTIAL_INVALID`
- `GOOGLE_AUTH_FAILED`
- `FCM_FORBIDDEN`
- `FCM_TRANSIENT`
- `FCM_INVALID_REQUEST`
- `INTERNAL_ERROR`

Never include raw exception messages, Google response bodies, secret values,
private keys, tokens, authorization headers, or stack traces.
