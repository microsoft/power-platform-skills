---
name: setup-apns
description: Use when enabling iOS push notifications for a Power Apps Expo mobile app through Firebase Cloud Messaging and APNs, including APNs authentication keys, Firebase APNs upload, iOS entitlements, or troubleshooting iOS FCM topic delivery.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Push contract: [push-notifications.md](${PLUGIN_ROOT}/shared/references/push-notifications.md)**.

# Setup APNs through Firebase

FCM topics work on iOS because Firebase Messaging maps the APNs device token to
an FCM registration token. `expo-notifications` alone is insufficient.

## Phase 1 — Consume the `/setup-fcm` handoff

APNs setup extends the exact Firebase iOS app already configured by
`/setup-fcm`; it must not select or register a second app.

1. Verify iOS is a target and the Firebase Messaging modules are runtime-shipped.
2. Read the non-secret Firebase handoff from `memory-bank.md`: Firebase project
   ID, iOS Firebase app ID, iOS bundle identifier, and evaluated plist path.
   The expected default is `firebase/GoogleService-Info.plist`, but a validated
   project-relative override recorded by `/setup-fcm` is also supported.
3. Independently evaluate Expo config and resolve the final iOS bundle
   identifier. STOP if it differs from the handoff, is missing, or is still a
   template placeholder.
4. Read `ios.googleServicesFile` from the evaluated Expo config and require it
   to equal the handoff path. Resolve its real path and require it to remain
   inside the real project root and be a regular non-symlink file. Do not accept
   a newly supplied path or identity as a substitute for `/setup-fcm` output.
5. Reuse the Google account route confirmed by `/setup-fcm`. If that route is
   not available in the current session, repeat the read-only identity preflight
   from `firebase-cli-provisioning.md` and require the user-intended identity to
   see the recorded project; do not infer or switch accounts. List iOS apps in
   that project and match by the evaluated bundle identifier using the same
   deterministic resolver:

   ```bash
   IOS_MATCH="$(
     npx firebase-tools apps:list IOS --project "<PROJECT_ID>" --json \
       --account "<EMAIL>" |
       node "${PLUGIN_ROOT}/scripts/resolve-firebase-app-identity.js" \
         --project-root . --match-platform ios \
         --identifier "<IOS_BUNDLE_ID>"
   )"
   ```

   Omit `--account` only when `/setup-fcm` recorded the confirmed ADC route.
   Require `status == "match"` and require `.app.appId` to equal the recorded
   iOS Firebase app ID exactly. A preconfigured matching app is the expected
   success path: reuse it without calling `apps:create`. STOP on `no-match`,
   `ambiguous`, `error`, project mismatch, or app-ID mismatch.
6. Validate the installed plist against all three identities without printing
   its contents. The shared validator expects distinct candidate/destination
   paths, so make a short-lived project-local byte copy, validate it, then
   remove only that copy:

   ```bash
   PLIST_PATH="<EVALUATED_PROJECT_RELATIVE_PLIST_PATH>"
   PLIST_DIR="$(dirname "$PLIST_PATH")"
   PLIST_CHECK="${PLIST_DIR}/GoogleService-Info.apns-check.plist"
   test ! -e "$PLIST_CHECK" || {
     echo "BLOCKED: temporary APNs validation path already exists: $PLIST_CHECK"
     exit 1
   }
   cp -- "$PLIST_PATH" "$PLIST_CHECK"
   IOS_CONFIG_CHECK="$(
     node "${PLUGIN_ROOT}/scripts/validate-firebase-client-config.js" \
       --project-root . --platform ios \
       --candidate "$PLIST_CHECK" \
       --destination "$PLIST_PATH" \
       --expected-project-id "<PROJECT_ID>" \
       --expected-app-id "<IOS_APP_ID>" \
       --expected-identifier "<IOS_BUNDLE_ID>"
   )"
   rm -- "$PLIST_CHECK"
   ```

   Require `status == "reuse"`. Any `invalid`, `conflict`, or `error` means the
   project, Firebase app, bundle identifier, or file is not the exact
   `/setup-fcm` pairing. STOP and direct the user back to `/setup-fcm`; never
   replace the plist or continue to APNs upload.

## Phase 2 — Guided APNs key handoff

APNs authentication keys are Apple credentials. Their creation and upload stay
inside the user's Apple Developer and Firebase Console browser sessions; this
skill must not automate either action.

1. Guide the user to Apple Developer -> Certificates, Identifiers & Profiles ->
   Keys. Have them select an existing APNs-capable key or explicitly create one
   with Apple Push Notifications service enabled. Remind them that Apple permits
   the `.p8` download only once and that account key limits may apply.
2. Ask the user to keep the downloaded `.p8` outside the project and never paste
   it into chat or provide its path. Do not use `Read`, `Bash`, Apple APIs,
   browser automation, Firebase CLI, or any upload API to inspect, copy, move,
   encode, validate, or upload the key.
3. Guide the user to Firebase Console -> the exact recorded project -> Project
   settings -> Cloud Messaging -> the exact matched iOS app -> APNs
   authentication key. The user manually uploads the `.p8` and enters its Key
   ID and Apple Team ID.
4. Capture only the user's confirmation plus Key ID and Team ID for diagnostics.
   These identifiers are not the key. Never persist the `.p8`, its contents, a
   derived value, or a local path. If the user asks the agent to automate `.p8`
   creation or upload, decline that portion and continue with the guided Console
   steps.

## Phase 3 — App configuration and verification

1. Verify `app.config.js` includes:
   - `expo-notifications`
   - Firebase app/messaging plugins
   - `aps-environment`
   - `UIBackgroundModes: ['remote-notification']` when background data handling
     is enabled
2. Run `npx expo config --type public`, the push config validator, and changed
   file validation.
3. Record APNs setup status in `memory-bank.md` using only the verified Firebase
   project/app/bundle identity, Key ID, Team ID, and manual-upload confirmation.

Do not claim success without a physical-device iOS notification test using a
matching native build. A simulator, Expo Go, config validation, or successful
Firebase Console upload is not a substitute. Test foreground, background, and
notification-tap delivery on a physical device before marking APNs complete.
