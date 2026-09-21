---
name: add-push-notifications
description: Primary guided entry point for adding, resuming, building, or verifying push notifications in a Power Apps Expo mobile app. It orchestrates the independent Firebase, Apple/APNs, app runtime, sender-auth, Power Automate, wrapped-build, and physical-delivery owners while directly owning permissions, registration-token lifecycle, FCM topic synchronization, listeners/background handling, and shared typed navigation-intent integration.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, Skill, Task
model: opus
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Push contract: [push-notifications.md](${PLUGIN_ROOT}/shared/references/push-notifications.md)** — follow exactly.

**Navigation contract: [navigation-link-contract.md](${PLUGIN_ROOT}/shared/references/navigation-link-contract.md)** —
follow exactly for in-app, custom-scheme, HTTPS, and push navigation.

**Lifecycle and routing:
[push-lifecycle.md](${PLUGIN_ROOT}/shared/references/push-lifecycle.md)** —
use these canonical stages, resume rules, and per-platform reporting states.

**Push tool readiness:
[push-tool-readiness.md](${PLUGIN_ROOT}/shared/references/push-tool-readiness.md)** —
use its stage matrix, failure categories, and confirmation/recheck protocol.

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

Do not add gcloud or Azure MCP surfaces to this skill's `allowed-tools`.
`/setup-push-wif` owns the complete serial cloud plan/approval/execute path in
the main context. This parent supplies pinned inputs, invokes owners, dispatches
only non-cloud workers, validates, joins, and merges.

**Sender-auth choices: [push-sender-auth-options.md](${PLUGIN_ROOT}/shared/references/push-sender-auth-options.md)** —
use this comparison when reporting sender-auth next steps. Manual FCM
authentication is customer-owned; this plugin does not inspect or validate it.

## Workflow

**Telemetry checkpoint: `configure_push_notifications`**

0. Collect orchestration decisions -> 1. Verify app and runtime -> 2. Verify
auth identity -> 3. Serially resume/establish Firebase client setup ->
4. Run serial cloud owners and the bounded non-cloud worker wave -> 5. Write wrapper
and shared navigation module -> 6. Add permission UX -> 7. Wire auth/topic
lifecycle -> 8. Wire navigation sources -> 9. Validate -> 10. Continue
sequential downstream owners -> 11. Update memory bank and report

### 0. Resolve the stopping point and collect orchestration decisions

Infer the requested platforms and stopping point from the user's prompt and
existing plan. Ask for the platform only when it is unclear. Never ask the
user to choose a stopping point:

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

Record the inferred/defaulted stopping point for this run without prompting.
Do not ask the user to choose or remember the individual owner commands.

Build a stage-lazy readiness schedule from that stopping point:

- **Configure app:** Firebase client readiness only.
- **Create delivery flows:** Firebase, then only the selected sender-auth
  owner (WIF when selected), then FlowAgent.
- **Build for device:** the above plus only the selected platform build owner.
- **Verify end to end:** the above plus only the selected platform's build,
  FlowAgent read-back, and physical-device prerequisites.

Do not run WIF, FlowAgent, Android, iOS, or device probes before their stage is
eligible. A later missing prerequisite does not invalidate a completed
Firebase/runtime stage.

In the same main-context decision pass, resolve everything knowable before
worker dispatch. Workers have no authority to ask, infer, or broaden these
choices:

- show the canonical two-option sender-auth comparison and record exactly
  **Workload Identity Federation (Recommended)** or **Create Power Automate
  flows; configure FCM authentication manually**. A valid matching
  `sender-auth.json` may establish the WIF choice; a safe exact existing manual
  flow handoff may establish the manual choice. Otherwise ask once. For
  **Configure app**, record the choice for resumability but do not make
  sender-auth cloud work eligible;
- when WIF is selected and no fresh matching handoff already fixes the choice,
  ask the user to select exactly one Entra registration mode:
  `reuse-app-registration`, `use-existing-registration`, or
  `create-dedicated-registration`. For app reuse, validate the
  `auth.config.json` tenant/client ID. For another existing registration, ask
  only for its client ID and require it in the same resolved tenant without
  editing `auth.config.json`. For create-new, pin the proposed display name.
  Never silently switch modes when one identity cannot be validated;
