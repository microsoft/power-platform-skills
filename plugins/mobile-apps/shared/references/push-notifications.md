# Push notification contract

Use this reference from `/add-push-notifications`, `/setup-fcm`, `/setup-apns`,
the planner, and screen builders.

## Native ownership

- `@react-native-firebase/messaging` owns FCM registration tokens, token refresh,
  topic subscription, and foreground/background transport on Android and iOS.
- `expo-notifications` owns permission requests, Android channels, foreground
  presentation, and notification-response handling.
- `expo-router` owns navigation after a notification response is validated.
- Screens import only `src/native/pushNotifications.ts`. They never import either
  notification package directly.

The wrapped binary must contain all three notification dependencies from the
bundled template. A package.json-only change is not proof of runtime support.

## Permission UX

Do not show the OS dialog on cold launch. Add a pre-permission card to the login
screen:

- Heading: `Stay up to date`
- Body: explain what notifications contain and that the choice can be changed.
- Primary action: `Enable notifications`
- Secondary action: `Not now`

Only the primary action calls the OS permission API. Sign-in remains available
when permission is denied. Add an app settings entry that can retry an
undetermined request or open system settings after denial.

Disable Firebase Messaging auto-init until the user opts in. This avoids
creating a Firebase installation before consent.

## Topic lifecycle

Topic names are exact:

- Signed out: `allUsers`
- Signed in: the Entra `oid` GUID canonicalized to lowercase

Transitions are idempotent:

1. Opt in while signed out: subscribe `allUsers`.
2. Sign in: subscribe the OID, then unsubscribe `allUsers`.
3. Account switch: subscribe the new OID, then unsubscribe the old OID.
4. Sign out: subscribe `allUsers`, then unsubscribe the old OID.
5. Opt out: unsubscribe the remembered app-owned topic and `allUsers`.

Persist only consent and the last topic. Never persist an Entra token. If the
host cannot expose a non-secret OID, stop; do not decode tokens in generated app
code and do not silently leave a signed-in device on `allUsers`.

Client-managed OID topic membership is not an authorization boundary. A
modified client can attempt to subscribe to another topic. Skills must state
this risk and must not recommend OID topics for confidential notification data.

FCM topic names are case-sensitive, while GUID comparison is not. Normalize the
validated OID to lowercase in both the client wrapper and sender flow; do not
otherwise hash, prefix, or transform it.

## Payload and deep links

Use data strings only:

```json
{
  "schemaVersion": "1",
  "deepLink": "/(app)/work-items/00000000-0000-0000-0000-000000000000"
}
```

Accept only:

- an internal route beginning with `/`
- the app's configured custom scheme

Reject `http:`, `https:`, `javascript:`, encoded traversal, unknown route
versions, and malformed values. If auth is not ready, retain one pending
destination. Protected links opened while signed out route to login and resume
after sign-in. Invalid or stale links route to a safe notification fallback
screen.

## Required wrapper surface

`src/native/pushNotifications.ts` exports typed, non-throwing operations:

- `getPushPermissionState`
- `requestPushPermission`
- `openPushSettings`
- `syncPushTopic`
- `disablePushNotifications`
- `registerNotificationHandlers`
- `consumeInitialNotificationDeepLink`

Return discriminated unions with explicit `unsupported`, `permission-denied`,
`missing-oid`, `invalid-deep-link`, `firebase-error`, and `notification-error`
reasons.
