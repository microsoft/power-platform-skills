# Push notification outbox

Create this Dataverse table through `/add-dataverse`; do not hand-edit generated
services.

## Table

Display name: `Push Notification`

| Column | Type | Required | Notes |
| --- | --- | --- | --- |
| Name | Text | yes | Human-readable summary |
| Audience | Choice | yes | `User`, `AllUsers` |
| Target OID | Text (100) | conditional | GUID for `User`; empty for `AllUsers` |
| Title | Text (200) | yes | Notification title |
| Body | Multiline text (2000) | yes | No confidential data |
| Deep Link | Text (1000) | no | Validated internal route or app scheme |
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

Validate:

- `User` requires a GUID Target OID.
- `AllUsers` requires an empty Target OID.
- Title and Body are non-empty and within FCM payload limits.
- Deep Link follows the push payload contract.

For `User`, the flow lowercases the validated Target OID before assigning
`message.topic`, matching the client subscription canonicalization.
