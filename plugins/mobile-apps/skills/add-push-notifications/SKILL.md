---
name: add-push-notifications
description: Use whenever adding, configuring, repairing, or changing push notifications in a Power Apps Expo mobile app, including FCM topics, APNs/Firebase setup, notification permission UX, signed-in Entra OID topics, signed-out allUsers notifications, or notification deep links.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, Skill
model: opus
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Push contract: [push-notifications.md](${PLUGIN_ROOT}/shared/references/push-notifications.md)** — follow exactly.

# Add Push Notifications

Orchestrate the app-side notification integration. Treat these as independent,
resumable tracks:

1. **Native client:** Firebase client config, APNs handoff, permission UX,
   consent-first iOS registration, topic lifecycle, background delivery, and
   deep links.
2. **Sender authentication:** `/setup-push-wif` (preferred) or
   `/setup-push-service-account` for a compatible existing service-account
   integration.
3. **Power Automate flows:** `/create-push-notification-flow`.
4. **Wrapped iOS build:** `/build-ios` creates a registered-device
   `development` or `ad-hoc` IPA.
5. **Physical iOS delivery verification:** `/verify-ios-push` proves the exact
   IPA, published flows, APNs/FCM delivery, app states, topic transitions, and
   deep links on a registered physical device.

This skill owns track 1 only. Never redo a proven client integration merely
because sender authentication or flow authoring is incomplete. Conversely,
client completion does not prove that sender authentication or delivery flows
exist. Do not build an IPA or execute physical delivery cases here; route those
stages to their owner skills.

## Workflow

1. Verify app and runtime -> 2. Verify auth identity -> 3. Resume/establish
Firebase client setup -> 4. Resume APNs setup when needed -> 5. Write wrapper
-> 6. Add permission UX -> 7. Wire auth/topic lifecycle -> 8. Wire deep links
-> 9. Validate -> 10. Update memory bank and report independent next steps

### 1. Verify app and runtime

Require `package.json`, `app.config.js`, `power.config.json`, and
`memory-bank.md`. Verify these exact dependencies exist in both the project and
`${PLUGIN_ROOT}/template/package.json`:

- `expo-notifications`
- `@react-native-firebase/app`
- `@react-native-firebase/messaging`
- `expo-router`

Also verify the installed native runtime exposes the modules. If the project is
running in an older Power Apps Developer/rewrap binary, stop:

> Push packages are present in JavaScript but the wrapped native runtime has not
> been proven to contain them. Install/use a runtime built from the matching
> mobile template before continuing.

Never run `npx expo install` from this skill.

### 2. Verify auth identity

Inspect the installed `@microsoft/power-apps-native-host` type declarations for
the `useAuth()` return type. Continue only if it exposes a typed, non-secret
Entra OID/current-user claim. Record the exact property path in
`src/native/pushNotifications.ts`.

If no OID is exposed, run `npm install` once so the template's version-guarded
postinstall compatibility patch can expose `useAuth().user.oid`, then inspect
the declarations again. If the patch rejects an unknown host package shape,
stop rather than modifying `node_modules` ad hoc. Do not decode MSAL tokens in
app code.
Read `${PLUGIN_ROOT}/shared/references/push-host-contract.md` for the exact
upstream API and runtime contract to report with the blocker.

### 3. Resume or establish Firebase client setup

Read `memory-bank.md`, evaluate `npx expo config --type public --json`, and
inspect only active project-local `firebase/google-services.json` and
`firebase/GoogleService-Info.plist` paths. Do not treat package presence, an
inactive file, or a remembered project ID as completed client setup.

- If every selected native platform has a valid active client config and all
  configs name the same Firebase project, reuse them and skip `/setup-fcm`.
- If no selected native platform is configured, or a newly selected platform
  is missing its active config, invoke `/setup-fcm --working-dir <root>`.
- If active Android/iOS configs disagree on Firebase project, or a config does
  not match evaluated Expo identity, stop instead of choosing one platform as
  authoritative.

`/setup-fcm` resolves Android by exact package name and iOS by exact bundle
identifier. One exact match is reused automatically. Multiple safe exact
matches require an immutable Firebase app-ID choice independently for Android
and iOS, followed by a fresh exact-identity read-back. New client integrations
still go through `/setup-fcm`; never skip it based only on an existing Firebase
project or similarly named Firebase app.

### 4. Resume APNs setup when needed

When iOS is selected, inspect `memory-bank.md` for a completed APNs/Firebase
Console handoff for the same Firebase project and iOS app ID. Invoke
`/setup-apns --working-dir <root>` when iOS client setup is new, the app ID or
project changed, or APNs completion cannot be proven. Android-only work skips
this step. Propagate blockers without downgrading them. A successful manual
handoff means **configured, device verification pending**; it is not physical
delivery success.

### 5. Write the wrapper

Create `src/native/pushNotifications.ts` using the required surface and result
types from the push contract. It must:

- use the stable generated imports `import * as Notifications from
  'expo-notifications'` and `import messaging from
  '@react-native-firebase/messaging'`; strict validation follows those imports
  into concrete reachable calls in each required function and does not accept
  markers, export names, hardcoded result objects, constant-false branches, or
  calls placed after an unconditional return as implementation proof
- preserve the template `firebase.json` settings that disable native Messaging
  auto-init and iOS automatic remote-message registration before consent
- create the Android channel before requesting permission
- on iOS, sequence granted permission -> remote-message registration when
  required -> enable auto-init -> token acquisition -> exact topic sync
