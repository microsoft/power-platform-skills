# Push notification outbox

Create this Dataverse table through `/add-dataverse`; do not hand-edit generated
services.

## Sender prerequisite

Before creating or publishing the sender flow, run `/setup-push-wif` and require
its complete proof: dedicated Entra sender app, client secret stored only in
Azure Key Vault, claim-driven Google provider configuration, app-restricted
service-account impersonation, and a successful FCM `validateOnly` call.
Provider existence alone is not sufficient.

The flow's Azure Key Vault connection principal must have `Key Vault Secrets
User` at the narrowest supported scope. Contributor on the subscription,
resource group, or vault management plane does not grant secret read access.
RBAC/`Forbidden` failures block sender setup; never copy the secret into the
flow or an outbox row.

## Table

Display name: `Push Notification`

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| Name | Text | yes | Human-readable summary |
| Audience | Choice | yes | `User`, `AllUsers` |
| Target OID | Text (100) | conditional | GUID for `User`; empty for `AllUsers` |
| Title | Text (200) | yes | Notification title |
| Body | Multiline text (2000) | yes | No confidential data |
| Destination | Text (64) | yes | Allowlisted semantic destination ID |
| Navigation Parameters | Multiline text (4096) | yes | Canonical JSON object of destination-specific string fields |
| Payload Version | Text (20) | yes | Default `1` |
| Status | Choice | yes | `Draft`, `Queued`, `Sending`, `Sent`, `Failed` |
| Attempt Count | Whole number | yes | Default 0 |
| Provider Message ID | Text (500) | no | FCM response name |
| Error Code | Text (200) | no | Bounded diagnostic code |
| Error Message | Multiline text (2000) | no | Sanitized; no credentials/tokens |
| Sent On | Date and time | no | UTC |

## Flow idempotency

Trigger only when Status enters `Queued`. The flow first changes Status to
`Sending` and increments Attempt Count. Its own updates must not retrigger a
send. A successful FCM response sets `Sent`, Provider Message ID, and Sent On.
Any terminal error sets `Failed` and bounded diagnostic fields.

Authentication failures must remain bounded and actionable. Store only a
category such as `ENTRA_INVALID_CLIENT`, `WIF_INVALID_GRANT`,
`WIF_IMPERSONATION_FORBIDDEN`, `FCM_FORBIDDEN`, or `FCM_TRANSIENT`; never store
client secrets, JWTs, access tokens, authorization headers, or complete HTTP
response bodies.

Validate:

- `User` requires a GUID Target OID.
- `AllUsers` requires an empty Target OID.
- Title and Body are non-empty and within FCM payload limits.
- Destination and Navigation Parameters follow
  `navigation-link-contract.md`; unknown/additional fields are rejected.
- Legacy `deepLink` rows are not sent. Migrate or fail them before releasing a
  client with the semantic contract.

For `User`, the flow lowercases the validated Target OID before assigning
`message.topic`, matching the client subscription canonicalization.
