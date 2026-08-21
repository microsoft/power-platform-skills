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
   ID, the immutable selected iOS Firebase app ID, iOS bundle identifier, and
   evaluated plist path. The app ID is the exact selection made by `/setup-fcm`,
   including when multiple Firebase apps safely shared the same bundle ID.
   STOP if any field is absent; do not reconstruct or replace the selection.
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
   from `firebase-cli-provisioning.md`; do not infer or switch accounts. With
   either route, rerun `projects:list --json` and require the user-intended
   identity to see the exact recorded project ID in that fresh machine-readable
   result. STOP on a missing project or project/account drift.

   List iOS apps in that exact project and revalidate the recorded immutable app
   selection against the evaluated bundle identifier using the same
   deterministic resolver as `/setup-fcm`:

   ```bash
   IOS_MATCH="$(
     npx firebase-tools apps:list IOS --project "<PROJECT_ID>" --json \
       --account "<EMAIL>" |
       node "${PLUGIN_ROOT}/scripts/resolve-firebase-app-identity.js" \
         --project-root . --match-platform ios \
         --identifier "<IOS_BUNDLE_ID>" \
         --selected-app-id "<IOS_APP_ID>"
   )"
   ```

   Omit `--account` only when `/setup-fcm` recorded the confirmed ADC route.
   Require `status == "match"`, `.selectedExplicitly == true`,
   `.app.appId == "<IOS_APP_ID>"`, `.app.platform == "IOS"`, and
   `.app.bundleId == "<IOS_BUNDLE_ID>"`. This remains deterministic when other
   safe registrations have the same bundle ID: only the app ID selected by
   `/setup-fcm` may continue, without a new selection prompt or `apps:create`.
   STOP on `selection-required`, `no-match`, `ambiguous`, `error`, project
   mismatch, or any selected app-ID/platform/bundle drift. In particular,
   `selected-app-id-not-found` means the recorded selection disappeared and
   `selected-app-identity-mismatch` means it now resolves to a different
   platform or identity. Direct the user back to `/setup-fcm`; never fall back
   to another exact-bundle candidate or register a replacement app.
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

   Require `status == "reuse"`. Together with the selected-app resolver result,
   this proves one consistent recorded project/app/platform/bundle/plist
   pairing. Any `invalid`, `conflict`, or `error` means the file is not the
   exact `/setup-fcm` pairing. STOP and direct the user back to `/setup-fcm`;
   never replace the plist or continue to APNs upload.

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

End this workflow with the exact status **configured, device verification
pending** after the manual upload is confirmed and static validation passes.
Do not mark APNs complete here. Route the user to `/build-ios` for a matching
registered-device `development` or `ad-hoc` IPA, then to `/verify-ios-push` for
the physical delivery matrix. Do not duplicate either workflow.

Only `/verify-ios-push` may change the status to physically verified after its
entire physical-device matrix passes. A simulator, Expo Go, Metro, config
validation, successful Firebase Console upload, accepted FCM request, or
foreground-only receipt is not a substitute. Any partial or failed device run
keeps the APNs status **configured, device verification pending**.
