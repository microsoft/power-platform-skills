# Push notification outbox

Create this Dataverse table through `/add-dataverse`; do not hand-edit generated
services.

## Sender prerequisite

Before creating the sender flow, let the user choose either:

- `/setup-push-wif` with its complete proof; or
- stopped Power Automate producer/sender flows whose FCM authentication the
  customer will configure manually.

Never copy credentials into the outbox.

## Table

Display name: `Push Notification`

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| Name | Text | yes | Human-readable summary |
| Audience | Choice | yes | `User`, `AllUsers` |
| Target OID | Text (100) | conditional | GUID for `User`; empty for `AllUsers` |
| Title | Text (200) | yes | User-approved notification title |
| Body | Multiline text (2000) | yes | User-approved notification body |
| Additional Data | Multiline text (4096) | no | Canonical JSON object of additional user-approved string fields; reserved navigation keys are forbidden |
| Destination | Text (64) | no | Optional allowlisted semantic destination ID |
| Navigation Parameters | Multiline text (4096) | no | Required only when Destination is set; canonical JSON object of destination-specific string fields |
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
- Additional Data is a flat JSON object with string keys and values. Reject
  reserved keys `schemaVersion`, `destination`, `params`, and `deepLink`.
- Destination and Navigation Parameters follow
  `navigation-link-contract.md` when navigation is selected. Both are absent
  when the user chooses no deep link.
- Legacy `deepLink` rows are not sent. Migrate or fail them before releasing a
  client with the semantic contract.

Before accepting title, body, Additional Data, or navigation parameters,
explain that notification text may be visible on a lock screen and that FCM
topic membership is not an authorization boundary. Recommend minimizing
personal, confidential, or regulated data, but do not reject business content
solely on privacy grounds after the user explicitly chooses it. Credentials,
tokens, private keys, authentication headers, and secret values remain
prohibited.

For `User`, the flow lowercases the validated Target OID before assigning
`message.topic`, matching the client subscription canonicalization.
