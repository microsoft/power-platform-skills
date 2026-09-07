# Sender authentication handoff contract

Sender-auth setup workflows write `sender-auth.json` in the app project root.
`/create-push-notification-flow` and future setup skills consume this file only
after running:

```bash
node "${PLUGIN_ROOT}/scripts/validate-sender-auth-contract.js" \
  --project-root . \
  --file sender-auth.json \
  --expected-firebase-project "$FIREBASE_PROJECT_ID"
```

The handoff is **non-secret**. It contains stable resource identifiers and a
short-lived authorization proof, not credentials. Record only its project-local
path, mode, Firebase project ID, and safe resource identifiers in
`memory-bank.md`.

This strict contract covers only the plugin-managed `wif` mode. A customer who
chooses manual FCM authentication configures that authentication in the
plugin-created Power Automate sender independently. Do not create a manual
mode or credential-bearing escape hatch in `sender-auth.json`; report it as
customer-owned and not plugin-validated instead. See
[push-sender-auth-options.md](./push-sender-auth-options.md).

## Common envelope (version 1)

```json
{
  "version": 1,
  "mode": "wif",
  "firebaseProjectId": "contoso-mobile-prod",
  "proof": {
    "firebaseProjectId": "contoso-mobile-prod",
    "verifiedAt": "2026-08-18T08:00:00.000Z",
    "validUntil": "2026-08-19T08:00:00.000Z",
    "verifier": "setup-push-wif",
    "steps": {}
  }
}
```

Proof timestamps use canonical UTC ISO 8601. The validity window is at most 24
hours. Consumers reject expired proofs and proofs more than 24 hours old;
resource existence alone is not authorization proof. `proof.firebaseProjectId`
binds the proof to the same Firebase project as the envelope. The verifier is mode-bound: `wif` requires `setup-push-wif`.

The validator rejects unknown versions, modes, and fields. It also rejects
private keys, service-account JSON, secret values, passwords, credentials,
authorization headers, access/refresh/ID tokens, bearer tokens, raw JWTs, and
URLs with embedded credentials anywhere in the document.

## `wif` mode

```json
{
  "version": 1,
  "mode": "wif",
  "firebaseProjectId": "contoso-mobile-prod",
  "wif": {
    "googleProjectNumber": "123456789012",
    "workloadIdentityPoolId": "power-automate-push",
    "workloadIdentityProviderId": "entra-push",
    "serviceAccountEmail": "fcm-sender@contoso-mobile-prod.iam.gserviceaccount.com",
    "entra": {
      "tenantId": "11111111-2222-3333-4444-555555555555",
      "clientId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "audience": "api://contoso-push-sender"
    },
    "keyVaultSecretReference": {
      "vaultUri": "https://contoso-push.vault.azure.net/",
      "secretName": "entra-push-sender-client-secret"
    },
    "observedClaimShape": {
      "issuer": "https://sts.windows.net/11111111-2222-3333-4444-555555555555/",
      "googleProviderIssuer": "https://sts.windows.net/11111111-2222-3333-4444-555555555555",
      "audience": "api://contoso-push-sender",
      "appIdentityClaim": "appid",
      "appIdentityValue": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    }
  },
  "proof": {
    "firebaseProjectId": "contoso-mobile-prod",
    "verifiedAt": "2026-08-18T08:00:00.000Z",
    "validUntil": "2026-08-19T08:00:00.000Z",
    "verifier": "setup-push-wif",
    "steps": {
      "entraTokenIssued": true,
      "googleStsExchanged": true,
      "serviceAccountImpersonated": true,
      "fcmValidateOnly": true
    }
  }
}
```

The observed audience must equal the configured Entra audience, and the
observed `appid`/`azp` value must equal the Entra client ID. The Key Vault entry
is a reference only; never add a secret value or version payload.

`setup-push-wif` may write this handoff after compatible-resource reuse,
approved repair, or approved new provisioning. In all three cases it must first
read back the live provider, IAM/RBAC, sender account, FCM permission, and Key
Vault reference, observe a fresh Entra claim shape, and complete a new Entra ->
STS -> impersonation -> FCM `validateOnly` proof. Reusing names or finding that
resources exist does not satisfy the proof requirement.

## CLI result and exit codes

- Exit `0`: `{ "status": "valid", ... }`
- Exit `2`: parsed contract is invalid and `issues` describes safe field-level
  failures.
- Exit `1`: the CLI input, path, file, or JSON could not be safely processed.

The contract path must remain under the supplied project root and must be a
regular file, not a symbolic link.
