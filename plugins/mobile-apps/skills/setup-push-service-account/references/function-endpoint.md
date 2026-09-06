# Azure Function endpoint security and proof

Use this reference for both existing-endpoint validation and confirmed
deployment. Azure CLI syntax can change; query Microsoft Learn before mutation
when the installed CLI does not expose the documented authsettingsV2 fields.

## Official Azure MCP coverage and narrow `az` fallbacks

Target `@azure/mcp@2.0.5` here. Do not reinterpret this reference through
Azure MCP 3.x beta behavior.

Use Azure MCP GA `2.0.5` namespace tools where the docs/source actually expose
them:

- `mcp__azure__subscription` and `mcp__azure__group` for subscription/resource
  group inventory when needed
- `mcp__azure__functionapp` with `functionapp_get`
- `mcp__azure__appservice` with the documented
  `appservice_webapp_get`, `appservice_webapp_deployment_get`,
  `appservice_webapp_settings_get-appsettings`,
  `appservice_webapp_settings_update-appsettings`, and diagnostics surfaces
- `mcp__azure__role` with `role_assignment_list`

Keep `az` only for the sender-auth-safe gaps that Azure MCP GA `2.0.5`
docs/source do not cover or would expose unsafely:

- exact Function/App Service resource IDs and identity principal IDs;
- authsettingsV2 read/write;
- managed-identity enablement;
- Function creation/deployment and other unsupported mutation edges;
- Key Vault metadata-only reads that avoid secret values;
- the non-echoing `az keyvault secret set --file ...` upload;
- Entra app/service-principal/credential work.

Do not use `keyvault_secret_get` or `keyvault_secret_create` in
this workflow because Azure MCP GA `2.0.5` docs/source define them as
secret-value operations, and GA `2.0.5` does not expose a safe
metadata-only Key Vault namespace route for this workflow.
Do not silently replace covered Azure MCP reads/settings with `az`, and do not
invent nonexistent tool names such as `mcp__azure__azmcp_functionapp_get` or
`functionapp_list`.

## Runtime contract

The bundled Node.js Azure Function accepts only this strict JSON shape:

```json
{
  "topic": "allUsers",
  "title": "You have a new notification.",
  "body": "Open the app to view it.",
  "schemaVersion": "1",
  "destination": "notifications",
  "params": "{}",
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
`data.schemaVersion`/`data.destination`/`data.params`, and top-level
`validate_only`. The endpoint rejects the former `deepLink` shape.

## App settings

Store only non-secret policy and references:

| Setting | Value |
| --- | --- |
| `KEY_VAULT_URL` | `https://<vault>.vault.azure.net/` |
| `FIREBASE_SERVICE_ACCOUNT_SECRET_NAME` | One Key Vault secret name |
| `FIREBASE_PROJECT_ID` | Exact target Firebase project |
| `ALLOWED_NAVIGATION_DESTINATIONS` | JSON object mapping semantic destinations to exact parameter rules, for example `{"notifications":{},"work-item-detail":{"workItemId":{"type":"guid","required":true}}}` |
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

1. `mcp__azure__functionapp` with `functionapp_get`: exact app name, resource
   group, hostname, status, and app-service-plan association of the intended
   Function.
2. `az functionapp show`: exact resource ID and identity principal ID because
   Azure MCP GA `2.0.5` function-app docs/source do not return them.
3. `az functionapp auth show`: authsettingsV2 fields above.
4. `mcp__azure__appservice` with
   `appservice_webapp_get`, `appservice_webapp_deployment_get`, and
   `appservice_webapp_settings_get-appsettings` as needed to inspect the
   endpoint, deployment/readiness, and non-secret policy. Stop if any
   credential value is present. Do not print all settings in shared logs.
5. `mcp__azure__role` with `role_assignment_list`: exact Key Vault role/scope
   at the relevant vault or secret scope; verify no unnecessary broad roles.
6. Key Vault secret metadata query with `az`: ID and enabled state only, never
   value. Do not use `keyvault_secret_get`.
7. Google IAM policy read-back: exact project, service account, and send role.
8. Unauthenticated endpoint request: exact 401.
9. Intended flow identity `validateOnly` request: accepted with a bounded safe
   provider message ID/result.
10. Negative validation probes: safe 400 responses before Google/FCM calls.

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