- treat permission denial and missing remote-message registration as explicit,
  non-throwing outcomes; never call `getToken` before registration
- listen for token refresh and re-run exact topic sync from current auth state
- implement the exact `allUsers`/OID transitions
- persist consent + last topic only; never persist an FCM registration token
- keep foreground/token-refresh/response listeners idempotent in the single
  React provider and clean up every subscription exactly once
- export a non-throwing `handleBackgroundNotification` for the early entry
  point; it validates data and never navigates
- validate every deep link before returning it
- never throw into a screen

Assign and await every value-returning native operation, then use that value in
a later branch or returned validated outcome. In particular, inspect permission
results before continuing, reject an empty `getToken()` result before topic
sync, and pass the assigned cold-start response into the shared deep-link
validator. Await side-effecting native calls inside `try` and return a failure
discriminant from `catch`; an ignored call followed by `{ ok: true }`, an
always-success catch, a throw-only body, or a canned result is invalid.

Keep the permission query in `getPushPermissionState`, the consent/register/
auto-init/token sequence in `requestPushPermission`, topic subscribe and
unsubscribe calls in `syncPushTopic`, listener registration in
`registerNotificationHandlers`, background validation in
`handleBackgroundNotification`, and cold-start response consumption in
`consumeInitialNotificationDeepLink`. Each native-facing operation catches
package failures and returns the documented discriminated result. Do not
replace these paths with empty functions, hardcoded results, comments, or
implementation markers.

If the wrapper already exists, inspect and update it idempotently; do not append
duplicate listeners.

Update the package entry point (the template uses `index.js`) so
`setBackgroundMessageHandler` is registered before
`require('expo-router/entry')`. Replace the template's
`unconfiguredBackgroundHandler` no-op with a direct project-local require of
`handleBackgroundNotification` from `src/native/pushNotifications.ts`, then pass
that exported function to `setBackgroundMessageHandler`. The generated wrapper,
not `index.js`, owns the implemented handler body. The entry point must not
import React state or require auth/router readiness. Never move registration into
`app/_layout.tsx`, a provider, or a hook.

### 6. Add permission UX

Update `app/login.tsx` with the pre-permission card. Preserve the existing sign
in button and auth error handling. Add or update an app settings/profile screen
with current permission status and enable/open-settings actions.

### 7. Wire lifecycle

Add one provider/hook under `src/hooks/` that observes auth readiness,
sign-in/OID changes, sign-out, consent, and token refresh. Mount it once inside
`app/_layout.tsx` under `PowerAppsProvider`. Preserve provider ordering. The
provider owns foreground, token-refresh, and response subscriptions only;
background registration remains in the early entry point.

The generated lifecycle owner must call both `registerNotificationHandlers()`
and `syncPushTopic(...)`, export a named push/notification hook or Provider,
and be mounted exactly once under `app/`. Strict validation rejects direct
layout-only listener registration, missing lifecycle topic sync, and duplicate
mounts.

### 8. Wire deep links

Register one warm response listener and consume the Expo Notifications
cold-start response once. Funnel both through the same payload validator and
pending-destination guard. Use Expo Router only after payload validation and
auth readiness; never navigate from the background message handler. Add a safe
fallback route when the app does not already have one.

### 9. Validate

Run:

```bash
npx tsc --noEmit
node "${PLUGIN_ROOT}/scripts/validate-push-notification-config.js" \
  --project-root . --strict-client-integration
node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" --project-root . \
  --file src/native/pushNotifications.ts \
  --file app/_layout.tsx \
  --file app/login.tsx
```

Add every other changed file explicitly to the final validator call.

### 10. Update memory bank and report orchestration status

Update `memory-bank.md` with packages, Firebase project ID (not credentials),
permission UX, topic policy, deep-link schema version, and validation status.

Report these states independently, even when several are pending:

| State | What to report | Owner / next route |
|---|---|---|
| Native client | integrated / incomplete / blocked, selected Android/iOS Firebase app IDs, and static validation | This skill; `/setup-fcm` for missing or drifted client identity |
| APNs | not applicable / incomplete / **configured, device verification pending** / physically verified | `/setup-apns` configures; only `/verify-ios-push` can mark physical verification complete |
| Sender authentication | missing / valid handoff present / stale or blocked, based only on existing `sender-auth.json` and memory metadata | `/setup-push-wif` preferred, or `/setup-push-service-account` for the supported compatibility path |
| Power Automate flows | missing / recorded / published-and-read-back, without mutating or re-verifying them here | `/create-push-notification-flow` |
| Wrapped iOS build | not applicable / missing / stale / recorded `development` or `ad-hoc` IPA | `/build-ios`; never run Wrap/Xcode or inspect signing assets here |
| Physical iOS delivery | not applicable / pending / partial / failed / verified | `/verify-ios-push`; never substitute config validation, Firebase acceptance, simulator, Expo Go, or Metro evidence |

When iOS is selected and the client plus APNs handoff are configured, route to
`/build-ios` if no fresh matching registered-device IPA is recorded. Route to
`/verify-ios-push` only after the build, sender authentication, and exact
producer/sender flows are ready. These are handoffs, not substeps: do not copy
their signing, build, FlowAgent read-back, or physical-device procedures into
this workflow.

For an already integrated native client, the user may run
`/create-push-notification-flow` directly. That skill validates the active
client project and resumes sender authentication as needed: WIF is preferred;
an existing service-account integration is supported only through the secure
Key Vault + managed identity + Entra-protected Azure Function compatibility
path owned by `/setup-push-service-account`.
