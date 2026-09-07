---
name: add-push-notifications
description: Use whenever adding, configuring, repairing, or changing app-side push runtime integration in a Power Apps Expo mobile app. Owns notification permissions, registration-token lifecycle, FCM topic synchronization, listeners/background handling, and the shared typed navigation-intent integration; orchestrates but does not own Firebase/platform setup, sender authentication, flows, wrapped builds, installation, or physical delivery.
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

This skill owns stage 3 only: permissions and consent, registration-token
lifecycle, exact topic transitions, foreground/background/response listeners,
and validated navigation intents. Never redo a proven Firebase client or platform
handoff merely because runtime integration, sender authentication, flow
authoring, build, or delivery is incomplete. Conversely, runtime integration
does not prove any downstream stage. Do not provision sender authentication,
author flows, create or install a wrapped artifact, or execute physical
delivery cases here; route those stages to their owners.

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

1. Verify app and runtime -> 2. Verify auth identity -> 3. Resume/establish
Firebase client setup -> 4. Resume manual Apple and APNs setup when
needed -> 5. Write wrapper and shared navigation module
-> 6. Add permission UX -> 7. Wire auth/topic lifecycle -> 8. Wire navigation sources
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

### 10. Update memory bank and report lifecycle status

Update `memory-bank.md` with packages, Firebase project ID (not credentials),
permission UX, topic policy, navigation schema version/destination registry,
custom-scheme/HTTPS configuration state, and validation status.

Apply the canonical lifecycle resume rules. Report these states independently,
even when several are pending and even when Android and iOS differ:

| State | What to report | Owner / next route |
|---|---|---|
| Native client | Compatibility summary only: report Android and iOS separately below; never use this row as the sole client status | `/setup-fcm` owns missing or drifted client identity |
| Android Firebase client | not selected / missing / configured / blocked, immutable Android Firebase app ID, package identity, and static validation | `/setup-fcm` |
| iOS Firebase client | not selected / missing / configured / blocked, immutable iOS Firebase app ID, bundle identity, and static validation | `/setup-fcm` |
| Android platform credentials/capabilities | not applicable / incomplete / configured, physical verification pending / blocked | Do not invent a separate Android owner when the selected runtime requires no external handoff |
| iOS platform credentials/capabilities | not applicable / incomplete / **configured, physical verification pending** / blocked / physically verified | `/setup-apple-ios` and `/setup-apns` configure; only `/verify-ios-push` can mark physical verification complete |
| APNs | Compatibility summary of the iOS platform row: not applicable / incomplete / **configured, device verification pending** / physically verified | `/setup-apns` configures; only `/verify-ios-push` can mark physical verification complete |
| Android runtime integration | missing / incomplete / integrated / blocked | This skill |
| iOS runtime integration | missing / incomplete / integrated / blocked | This skill |
| Sender authentication | missing / valid WIF handoff present / stale or blocked / customer-owned Power Automate sender with observable contract read back but authentication not plugin-validated | `/create-push-notification-flow` offers WIF or plugin-created flows with customer-configured FCM authentication |
| Power Automate flows | missing / producer only / exact producer+sender IDs recorded / published-and-read-back, without mutating or re-verifying them here | `/create-push-notification-flow`; manual Power Automate mode still requires the customer-supplied exact sender flow ID and safe FlowAgent read-back |
| Wrapped Android build | not applicable / missing / stale / ready / blocked | `/build-android`; route by name only and do not assume its artifact format, build modes, or evidence contract |
| Wrapped iOS build | not applicable / missing / stale / recorded `development` or `ad-hoc` IPA | `/build-ios`; the user manages Xcode configuration and signing assets, then the skill runs the direct Wrap command after exact confirmation |
| Physical Android delivery | not applicable / pending / partial / failed / verified | `/verify-android-push`; route by name only and do not assume its internal matrix or evidence format |
| Physical iOS delivery | not applicable / pending / partial / failed / verified | `/verify-ios-push`; never substitute config validation, Firebase acceptance, simulator, Expo Go, or Metro evidence |

For iOS, report and preserve this route in order:
`/setup-fcm` -> `/setup-apple-ios` -> `/setup-apns` -> client integration in
this skill -> sender authentication and `/create-push-notification-flow` ->
`/build-ios` -> `/verify-ios-push`. Route to `/build-ios` only after sender
authentication and the exact producer/sender flows are ready. A manual sender
must use the canonical safe handoff: the preferred Power Automate route has a
the exact plugin-created sender flow ID plus observable FlowAgent read-back,
and its authentication remains not plugin-validated. A bare manual choice or
producer-only handoff is not sufficient for this build/readiness gate or
plugin physical verification. These
are handoffs, not substeps: do not copy their manual Apple/Xcode guidance,
user-managed Wrap build, FlowAgent read-back, or physical-device procedures
into this workflow.

For Android, preserve the same stage order:
`/setup-fcm` -> any explicitly required platform-capability owner -> client
integration in this skill -> sender authentication and
`/create-push-notification-flow` -> `/build-android` ->
`/verify-android-push`. Those routes are names only. Do not infer or
describe their artifact format, build modes, installation mechanism, internal
steps, or evidence schema.

For an already integrated native client, the user may run
`/create-push-notification-flow` directly. That skill validates the active
client project and resumes sender authentication as needed: WIF is preferred,
or the customer may choose plugin-created Power Automate flows and configure
the sender's FCM authentication manually. For Microsoft-stack uncertainty,
use the Microsoft Learn guidance in `shared/shared-instructions.md` instead of
guessing connector, Entra, or Power Platform behavior.

When a manual Power Automate sender is explicitly recorded with the exact
customer-supplied sender flow ID and FlowAgent has read back the exact
producer/sender flows as `Started` with the observable outbox/routing/delivery
contract, report:
`customer-owned Power Automate sender / observable contract read back; authentication not plugin-validated`.
Continue to the requested platform build owner without requiring
`sender-auth.json`, rerouting through a managed auth skill, inspecting
credentials, or claiming authentication validation.
