# Navigation link contract

This is the canonical navigation contract for generated mobile apps. In-app
actions, custom-scheme links, HTTPS App Links/Universal Links, and push
notification responses all produce the same semantic intent. Expo Router is
the only navigation executor.

## Version 1

The wire contract contains strings only:

```json
{
  "schemaVersion": "1",
  "destination": "work-item-detail",
  "params": "{\"workItemId\":\"00000000-0000-0000-0000-000000000000\"}"
}
```

`params` is a canonical JSON object whose keys and values are strings. Sort keys
lexicographically before serialization. Do not allow arrays, nested objects,
numbers, booleans, `null`, or duplicate JSON keys.

This contract deliberately replaces the earlier version-1
`{ "schemaVersion": "1", "deepLink": "/route" }` shape. There is no legacy
reader: a payload containing `deepLink` is invalid. Existing queued rows and
producer/sender flows must be migrated before a client using this contract is
released.

## Destination registry

Create `src/navigation/linkContract.ts`. It owns:

- `NavigationIntentV1` and discriminated parse/dispatch result types;
- a closed `NavigationDestination` union;
- one registry entry per externally or notification-addressable screen;
- parameter validation and conversion;
- the only mapping from semantic destinations to Expo Router `Href` values;
- parsers for FCM data, custom-scheme URLs, and approved HTTPS URLs; and
- a typed in-app `navigateTo(intent)` entry point.

Each registry entry defines:

| Field | Meaning |
| --- | --- |
| `destination` | Stable kebab-case public ID, independent of route filenames |
| `params` | Exact keys, required/optional status, and type/format |
| `requiresAuth` | Whether one validated intent may be retained through login |
| `intent` | Expo Router `navigate`, `push`, or `replace` behavior |
| `toHref` | Pure mapping from validated typed params to one Expo Router href |

Example:

```ts
const destinations = {
  'work-item-detail': {
    requiresAuth: true,
    intent: 'push',
    parseParams: parseWorkItemDetailParams,
    toHref: ({ workItemId }) => ({
      pathname: '/(app)/work-items/[id]',
      params: { id: workItemId },
    }),
  },
} as const;
```

Do not expose Expo Router paths, route groups, or filenames as destination IDs.
A screen rename changes `toHref`, not links or Power Automate flows.

## Bounds and validation

Apply all checks before resolving an href:

- exact `schemaVersion === "1"`;
- destination matches `^[a-z][a-z0-9-]{0,63}$` and exists in the registry;
- at most 16 parameters;
- parameter keys match `^[A-Za-z][A-Za-z0-9]{0,63}$`;
- each parameter value is at most 500 UTF-8 bytes;
- serialized `params` is at most 4096 UTF-8 bytes;
- the complete decoded URL is at most 8192 UTF-8 bytes;
- exact destination-specific parameter keys, required fields, and formats;
- no control characters, backslashes, traversal segments, encoded path
  separators/dots, fragments, credentials, or duplicate query keys; and
- exact configured custom scheme or exact approved HTTPS origin.

Destination schemas explicitly parse supported values such as GUIDs, enums,
dates, and bounded integers. They never coerce unknown values or drop
additional keys.

Return non-throwing failures such as `unsupported-version`,
`unknown-destination`, `invalid-params`, `unapproved-origin`, and
`malformed-link`. Invalid, stale, or unknown intents do not navigate and do not
fall back to another screen.

## Source adapters

All adapters return `NavigationIntentV1`; none returns an href.

### In-app

Screen code calls the typed helper:

```ts
navigateTo({
  schemaVersion: '1',
  destination: 'work-item-detail',
  params: { workItemId },
});
```

Do not hand-build a route for a registered semantic destination.

### Custom scheme

Use the app's exact evaluated scheme:

```text
contoso-mobile://navigate/work-item-detail?workItemId=<guid>
```

Only the `navigate` host/path contract is accepted. Reject every other scheme.

### HTTPS App Link / Universal Link

Use an explicitly configured origin:

```text
https://mobile.contoso.com/navigate/work-item-detail?workItemId=<guid>
```

Parsing support is not proof that the OS opens the app. Android additionally
requires an exact `intentFilters` entry and hosted `/.well-known/assetlinks.json`.
iOS additionally requires `associatedDomains` and hosted
`/.well-known/apple-app-site-association`. The customer owns the domain and
association files. Track parser configured, native config present, association
confirmed, and physical installed-build verification separately.

### Push notifications

FCM `message.data` uses the three string fields shown above. Foreground and
background handlers may validate data, but only a user notification response
may dispatch navigation. Warm and cold responses share one parser and one
deduplication/pending-intent guard.

## Authentication and exactly-once behavior

Dispatch only after Expo Router is ready. If a validated destination requires
authentication and the user is signed out, retain exactly one pending intent,
route to login, and resume it once after auth readiness. Never retain an
invalid intent.

Deduplicate external events by a bounded event identity: notification response
identifier/message ID when available, otherwise a short-lived fingerprint of
the canonical intent plus source. This guard applies to warm/cold notification
responses and initial/live URL delivery. A later deliberate in-app call is a
new event and is not globally suppressed.

Background FCM handling never navigates.

## Power Automate contract

Flow makers provide an allowlisted destination and destination-specific safe
fields. The producer validates those fields and constructs canonical `params`
JSON. It never accepts an arbitrary route, URL, href, or complete navigation
contract JSON.

The outbox stores:

- Payload Version (`"1"`);
- Destination; and
- Navigation Parameters (canonical JSON object of string values).

The sender revalidates all three fields against the same destination allowlist
before sending them as `schemaVersion`, `destination`, and `params`. WIF,
Function, and customer-owned Power Automate sender paths must use the same
observable contract and must not retain a `deepLink` fallback.

Navigation parameters remain privacy-safe and non-confidential. Topic
membership is routing convenience, not authorization.