- inspect the approved screen plan and current source to fix the semantic
  destination registry, exact settings/profile surface, exact existing
  navigation-sender files that need conversion, and the Android channel ID.
  Ask one grouped navigation question only for genuine ambiguity; never let a
  worker discover and choose another screen or file;
- do not ask about HTTPS App Links/Universal Links as part of push setup. Use
  an exact HTTPS origin only when the user's prompt explicitly requests these
  links or the existing approved plan already records one; otherwise record
  `null`. Never infer an origin from a website, tenant, environment, custom
  scheme, or existing unapproved native setting;
- when iOS is selected, note that platform-specific Apple/APNs decisions remain
  pending unless they are already safely recorded. Do not ask whether an APNs
  credential is uploaded, which credential route applies, or whether Firebase
  Console accepted it during this pre-Firebase decision pass. Those questions
  require the exact Firebase project and immutable iOS app identity established
  in Step 3. Do not request a credential, credential path, account identity,
  device identifier, signing-asset identifier, screenshot, or portal output.

For cold WIF setup, collect and pin the exact registration mode,
Firebase/Google project, Google
execution mode, Azure tenant/subscription/resource group, pool/provider,
sender service account, selected Entra client ID, optional create-new display
name, Key Vault URI and secret name, and runtime connection principal. Both
existing-registration modes require a non-null same-tenant client ID.
Only `create-dedicated-registration` may pass `null` rather than inventing one. Do not guess
the route, diff, mutation list, or API enablement list.
Those are live facts produced by the read-only WIF planning phase in Step 4.
If create-new initial inventory proves the exact dedicated Entra identity is absent, the
parent first displays and approves only the minimal
identity/credential/secret-safe Key Vault bootstrap plan. After that stage
returns the server-generated client ID, the parent requires a fresh read-only
claim-driven plan and a second explicit approval for all remaining
Google/API/RBAC work. Approval of one stage or action does not approve an
adjacent stage or action. The WIF owner asks only for newly required
decisions and must never repeat a question already answered.

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

### 3. Serially resume or establish and join Firebase client setup

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
Firebase MCP path, preserve its stable readiness/failure category and stop at
that owner workflow rather than falling back to CLI or console automation
here. A Resource Manager error from Firebase MCP is not evidence that gcloud
is missing.

`/setup-fcm` is the serial foundation. Invoke it at most once for the selected
set, wait for its complete owner result, then independently re-read the active
project and every selected immutable Firebase app/config/Expo identity. Do not
start any later worker from one platform's early result. Active
Android and iOS configs must name the same exact project.

Only after this exact Firebase result, reread `memory-bank.md`. The remaining
worker-wave SHA-256 is frozen only after serial WIF completion and immediately
before non-cloud execution dispatch in Step 4.3.

At this point, after Firebase login when needed, exact project activation and
read-back, and the immutable iOS Firebase app has been created or reused and
validated, collect unresolved iOS decisions in the main context:
registered-device mode (`development`, `ad-hoc`, or both), approved Apple Team
ID, Apple setup completion, APNs `.p8` or `.p12` route, and the Firebase
Console upload attestation. Reuse safely recorded answers rather than asking
again, but never solicit or confirm them before the Firebase foundation
exists. Complete any identity-dependent WIF questions at this same
post-Firebase boundary. Present every user-performed Apple and Firebase Console
instruction in the canonical `/setup-apple-ios` then `/setup-apns` order and
collect each required Yes/No attestation before an iOS worker is eligible.
This manual Apple Developer/Xcode guidance does not change credentials or
portal state. It does not automate Apple setup or emit a proof artifact.

### 4. Run serial cloud owners, then the bounded non-cloud worker wave

Connected MCP servers are owned by the main skill context that proved their
readiness. A background `Task` may not inherit that connection, so no worker
may declare or call Firebase, gcloud, Azure, or FlowAgent MCP tools.

#### 4.1 Complete sender authentication serially

When the stopping point is **Create delivery flows** or later and WIF is
selected, invoke `/setup-push-wif --working-dir <root>` synchronously. That
owner performs all local readiness, gcloud/Azure MCP authentication and
context checks, read-only planning, explicit approvals, cloud mutations,
fresh proof, and `sender-auth.json` validation in the main context.

Preserve its three immutable registration modes:

- `reuse-app-registration`;
- `use-existing-registration`;
- `create-dedicated-registration`.

