# FCM sender Azure Function

This scaffold is owned by the `setup-push-service-account` mobile-app skill.
Follow that skill for Azure provisioning, Entra authsettingsV2, least-privilege
RBAC, non-echoing upload of an existing Firebase service-account JSON, and the
required `validateOnly` proof.

## Local verification

```bash
npm install
npm test
```

Tests are offline and inject every cloud dependency. Do not add a Firebase
credential or access token to local settings, fixtures, tests, or source.

## Security boundary

- App Service Easy Auth authenticates and authorizes the exact Power Automate
  invoke application before the request reaches this Function.
- The Function's managed identity can read only the named Key Vault secret.
- The service-account JSON exists only in Key Vault and Function process memory.
- Google OAuth access tokens are short-lived and never logged or returned.
- FCM retries are bounded and endpoint errors contain stable categories only.

`local.settings.json.example` contains non-secret policy placeholders.
`local.settings.json` is ignored and must never contain the Firebase JSON.
