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
   topic lifecycle, and deep links.
2. **Sender authentication:** `/setup-push-wif` (preferred) or
   `/setup-push-service-account` for a compatible existing service-account
   integration.
3. **Power Automate flows:** `/create-push-notification-flow`.

This skill owns track 1 only. Never redo a proven client integration merely
because sender authentication or flow authoring is incomplete. Conversely,
client completion does not prove that sender authentication or delivery flows
exist.

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
this step. Propagate blockers without downgrading them.

### 5. Write the wrapper

Create `src/native/pushNotifications.ts` using the required surface and result
types from the push contract. It must:

- keep Firebase auto-init off until consent
- create the Android channel before requesting permission
- listen for token refresh
- implement the exact `allUsers`/OID transitions
- persist consent + last topic only
- install foreground/background/response listeners once
- validate every deep link before returning it
- never throw into a screen

If the wrapper already exists, inspect and update it idempotently; do not append
duplicate listeners.

### 6. Add permission UX

Update `app/login.tsx` with the pre-permission card. Preserve the existing sign
in button and auth error handling. Add or update an app settings/profile screen
with current permission status and enable/open-settings actions.

### 7. Wire lifecycle

Add one provider/hook under `src/hooks/` that observes auth readiness,
sign-in/OID changes, sign-out, consent, and token refresh. Mount it once inside
`app/_layout.tsx` under `PowerAppsProvider`. Preserve provider ordering.

### 8. Wire deep links

Register response listeners and cold-start response consumption once. Use Expo
Router only after payload validation and auth readiness. Add a safe fallback
route when the app does not already have one.

### 9. Validate

Run:

```bash
npx tsc --noEmit
node "${PLUGIN_ROOT}/scripts/validate-push-notification-config.js" --project-root .
node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" --project-root . \
  --file src/native/pushNotifications.ts \
  --file app/_layout.tsx \
  --file app/login.tsx
```

Add every other changed file explicitly to the final validator call.

### 10. Update memory bank and report track status

Update `memory-bank.md` with packages, Firebase project ID (not credentials),
permission UX, topic policy, deep-link schema version, and validation status.

Report the three track states separately:

- native client integration and selected Android/iOS Firebase app IDs;
- sender-auth handoff (`sender-auth.json`) status, without creating or
  validating it here;
- Power Automate producer/sender flow status.

For an already integrated native client, the user may run
`/create-push-notification-flow` directly. That skill validates the active
client project and resumes sender authentication as needed: WIF is preferred;
an existing service-account integration is supported only through the secure
Key Vault + managed identity + Entra-protected Azure Function compatibility
path owned by `/setup-push-service-account`.
