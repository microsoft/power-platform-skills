# Push notification contract

Use this reference from `/add-push-notifications`, `/setup-fcm`,
`/setup-apple-ios`, `/setup-apns`,
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

Disable Firebase Messaging auto-init and iOS automatic remote-message
registration in the project-root `firebase.json`:

```json
{
  "react-native": {
    "messaging_auto_init_enabled": false,
    "messaging_ios_auto_register_for_remote_messages": false
  }
}
```

These are React Native Firebase's supported native configuration keys. They
must be present before the native build; a JavaScript call after app mount is
too late to guarantee consent-first initialization. This avoids creating a
Firebase installation or APNs/FCM registration token during cold launch.

Permission denial is a normal, non-throwing state. Do not register for remote
messages, enable auto-init, call `getToken`, or sync a topic after denial.
Preserve sign-in and expose the system-settings recovery action.

## Registration and listener lifecycle

Use this exact iOS opt-in sequence:

1. Request notification permission only after the pre-permission action.
2. If permission is not granted, return `permission-denied` with no Firebase
   registration side effects.
3. If `isDeviceRegisteredForRemoteMessages` is false, await
   `registerDeviceForRemoteMessages()`. Do not call `getToken()` first.
4. Await `setAutoInitEnabled(true)`.
5. Acquire the current token with `getToken()`, then perform the exact desired
   topic transition.
6. Install one `onTokenRefresh` listener. On every refresh, re-run exact topic
   sync from current consent/auth state.

Never persist an FCM registration token. Tokens are short-lived transport
credentials and are neither identity nor application state. Persist only
consent and the last app-owned topic.

Register `setBackgroundMessageHandler` in the package entry point before
`require('expo-router/entry')`. It must not live in a React component, provider,
hook, or layout because those mount too late for background/quit delivery.
The handler must be safe before auth and navigation are ready: validate the
data payload, perform only bounded background work, and never navigate.

Foreground message, token-refresh, and notification-response listeners remain
owned by the single React provider/hook. Make registration idempotent and
return/execute every native unsubscribe exactly once, including across Fast
Refresh. Background registration in the entry point is separate and must not
be duplicated by the provider.

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

Use the Expo Notifications response APIs for both warm and cold starts. The
provider registers one `addNotificationResponseReceivedListener` for warm
responses and consumes `getLastNotificationResponseAsync()` once after router
and auth readiness for a cold-start response. Run both paths through the same
payload validator and one pending-destination guard so a response cannot
navigate twice. Do not navigate from `setBackgroundMessageHandler`.

## Required wrapper surface

`src/native/pushNotifications.ts` exports typed, non-throwing operations:

- `getPushPermissionState`
- `requestPushPermission`
- `openPushSettings`
- `syncPushTopic`
- `disablePushNotifications`
- `registerNotificationHandlers`
- `handleBackgroundNotification`
- `consumeInitialNotificationDeepLink`

Generated implementations use these stable imports:

```ts
import * as Notifications from 'expo-notifications';
import messaging from '@react-native-firebase/messaging';
```

Strict completed-client validation requires real static call paths behind the
exports: permission query/request; consent-gated remote registration before
token acquisition; auto-init after consent; token acquisition and refresh;
topic subscribe/unsubscribe; foreground, background, warm-response, and
cold-start handling; shared deep-link validation; and explicit non-throwing
discriminated results. Export names, comments, markers, hardcoded objects, and
empty/no-op bodies are not implementation proof. The validator analyzes each
required function body independently, removes constant-false branches and code
after unconditional returns, and checks the remaining call order. Never hide
required calls behind `if (false)`, a `const enabled = false` guard, or place
them after a canned return.

Native operations must determine the returned discriminant:

- assign and await value-returning calls such as permission queries,
  `getToken()`, and cold-start response reads
- use each assigned value in a subsequent condition or returned validated
  outcome; `void result` or an unrelated hardcoded success is invalid
- await side-effecting calls inside `try`, then map rejection to a reachable
  `{ ok: false, reason: ... }` and successful completion to a reachable success
  or delegated validated result
- do not generate throw-only, always-success, ignored-call-plus-canned-return,
  or unreachable-evidence implementations

The single lifecycle hook/provider under `src/hooks/` or `src/providers/` must
call both `registerNotificationHandlers()` and `syncPushTopic(...)`, export a
named push/notification hook or Provider, and be mounted exactly once under
`app/`.

The fresh template's `index.js` intentionally contains an
`unconfiguredBackgroundHandler` no-op so the snapshot remains runnable before
Firebase client integration. `/add-push-notifications` must replace that stub
with an early require of the generated wrapper's
`handleBackgroundNotification` export and register that function before
`expo-router/entry`. Final integration and `/build-ios` run
`validate-push-notification-config.js --strict-client-integration`; that mode
also requires the mounted lifecycle owner, consent/recovery surfaces, exact
Expo-to-client package/bundle identity, memory handoff agreement when recorded,
and one shared Firebase project across active Android/iOS files.

Return discriminated unions with explicit `unsupported`, `permission-denied`,
`missing-oid`, `invalid-deep-link`, `firebase-error`, and `notification-error`
reasons.
