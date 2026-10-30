---
name: add-push-notifications
description: Internal implementation skill invoked by /add-native for push notifications sent with Firebase Cloud Messaging, using the template's @react-native-firebase/messaging and expo-notifications, with the app's Firebase client files in firebase/ for /deploy to publish and the wrap to inject.
user-invocable: false
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** - read first.

**Working directory:** before any project read or command, execute
[native-artifact-compatibility.md Step 0](${PLUGIN_ROOT}/shared/references/native-artifact-compatibility.md#0-bind-every-operation-to-the-app-root).
Inherit `/add-native`'s resolved absolute `working_dir`; bind every shell call and
file tool to it, even when this helper starts from another directory.

# Add Push Notifications

Internal helper for `/add-native push-notifications`, `/add-native push`, `/add-native remote-notifications`, `/add-native fcm`, `/add-native firebase-messaging`, and `/add-native @react-native-firebase/messaging`.

How push notifications reach a wrapped app:

- The template ships Firebase Cloud Messaging natively, with placeholder Firebase client files in `firebase/`. While a build has only placeholders, Firebase stays off and the app runs normally.
- The app's own `firebase/google-services.json` (Android) and `firebase/GoogleService-Info.plist` (iOS) replace the placeholders. `/deploy` publishes them with the app, and the Power Apps wrap injects them when push notifications are turned on for the platform in the wrap wizard. Makers can upload the files in the wrap wizard instead.
- Notifications are sent from Firebase, by the Firebase console (Messaging) or by a backend using the Firebase Admin SDK, never by the app. Every signed-in device subscribes to the `allUsers` topic.
- The OS shows notifications that arrive while the app is in the background. The app shows the ones that arrive while it is open.
- Push delivers only what a sender sends. A notification at a time the app defines (a due date, an appointment, a daily check-in) is `/add-native scheduled-notifications`, which the device schedules itself with no sender.

Hard rules:
- Do not install packages or edit `app.config.js` or native config. The template already ships `@react-native-firebase/app`, `@react-native-firebase/messaging`, `expo-notifications`, and the placeholder files, and `@microsoft/power-apps-native-host` configures them.
- Use Firebase and `expo-notifications` only through `src/native/pushNotifications.ts`, which loads them after checking for a Firebase app. Never import them anywhere else: `expo-notifications` loads its native modules on import, so a static import crashes host apps built without them (for example an older preview app or wrap base) at startup.
- The Firebase client files are the only Firebase files the app holds. They are not secrets (every app binary embeds them), but never add a service account key, server key, or other Firebase Admin credential to the app.
- Do not schedule local notifications for push messages, and never call `Notifications.setNotificationHandler` on iOS: there Firebase Messaging owns foreground presentation, so the wrapper shows open-app messages itself. An Android-only handler, such as the one scheduled notifications set, doesn't affect push: on Android, Firebase Messaging's own service handles push messages.

## 1. Verify app and packages

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
test -f app.config.js && test -f power.config.json && test -f package.json && test -d src || { echo "BLOCKED: working_dir is not an initialized app" >&2; exit 1; }
node -e "const p=require('./package.json'); const missing=['@react-native-firebase/app','@react-native-firebase/messaging','expo-notifications'].filter(m=>!p.dependencies?.[m]); if (missing.length) { console.error('MISSING: ' + missing.join(', ')); process.exit(1); } console.log('OK: push notification packages present');"
```

If a package is missing, stop: the app was created from a template without push notification support. Do not install the packages; tell the user that push notifications need an app created from the current template.

## 2. Validate the app's Firebase client files

The files must come from Firebase apps registered for the **bundle ID the app is wrapped with**, as the Android package name and the iOS bundle ID: the wrap signs the app with that ID and rejects files for any other. Ask for that bundle ID unless the plan or `memory-bank.md` records it.

Ask the user for the paths of the `google-services.json` and `GoogleService-Info.plist` they downloaded from the Firebase console (Project settings → Your apps). One file is fine when push notifications are only needed on one platform. If they don't have the files yet, point them to [firebase-setup.md](references/firebase-setup.md), skip Step 4a, and report push notifications as `NOT CONFIGURED`: the app works, and push notifications start working once the files are added and the app is redeployed.

Validate every file the user gives before anything is written. Pass the bundle ID, then each file's path:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/firebase-client-files.js" validate '<bundle-id>' '<firebase-file-path>' '<second-firebase-file-path>' --project-root '<working_dir>'
```

On `INVALID`, show the reason and ask for the right file; never edit a Firebase file's contents. A `google-services.json` may also list other Android apps (for example a development package); the wrap uses the one for the wrap bundle ID. Use files from one Firebase project for both platforms, so a notification sent to a topic or the app reaches both.

## 2a. Reconcile requested artifacts

Read and execute [native-artifact-compatibility.md](${PLUGIN_ROOT}/shared/references/native-artifact-compatibility.md)
Steps 1–3 for the push notifications row before any writes or reuse. Inherit the current
approval/mode from `/add-native`; do not repeat a valid scoped approval.
Inspect `src/native/pushNotifications.ts` for `isPushNotificationsAvailable`,
`registerForPushNotifications`, `showPushMessage`, `usePushNotifications`,
`ALL_USERS_TOPIC`, `PushMessage`, and `PushResult`, the Firebase app check before
the push modules load, the foreground and token-refresh handling, the topic
unsubscribe on cleanup with topic updates serialized at module scope (across
remounts), and the permission-checked retry on return to the app. Inspect
`app/(app)/_layout.tsx` for one unconditional `usePushNotifications` call. A
wrapper that imports Firebase or `expo-notifications` statically, or calls
Firebase without the check, is not compatible. An incompatible
artifact outside approval returns `NEEDS_CONTEXT` to the owner, or asks standalone.

## 3. Write `src/native/pushNotifications.ts`

Apply Step 2a's decision for `src/native/pushNotifications.ts`: create when requested
and missing, reuse unchanged only if compatible, or make only the approved scoped
update. Preserve custom code, exports, and callers; do not overwrite from the
example. Screens and layouts import this wrapper, not Firebase directly.

```ts
// src/native/pushNotifications.ts
import { useEffect, useRef } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import type { Messaging, RemoteMessage } from '@react-native-firebase/messaging';

declare const require: (id: string) => unknown;

type FirebaseMessaging = typeof import('@react-native-firebase/messaging');
type ExpoNotifications = typeof import('expo-notifications');

/** Every signed-in device subscribes to this topic, so a notification sent to it reaches all users. */
export const ALL_USERS_TOPIC = 'allUsers';

export type PushMessage = RemoteMessage;

export type PushResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'UNAVAILABLE' | 'PERMISSION_DENIED' | 'PUSH_FAILED'; message?: string };

interface Push {
  fcm: FirebaseMessaging;
  messaging: Messaging;
  notifications: ExpoNotifications;
}

/**
 * Firebase Messaging and the notification permission API, or null where push notifications can't
 * work: on web, in a host app without their native modules, in a wrap with push notifications turned
 * off, and with the template's placeholder Firebase files. The modules load only after the Firebase
 * app check, because expo-notifications fails on import in a host without its native modules.
 */
function loadPush(): Push | null {
  if (Platform.OS === 'web') return null;
  try {
    const { getApps } = require('@react-native-firebase/app') as typeof import('@react-native-firebase/app');
    if (getApps().length === 0) return null;
    const fcm = require('@react-native-firebase/messaging') as FirebaseMessaging;
    const notifications = require('expo-notifications') as ExpoNotifications;
    return { fcm, messaging: fcm.getMessaging(), notifications };
  } catch {
    return null;
  }
}

export function isPushNotificationsAvailable(): boolean {
  return loadPush() !== null;
}

/**
 * Asks for notification permission, registers the device with Firebase Cloud Messaging, and
 * subscribes it to `topic`. Returns the device's registration token, to send to this device only.
 */
export async function registerForPushNotifications(
  topic: string = ALL_USERS_TOPIC,
): Promise<PushResult<string>> {
  const push = loadPush();
  return push ? registerWith(push, topic) : { ok: false, reason: 'UNAVAILABLE' };
}

/** Registration with loaded modules, so the hook registers with the instance it listens on. */
async function registerWith({ fcm, messaging, notifications }: Push, topic: string): Promise<PushResult<string>> {
  try {
    const { granted } = await notifications.requestPermissionsAsync();
    if (!granted) return { ok: false, reason: 'PERMISSION_DENIED' };
    if (!fcm.isDeviceRegisteredForRemoteMessages(messaging)) {
      await fcm.registerDeviceForRemoteMessages(messaging);
    }
    const token = await fcm.getToken(messaging);
    await fcm.subscribeToTopic(messaging, topic);
    return { ok: true, value: token };
  } catch (error) {
    return { ok: false, reason: 'PUSH_FAILED', message: error instanceof Error ? error.message : String(error) };
  }
}

/** Shows a notification that arrived while the app is open; the OS shows the others. */
export function showPushMessage({ notification }: PushMessage): void {
  if (notification) Alert.alert(notification.title ?? '', notification.body);
}

/**
 * Topic (un)subscriptions run one at a time, across effect runs and across mounts: signing out
 * unmounts the signed-in layout, so the next sign-in's registration must wait for the previous
 * session's unsubscribe, which in turn waits for any registration still in flight. A failed one
 * doesn't hold up the next, and is logged in development builds.
 */
let topicUpdates: Promise<void> = Promise.resolve();

function updateTopic(update: () => Promise<unknown>): void {
  topicUpdates = topicUpdates.then(update).then(
    () => undefined,
    (error: unknown) => {
      if (__DEV__) console.log('[push] topic update failed', error instanceof Error ? error.message : String(error));
    },
  );
}

/**
 * Registers the signed-in user's device for push notifications, hands notifications that arrive
 * while the app is open to `onForegroundMessage`, and keeps the topic subscription across token
 * refreshes, removing it on sign-out or when `topic` changes. A failed registration (for example,
 * permission denied and later granted in system Settings) is retried when the app returns, without
 * asking again. Mount it once, in the signed-in layout. Does nothing where push notifications
 * aren't available.
 */
export function usePushNotifications(
  enabled: boolean,
  onForegroundMessage: (message: PushMessage) => void = showPushMessage,
  topic: string = ALL_USERS_TOPIC,
): void {
  const foregroundHandler = useRef(onForegroundMessage);

  useEffect(() => {
    foregroundHandler.current = onForegroundMessage;
  }, [onForegroundMessage]);

  useEffect(() => {
    const push = enabled ? loadPush() : null;
    if (!push) return undefined;
    const { fcm, messaging, notifications } = push;
    let active = true;
    let registered = false;
    const register = () =>
      updateTopic(async () => {
        if (!active || registered) return;
        const result = await registerWith(push, topic);
        registered = result.ok;
        if (__DEV__) console.log('[push] registration', result.ok ? 'succeeded' : result.reason, result.ok ? '' : result.message ?? '');
      });
    register();
    const stopMessages = fcm.onMessage(messaging, (message) => foregroundHandler.current(message));
    const stopTokenRefresh = fcm.onTokenRefresh(messaging, () => {
      updateTopic(async () => {
        if (active) await fcm.subscribeToTopic(messaging, topic);
      });
    });
    // Retry a failed registration on return to the app, once permission is granted: checking never
    // shows the prompt, so users aren't asked again on every resume.
    const appState = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || registered) return;
      void notifications.getPermissionsAsync().then(
        ({ granted }) => {
          if (granted) register();
        },
        () => undefined,
      );
    });
    return () => {
      active = false;
      appState.remove();
      stopMessages();
      stopTokenRefresh();
      // Signed out, topic changed or unmounted: the device stops receiving this topic.
      updateTopic(() => fcm.unsubscribeFromTopic(messaging, topic));
    };
  }, [enabled, topic]);
}
```

## 4. Mount it in the signed-in layout

Apply Step 2a's decision for `app/(app)/_layout.tsx`: add the call when missing,
reuse unchanged only if compatible, or make only the approved scoped update.
Call the hook once, unconditionally, right after `useAuth()` and before any early return:

```tsx
import { usePushNotifications } from '../../src/native/pushNotifications';

export default function AppLayout() {
  const { isSignedIn, isLoading } = useAuth();
  usePushNotifications(isSignedIn);
  // …existing redirect and return stay unchanged
}
```

Keep every other line of the layout unchanged. During `/create-mobile-app`, Step 10b rewrites only the layout's `return`, so the call stays. When the approved screens need a different foreground presentation (for example an in-app banner from the design system), pass a stable handler as the second argument instead of the default alert.

## 4a. Add the Firebase client files

Copy each file validated in Step 2 into `firebase/` (create the directory if needed), replacing the template's placeholder and keeping the names the template uses:
`firebase/google-services.json` for the Android file and `firebase/GoogleService-Info.plist` for the iOS file. Leave the placeholder in place for a platform without a file.

## 5. Type-check and summary

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
npx --no-install tsc --noEmit
```

Execute the shared compatibility contract's Step 4 after type-checking. Recheck
the Firebase app check before the push modules load, every export, the foreground and token-refresh handling,
and the layout call. Type-check success alone is insufficient; do not fix
screen/generated files. Only after the requested artifact contract and
TypeScript both pass, return the shared compatibility result and actual
created/updated/reused paths before reporting:

```text
Push notifications : READY | NOT CONFIGURED (Firebase files not added yet)
Packages present   : @react-native-firebase/app, @react-native-firebase/messaging, expo-notifications
Wrapper            : src/native/pushNotifications.ts
Mounted in         : app/(app)/_layout.tsx
Firebase files     : firebase/google-services.json, firebase/GoogleService-Info.plist (<project id> | placeholders)
Native config      : not changed
Next steps         : /deploy publishes the Firebase files with the app; turn on push notifications per platform when wrapping the app with <bundle id>
```

Record the Firebase project ID and the wrap bundle ID in `memory-bank.md`.
