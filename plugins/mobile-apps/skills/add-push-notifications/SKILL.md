---
name: add-push-notifications
description: Primary guided entry point for adding, resuming, building, or verifying push notifications in a Power Apps Expo mobile app. It orchestrates the independent Firebase, Apple/APNs, app runtime, sender-auth, Power Automate, wrapped-build, and physical-delivery owners while directly owning permissions, registration-token lifecycle, FCM topic synchronization, listeners/background handling, and shared typed navigation-intent integration.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, Skill
model: opus
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Push contract: [push-notifications.md](${PLUGIN_ROOT}/shared/references/push-notifications.md)** — follow exactly.

**Navigation contract: [navigation-link-contract.md](${PLUGIN_ROOT}/shared/references/navigation-link-contract.md)** —
follow exactly for in-app, custom-scheme, HTTPS, and push navigation.

**Lifecycle and routing:
[push-lifecycle.md](${PLUGIN_ROOT}/shared/references/push-lifecycle.md)** —
use these canonical stages, resume rules, and per-platform reporting states.

# Add Push Notifications

Orchestrate the canonical independent, resumable lifecycle:

1. Firebase client.
2. Platform credentials and capabilities.
3. Runtime integration.
4. Sender authentication.
5. Power Automate flows.
6. Wrapped build.
7. Physical delivery.

This is the default user-facing push command. It implements stage 3 directly:
permissions and consent, registration-token lifecycle, exact topic transitions,
foreground/background/response listeners, and validated navigation intents.
It invokes the owner skills for the other stages and continues after each
successful handoff until the user's selected stopping point is reached.

Never redo a proven stage merely because a downstream stage is missing.
Conversely, completion of one stage does not prove another. Keep cloud
provisioning, flow mutation, wrapped builds, installation handoffs, and
physical-device verification inside their owner skills; orchestration means
invoking and resuming those owners, not copying their implementation here.

Push cloud setup around this skill is **official MCP-first**. `/setup-fcm` is
the only supported Firebase owner and requires the vendor-official Firebase MCP
only; do not substitute `firebase-tools`, `gcloud`, or browser automation from
here. `/setup-push-wif` separately owns Google-side WIF provisioning through
gcloud MCP or its guarded official CLI fallback, and FlowAgent remains the
only Power Automate mutation path.

**Sender-auth choices: [push-sender-auth-options.md](${PLUGIN_ROOT}/shared/references/push-sender-auth-options.md)** —
use this comparison when reporting sender-auth next steps. Manual FCM
authentication is customer-owned; this plugin does not inspect or validate it.

## Workflow

**Telemetry checkpoint: `configure_push_notifications`**

0. Select one stopping point -> 1. Verify app and runtime -> 2. Verify auth
identity -> 3. Resume/establish Firebase client setup -> 4. Resume manual Apple
and APNs setup when needed -> 5. Write wrapper and shared navigation module ->
6. Add permission UX -> 7. Wire auth/topic lifecycle -> 8. Wire navigation
sources -> 9. Validate -> 10. Continue through downstream owners -> 11. Update
memory bank and report

### 0. Select one stopping point

Infer the requested platforms and stopping point from the user's prompt and
existing plan. Ask one grouped question only when either is unclear:

- **Configure app** — complete Firebase/platform prerequisites and app runtime
  integration, then stop.
- **Create delivery flows** — also complete sender-auth selection and Power
  Automate producer/sender flows.
- **Build for device** — also run the selected platform build owner.
- **Verify end to end** — also resume physical-device delivery verification.

Default to **Create delivery flows** when the user simply asks to add push
notifications. Building and physical verification require explicit intent
because they involve customer-managed signing, installation, and device
actions.

Record the selected platforms and stopping point for this run. Do not ask the
user to choose or remember the individual owner commands.

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
project or similarly named Firebase app. If `/setup-fcm` cannot prove the
Firebase MCP path, stop and repair that owner workflow rather than falling back
to CLI or console automation here.

### 4. Resume APNs setup when needed

When iOS is selected, inspect `memory-bank.md` for a completed APNs/Firebase
Console handoff for the same Firebase project and iOS app ID. First invoke
`/setup-apple-ios --working-dir <root>` when the exact Team, bundle, Push
capability, registered-device, or development/ad-hoc choice has not been
confirmed. This owner provides manual Apple Developer/Xcode guidance and
requires explicit safe confirmation before each user-performed change; it
does not automate Apple setup or emit a proof artifact. Only after that
guidance is completed, invoke
`/setup-apns --working-dir <root>` when iOS client setup is new, the app ID or
project changed, or APNs completion cannot be proven. Android-only work skips
both steps. Propagate blockers without downgrading them. Preserve the manual
Firebase APNs credential boundary: neither skill reads or uploads the selected
`.p8` authentication key or `.p12` certificate. A successful manual handoff
means **configured, device verification pending**; it is not physical delivery
success.

### 5. Write the wrapper and shared navigation module

Create `src/navigation/linkContract.ts` first. Use the approved screen plan's
Navigation Contracts table to define stable kebab-case destination IDs, exact
typed parameter schemas, authentication requirements, router intent, and the
only destination-to-Expo-Router-href mappings. Implement the non-throwing
in-app, configured custom-scheme, approved HTTPS, and FCM-data parsers plus one
dispatcher from `navigation-link-contract.md`. Never expose a raw route as an
external destination.

Ask for an HTTPS origin before adding App Link/Universal Link configuration;
never guess one. When provided, add exact Android `intentFilters` and iOS
`associatedDomains` settings, then guide the customer to host the platform
association files. Record parser, native config, customer-confirmed association
files, and physical installed-build verification separately.

Create `src/native/pushNotifications.ts` using the required surface and result
types from the push contract. It must:

