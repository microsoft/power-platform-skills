# Keyless FCM authorization from Power Automate

Use Google Workload Identity Federation (WIF) so the cloud flow never stores a
Firebase service-account private key and never has to implement RS256.

## One-time identity setup

1. Create a dedicated Entra app registration for notification sending.
2. Expose an application ID URI and create a client credential.
3. In Google Cloud, create an OIDC workload identity provider:
   - issuer: the Entra tenant's v2 issuer
   - allowed audience: the dedicated Entra application ID URI
   - map `google.subject` to a stable service-principal claim
   - add an attribute condition that permits only the dedicated app/client ID
4. Grant that federated principal `roles/iam.workloadIdentityUser` on a
   dedicated sender service account.
5. Grant the sender account only the Firebase Messaging send permission needed
   for the target Firebase project.

Keep tenant ID, client ID, audience, project identifiers, pool/provider IDs, and
service-account email as non-secret environment variables. Keep the Entra
client credential in Azure Key Vault or a secret environment variable.

## Flow HTTP sequence

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
- Retry transient `429` and `5xx` responses with bounded exponential backoff;
  do not retry validation or authorization failures indefinitely.

References:

- https://cloud.google.com/iam/docs/workload-identity-federation-with-other-providers
- https://cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token
- https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken
- https://firebase.google.com/docs/cloud-messaging/auth-server