The two existing-registration modes retain the read-only inventory -> exact
approval -> execute path. A truly absent new dedicated identity retains the
two-stage approval boundary: approve and execute only the Entra/credential/
Key Vault bootstrap, reread the server-generated client ID and fresh claims,
then separately approve and execute the remaining Google/API/RBAC plan.
Bootstrap never mutates Google or writes `sender-auth.json`. Never collapse
the two approvals, replay an uncertain mutation, switch registration modes,
or offer a broader Firebase role. Do not ask about a broader Firebase role or
Firebase Admin SDK access.

If `/setup-push-wif` blocks, record sender authentication as blocked while
preserving completed Firebase and platform state. Runtime and iOS prerequisite
work may still continue when independently eligible, but FlowAgent authoring
cannot start until the selected sender-auth path is ready.

Manual FCM authentication skips `/setup-push-wif`, never fabricates
`sender-auth.json`, and remains customer-owned.

#### 4.2 Determine non-cloud worker tracks

Evaluate only these two independent tracks:

1. **Runtime integration** —
   `mobile-app:push-runtime-worker`, eligible when any selected platform's
   Steps 5-9 runtime state is incomplete or strict validation is not current.
2. **iOS prerequisites** —
   `mobile-app:push-ios-prerequisites-worker`, eligible only for selected iOS
   whose exact Apple/APNs safe state is incomplete and whose complete
   parent-collected confirmation envelope is ready. Android-only work skips
   this track.

Neither worker may declare an MCP tool. Do not dispatch a proven track. A
parent-collected **No**, missing manual action, or unsafe/missing approval keeps
only that track incomplete.

#### 4.3 Preflight, dispatch, and fallback

Silently preflight each eligible fully-qualified worker with an ordinary
`Task` request carrying `operation: preflight` in the prompt. Preflight
remains a no-read, no-network, no-write capability handshake and does not prove
MCP availability.

Require the exact capability records defined by each worker:

- runtime: `supportedOperations: ["preflight","execute"]`,
  `executeCloudAccess: "none"`, and
  `executeWriteScope: "exclusive-runtime-files-only"`;
- iOS prerequisites: `supportedOperations: ["preflight","execute"]`,
  `executeCloudAccess: "none"`, and `executeWriteScope: "none"`.

If Task resolution or preflight fails before any execution starts, use the
documented deterministic serial fallback: apply the combined `/setup-apns`
owner path exactly once for iOS prerequisites; it owns the Apple-first/APNs
sequence and returns one final iOS `WORKER_RESULT`, so do not invoke
`/setup-apple-ios` separately. Execute runtime Steps 5-9 inline. Do not add
cloud work to fallback; Firebase and WIF have already run serially in their
owners.

After successful preflight, freeze the exact worker decision envelopes,
exclusive files, and one raw-byte SHA-256 of `memory-bank.md`. When both
tracks are eligible, dispatch exactly two tasks in one bounded batch. When only
one is eligible, use one synchronous worker. Never manufacture another task
for symmetry.

Join every started task before fallback or parent access to its exclusive
files. Treat uncertain or partial dispatch as
`BLOCKED: push-worker-partial-dispatch-uncertain`.

#### 4.4 Validate returns, retry affected tracks, and merge once

Require the literal status line and exactly one parseable single-line
`WORKER_RESULT` from each worker. Validate worker/run/operation/stage/status,
all pinned identities and decisions, project-relative paths resolved against
`working_dir`, exclusive-file containment, required validations, safe memory
patch fields, and the exact cleanup/ownership rules in the worker contracts.

Collect valid `NEEDS_CONTEXT` results before asking one grouped parent
question. Update and redispatch only affected tracks, preserve successful
results, and cap each worker at two retries. Never auto-retry `BLOCKED`,
malformed output, identity drift, or an uncertain mutation.

After retries, independently rerun runtime and iOS owner validations.
Immediately before memory mutation, recompute the SHA-256. On mismatch,
preserve changed files and stop without overwriting. On match, apply all
allowlisted non-secret worker memory sections in one parent edit, ordered by
`ios-prerequisites` then `runtime-integration`.

### 5. Write the wrapper and shared navigation module

Steps 5-9 are the canonical runtime execution specification. The runtime
worker applies them when dispatched. The parent applies them only for the
deterministic inline fallback and must not touch runtime exclusive files while
a worker may own them.