- use the stable generated imports `import * as Notifications from
  'expo-notifications'` and `import messaging from
  '@react-native-firebase/messaging'`; strict validation follows those imports
  into concrete reachable calls in each required function and does not accept
  markers, export names, hardcoded result objects, constant-false branches, or
  calls placed after an unconditional return as implementation proof
- preserve the template `firebase.json` settings that disable native Messaging
  auto-init and iOS automatic remote-message registration before consent, plus
  its Android default notification channel ID
- create the Android channel before requesting permission, using visible,
  non-silent importance such as `Notifications.AndroidImportance.DEFAULT` or
  `HIGH`; use the same app-owned channel ID in `setNotificationChannelAsync`,
  foreground schedule triggers, and
  `firebase.json` `messaging_android_notification_channel_id` rather than
  inventing a validator-specific fixed ID
- on iOS, sequence granted permission -> remote-message registration when
  required -> enable auto-init -> token acquisition -> exact topic sync
- treat permission denial and missing remote-message registration as explicit,
  non-throwing outcomes; never call `getToken` before registration
- listen for token refresh and re-run exact topic sync from current auth state
- implement the exact `allUsers`/OID transitions
- persist consent + last topic only; never persist an FCM registration token
- keep foreground/token-refresh/response listeners idempotent in the single
  React provider and clean up every subscription exactly once
- inside the `messaging().onMessage` callback, validate `message.data` and
  explicitly `await Notifications.scheduleNotificationAsync(...)` for visible
  immediate local foreground presentation; use an Android trigger whose
  top-level `channelId` is the shared app-owned channel and which has no time or
  calendar fields, keep the schedule inside a non-throwing `try`/`catch`, and
  preserve `message.data ?? {}` in notification content for later response
  navigation
- configure `Notifications.setNotificationHandler` and `messaging().onMessage`
  on Android-reachable paths; the handler must return both
  `shouldShowBanner: true` and `shouldShowList: true` to allow banner/heads-up
  presentation and notification-center/list retention. Parsing alone,
  scheduling elsewhere, or merely installing a handler that suppresses either
  presentation surface is not proof
- export a non-throwing `handleBackgroundNotification` for the early entry
  point; it validates data and never navigates
- parse every notification navigation intent through
  `src/navigation/linkContract.ts` before returning it
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
`consumeInitialNotificationIntent`. Each native-facing operation catches
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

### 8. Wire navigation sources

Register one warm response listener and consume the Expo Notifications
cold-start response once. Also consume initial and live custom-scheme/approved
HTTPS URLs. Funnel all external sources through the shared parser, source-aware
deduplication, and pending-intent guard. Use Expo Router only after contract
validation and router/auth readiness; never navigate from the background
message handler. Invalid or stale intents are rejected without fallback
navigation.

Expose the typed in-app helper from the same module. Existing screen actions
that target registered semantic destinations must use it rather than
hand-building router paths.

### 9. Validate

Run:

```bash
npx tsc --noEmit
node "${PLUGIN_ROOT}/scripts/validate-push-notification-config.js" \
  --project-root . --strict-client-integration
node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" --project-root . \
  --file src/navigation/linkContract.ts \
  --file src/native/pushNotifications.ts \
  --file app/_layout.tsx \
  --file app/login.tsx
```

Add every other changed file explicitly to the final validator call.

### 10. Continue through downstream owners

After strict runtime validation succeeds, continue only as far as the selected
stopping point:

1. For **Create delivery flows** or later, invoke
   `/create-push-notification-flow --working-dir <root>`. That owner presents
   the two sender-auth choices and invokes `/setup-push-wif` when the user
   chooses WIF. Do not ask the sender-auth question a second time here.
2. For **Build for device** or later, invoke `/build-android` and/or
   `/build-ios` for selected platforms whose stages 1-5 are ready. Preserve
   platform independence: one platform may continue while another is blocked.
3. For **Verify end to end**, invoke `/verify-android-push` and/or
   `/verify-ios-push` only after the exact current artifact is ready and the
   owner-required installation handoff is complete.

After every owner returns, reread its project-local handoff and resume from the
first incomplete stage. Stop immediately on an owner blocker. Do not replace a
blocked owner with a less safe fallback, and do not merely print the next slash
command when the owner can be invoked in the current session.

### 11. Update memory bank and report lifecycle status

Update `memory-bank.md` with packages, Firebase project ID (not credentials),
permission UX, topic policy, navigation schema version/destination registry,
custom-scheme/HTTPS configuration state, and validation status.

Apply the canonical states and resume rules from `push-lifecycle.md`. Report
one compact row per selected platform plus one shared delivery row:

| Scope | Report |
|---|---|
| Android | Firebase client; runtime integration; wrapped build; physical delivery |
| iOS | Firebase client; Apple/APNs capability; runtime integration; wrapped build; physical delivery |
| Shared delivery | Sender authentication; producer/sender flows |

For each incomplete item, report the owning stage and whether this run stopped
because it reached the selected stopping point, needs a user-managed action, or
hit a blocker. Do not end with a list of commands the user must manually chain.
When continuation is possible in-session, invoke the owner instead.

Keep these distinctions explicit:

- `configured, device verification pending` is not physical iOS delivery.
- Firebase acceptance, an outbox `Sent` state, Metro, Expo Go, or simulator
  behavior is not physical-device proof.
- A customer-owned Power Automate sender may continue only with the exact
  plugin-created sender flow ID and safe FlowAgent read-back recorded as
  `customer-owned Power Automate sender / observable contract read back;
  authentication not plugin-validated`.
- Manual sender authentication never requires or fabricates
  `sender-auth.json`, and this workflow never inspects its credentials.
