# DevPlayer Builder Integration

Use this reference when a mobile skill is invoked with `--devplayer-mode`, `--callback-url`, and `--callback-token`.

## Arguments

| Argument | Meaning |
|---|---|
| `--devplayer-mode` | Enable structured callbacks for the DevPlayer local builder bridge. |
| `--callback-url <url>` | Base job URL, for example `http://127.0.0.1:5177/jobs/<jobId>`. |
| `--callback-token <token>` | Sent only as the `x-builder-token` header. Never print it. |
| `--job-id <id>` | Optional trace label when the URL already contains the job id. |
| `--progressive-preview` | Start Metro as soon as the prototype shell is valid and send `/preview`. |
| `--no-plan-mode` | Do not use Copilot Plan Mode approval gates; use bridge approvals instead. |

`--callback-url` must be the job base URL. Append endpoint paths to it:

- Events: `<callback-url>/events`
- Approval: `<callback-url>/approval`
- Approval poll: `<callback-url>/approval`
- Preview: `<callback-url>/preview`
- Ready: `<callback-url>/ready`
- Failed: `<callback-url>/failed`

## Security Rules

- Send `--callback-token` only in the `x-builder-token` header.
- Never include secrets, tokens, full local paths, user prompts, raw errors, record payloads, tenant IDs, connection IDs, or credentials in event messages.
- Event `detail` may include high-level counts and screen names only.
- If a callback fails, continue the Copilot flow unless the bridge approval endpoint is required for the current gate.

## Structured Event Payload

```json
{
  "kind": "plan | step | screen | approval | preview",
  "level": "info | success | warning | error",
  "state": "pending | running | completed | blocked | failed",
  "itemId": "screen-feed",
  "title": "Generating Feed screen",
  "message": "Generating Feed screen",
  "detail": "Uses InspectionService and PhotoService",
  "count": 4
}
```

## Approval Payload

```json
{
  "title": "Approve generated app plan",
  "summary": "Data model: 4 entities. Screens: Home, Feed, Detail, Profile.",
  "items": [
    "Aircraft and inspection tables",
    "Home, Feed, Detail, Profile screens",
    "Camera/photo capture capability"
  ]
}
```

Approval flow:

1. `POST <callback-url>/approval` with the payload above.
2. Poll `GET <callback-url>/approval` every few seconds until the response has an approved or rejected status.
3. Continue only on approved.
4. On rejected, stop with `BLOCKED` and send `/failed` with a concise reason.

## Preview / Ready / Failed

Preview payload:

```json
{ "metroUrl": "http://<desktop-lan-ip>:<metro-port>" }
```

Ready payload:

```json
{ "metroUrl": "http://<desktop-lan-ip>:<metro-port>", "message": "Prototype ready" }
```

Failed payload:

```json
{ "error": "Screen wave gate failed: Feed screen has route type errors" }
```

## Shell Helper Examples

```bash
post_event() {
  curl -sS -X POST "$DEVPLAYER_CALLBACK_URL/events" \
    -H "content-type: application/json" \
    -H "x-builder-token: $DEVPLAYER_CALLBACK_TOKEN" \
    -d "$1" >/dev/null || true
}
```

```bash
request_approval() {
  curl -sS -X POST "$DEVPLAYER_CALLBACK_URL/approval" \
    -H "content-type: application/json" \
    -H "x-builder-token: $DEVPLAYER_CALLBACK_TOKEN" \
    -d "$1" >/dev/null
}
```

```bash
post_failed() {
  curl -sS -X POST "$DEVPLAYER_CALLBACK_URL/failed" \
    -H "content-type: application/json" \
    -H "x-builder-token: $DEVPLAYER_CALLBACK_TOKEN" \
    -d "{\"error\":\"$1\"}" >/dev/null || true
}
```

Prefer Node or JSON-safe shell construction for dynamic payloads. Do not hand-concatenate untrusted strings into JSON.