Create `src/navigation/linkContract.ts` first. Use the approved screen plan's
Navigation Contracts table to define stable kebab-case destination IDs, exact
typed parameter schemas, authentication requirements, router intent, and the
only destination-to-Expo-Router-href mappings. Implement the non-throwing
in-app, configured custom-scheme, approved HTTPS, and FCM-data parsers plus one
dispatcher from `navigation-link-contract.md`. Never expose a raw route as an
external destination.

Add App Link/Universal Link configuration only when the user explicitly
requested it with an exact HTTPS origin or the approved plan already contains
one; never prompt for or guess an origin during push setup. When one is already
approved, add exact Android `intentFilters` and iOS `associatedDomains`
settings, then guide the customer to host the platform association files.
Record parser, native config, customer-confirmed association files, and
physical installed-build verification separately.

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
  project only the three semantic fields into notification content and add the
  exact app-owned foreground-local marker for later Expo response navigation
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
- use React Native Firebase `onNotificationOpenedApp` and
  `getInitialNotification` as the only remote FCM warm/cold interaction
  sources on Android and iOS; project only `schemaVersion`, `destination`, and
  `params` from `RemoteMessage.data` before semantic parsing
- use Expo Notifications response APIs only for app-created foreground local
  notifications carrying an exact app-owned source marker. Ignore every
  unmarked Expo response so a remote FCM tap cannot dispatch through both
  libraries. The marker is presentation metadata and must never be emitted by
  the FCM sender or accepted as a semantic parameter
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

Those response subscriptions comprise React Native Firebase remote
interactions and Expo responses gated to app-marked foreground local
notifications; Expo must not independently dispatch an unmarked remote FCM
response.

The generated lifecycle owner must call both `registerNotificationHandlers()`
and `syncPushTopic(...)`, export a named push/notification hook or Provider,
and be mounted exactly once under `app/`. Strict validation rejects direct
layout-only listener registration, missing lifecycle topic sync, and duplicate
mounts.

### 8. Wire navigation sources

Register React Native Firebase remote-interaction listeners and consume its
initial notification once. Register one Expo warm response listener and
consume its cold response only for the app-marked foreground local
notification path. Also consume initial and live custom-scheme/approved HTTPS
URLs. Funnel all external sources through the shared parser, source-aware
deduplication, and pending-intent guard. Use Expo Router only after contract
validation and router/auth readiness; never navigate from the background
message handler. Invalid, stale, unmarked, or duplicate intents are rejected
without fallback navigation.

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
   `/create-push-notification-flow --working-dir <root>` synchronously. Pass
   the already selected sender-auth route so that owner does not ask the
   sender-auth question a second time. For WIF, require the independently
   revalidated owner handoff. For manual authentication, preserve the
   owner's stopped-flow/customer-configuration behavior and never inspect
   credentials or require `sender-auth.json`.
2. For **Build for device** or later, invoke `/build-android` and/or
   `/build-ios` for selected platforms whose stages 1-5 are ready, in
   deterministic Android-then-iOS order. Preserve platform independence: an
   iOS Apple/APNs blocker must not prevent an otherwise ready Android build,
   and an Android blocker must not rewrite iOS state.
3. For **Verify end to end**, invoke `/verify-android-push` and/or
   `/verify-ios-push`, in deterministic Android-then-iOS order, only after
   each exact current artifact is ready and the owner-required installation handoff is complete.

After every owner returns, reread its project-local handoff and resume from the
first incomplete stage. A shared flow blocker stops both platforms'
flow-dependent continuation; a platform build/verification blocker stops only
that platform while the other safe branch may continue. Never auto-retry an
owner blocker, replace it with a less safe fallback, or merely print the next
slash command when the owner can be invoked in the current session. In
particular, do not merely print the next slash command; invoke the owner when
continuation is safe in the current session.

### 11. Update memory bank and report lifecycle status

Update `memory-bank.md` with packages, Firebase project ID (not credentials),
permission UX, topic policy, navigation schema version/destination registry,
custom-scheme/HTTPS configuration state, and validation status.

Do not reapply worker `memoryPatch` sections here: Step 4 performs their one
ordered parent merge. This final update records only subsequent sequential
owner handoffs and the final lifecycle summary, while preserving every
successful branch and every unresolved platform-specific blocker.

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
