---
name: setup-apns
description: Use when configuring, validating, or repairing the APNs credential handoff for the exact iOS Firebase app after Apple provisioning. Owns Apple Team/bundle/Push-capability continuity and the supported manual APNs p8 upload in Firebase Console; use add-push-notifications for app entitlements/runtime/topics and verify-ios-push for physical delivery troubleshooting.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, mcp__firebase__firebase_get_environment, mcp__firebase__firebase_login, mcp__firebase__firebase_update_environment, mcp__firebase__firebase_list_projects, mcp__firebase__firebase_get_project, mcp__firebase__firebase_list_apps
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Push contract: [push-notifications.md](${PLUGIN_ROOT}/shared/references/push-notifications.md)**.

**Firebase MCP provisioning: [firebase-mcp-provisioning.md](${PLUGIN_ROOT}/shared/references/firebase-mcp-provisioning.md)** —
use the read-only identity and project checks here whenever the `/setup-fcm`
Firebase MCP session state is unavailable.

**Official MCP readiness: [official-mcp-servers.md](${PLUGIN_ROOT}/shared/references/official-mcp-servers.md)** —
use the `/setup-apns` row as a hard preflight for Firebase MCP availability.

# Setup APNs through Firebase

FCM topics work on iOS because Firebase Messaging maps the APNs device token to
an FCM registration token. `expo-notifications` alone is insufficient.

## MCP readiness gate

Before any Firebase identity/project/app read-back in this workflow, verify the
official Firebase MCP surface required by `/setup-apns`. If the `firebase`
server is missing, disconnected, or any required tool from the shared
official-MCP readiness table is unavailable, STOP and give these Copilot CLI
steps in this exact order:

```text
/mcp
/setup
/restart
/mcp
```

Require the second `/mcp` check to show `firebase` connected with the required
Firebase tools before continuing. Do not fall back to `firebase-tools`, raw
REST, browser automation, or guessed Firebase Console behavior.

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
5. Reuse the Firebase MCP authenticated user confirmed by `/setup-fcm`. If that
   session state is not available in the current session, rerun the read-only
   identity preflight from `firebase-mcp-provisioning.md`: use only
   `mcp__firebase__firebase_get_environment`,
   `mcp__firebase__firebase_update_environment`, and
   `mcp__firebase__firebase_login` to restore the exact intended account. Do not
   infer or switch accounts outside those tools.

   Rerun `mcp__firebase__firebase_list_projects` with `{ "page_size": 1000 }`
   and page until the exact recorded project ID appears or the list is
   exhausted. Require the intended authenticated user to see that project ID in
   the latest MCP result, then activate it with:

   ```json
   {
     "active_project": "<PROJECT_ID>"
   }
   ```

   Call that payload with `mcp__firebase__firebase_update_environment`, then
   call `mcp__firebase__firebase_get_project` with `{}` and require the returned
   current project to match the recorded `projectId`.

   Next, call `mcp__firebase__firebase_list_apps` with:

   ```json
   {
     "platform": "ios"
   }
   ```

   Write the **exact text result** from the MCP tool to
   `firebase/.ios-apps.mcp.yaml`, then revalidate the recorded immutable app
   selection against the evaluated bundle identifier using the same
   deterministic resolver as `/setup-fcm`:

   ```bash
   node "${PLUGIN_ROOT}/scripts/resolve-firebase-app-identity.js" \
     --project-root . --input firebase/.ios-apps.mcp.yaml \
     --match-platform ios \
     --identifier "<IOS_BUNDLE_ID>" \
     --selected-app-id "<IOS_APP_ID>"
   ```

   Require `status == "match"`, `.selectedExplicitly == true`,
   `.app.appId == "<IOS_APP_ID>"`, `.app.platform == "IOS"`, and
   `.app.bundleId == "<IOS_BUNDLE_ID>"`. This remains deterministic when other
   safe registrations have the same bundle ID: only the app ID selected by
   `/setup-fcm` may continue, without a new selection prompt or app creation.
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
   rm -f -- firebase/.ios-apps.mcp.yaml
   ```

   Require `status == "reuse"`. Together with the selected-app resolver result,
   this proves one consistent recorded project/app/platform/bundle/plist
   pairing. Any `invalid`, `conflict`, or `error` means the file is not the
   exact `/setup-fcm` pairing. STOP and direct the user back to `/setup-fcm`;
   never replace the plist or continue to APNs upload.

## Phase 2 — Consume the Apple identifier/team handoff

The APNs authentication key must belong to the same Apple Team that owns the
exact explicit iOS identifier. Prove that identity before asking the user to
create or upload any credential.

1. Read the approved Apple Team ID recorded by `/setup-apple-ios` in
   `memory-bank.md`. Require exactly 10 uppercase ASCII letters or digits.
   STOP if it is absent or conflicts with another recorded Team ID; a newly
   typed Team ID is not a replacement for the approved handoff.
2. Validate the project-local identifier/capability proof against that Team ID
   and the already-validated Firebase/Expo bundle ID:

   ```bash
   node "${PLUGIN_ROOT}/scripts/validate-apple-identifier-capability.js" \
     --project-root . --file apple-ios-identifier.json \
     --expected-team "<APPLE_TEAM_ID>" \
     --expected-bundle "<IOS_BUNDLE_ID>"
   ```

   Require exit `0`, `status == "valid"`, the exact expected Team ID and bundle
   ID, and successful explicit-identifier and Push Notifications read-back.
   The validator also enforces a current proof, a safe project-local
   non-symlink file, and no Apple account or credential content.
3. Validate the completed Apple provisioning handoff as well:

   ```bash
   node "${PLUGIN_ROOT}/scripts/validate-apple-ios-provisioning.js" \
     --project-root . --file apple-ios-provisioning.json \
     --expected-team "<APPLE_TEAM_ID>" \
     --expected-bundle "<IOS_BUNDLE_ID>"
   ```

   Require a fresh valid contract proving the retained keychain, modern
   Development/Distribution identities, registered-device coverage, and
   installed development/ad-hoc profiles. Do not replace this with manual
   confirmation and do not print profile UUIDs, certificate names, or device
   identifiers.
4. STOP on a missing, stale, invalid, wrong-Team, or wrong-bundle handoff.
   Preserve the Firebase selection and route the user to `/setup-apple-ios`;
   never repair the mismatch by changing the Firebase app, Expo bundle ID,
   Apple Team ID, or identifier inside this workflow.

## Phase 3 — Guided APNs authentication-key handoff

APNs authentication keys are Apple credentials. Their creation and upload stay
inside the user's Apple Developer and Firebase Console browser sessions; this
skill must not automate either action.

The only supported Firebase credential route is a manually uploaded Apple APNs
authentication key (`.p8`). Do not use Fastlane `pem`, generate or upload an
APNs certificate/`.p12`, automate either website, call undocumented endpoints,
or substitute certificate-based APNs credentials. There is no supported
Firebase MCP, Firebase CLI, or Firebase Management API operation for uploading
an APNs authentication key; Firebase Console is the required handoff.

1. Guide the user to Apple Developer -> Certificates, Identifiers & Profiles ->
   Keys while signed into the **exact validated Apple Team ID** from Phase 2.
   Have them select an existing APNs-capable authentication key for that Team or
   explicitly create one with Apple Push Notifications service enabled. Do not
   create a key on another visible Team. Remind them that Apple permits the
   `.p8` download only once and that account key limits may apply.
2. Tell the user to download the `.p8` themselves, once, into a secure
   user-controlled location outside this and every other repository. They must
   never paste it into chat, provide its path, or place it in a project. The
   agent must not request, read, list, copy, move, inspect, encode, validate, or
   upload the `.p8`, including through `Read`, `Bash`, Fastlane, Apple APIs,
   browser automation, Firebase MCP, Firebase CLI, Firebase APIs, or an
   undocumented endpoint.
3. Guide the user to Firebase Console -> the exact recorded Firebase project ->
   Project settings -> Cloud Messaging -> the **exact immutable iOS app ID and
   bundle ID validated in Phase 1** -> APNs authentication key. The user
   manually uploads the `.p8` and enters its Key ID and the exact Apple Team ID
   validated in Phase 2. Do not continue if the Console app or either identifier
   differs.
4. Ask only for confirmation that the manual upload succeeded plus the safe Key
   ID and Team ID. Require the Key ID and Team ID to each be exactly 10 uppercase
   ASCII letters or digits, and require the Team ID to equal the validated
   handoff. These identifiers are not the key. Never persist the `.p8`, its
   contents, a derived value, a local path, or browser/session evidence. If the
   user asks for Fastlane `pem`, `.p12` generation, browser automation, Firebase
   MCP upload, Firebase CLI/API upload, or undocumented endpoints, decline that
   unsupported portion and continue only with the manual `.p8` Console steps.

## Phase 4 — App configuration and verification

1. Verify `app.config.js` includes:
   - `expo-notifications`
   - Firebase app/messaging plugins
   - `aps-environment`
   - `UIBackgroundModes: ['remote-notification']` when background data handling
     is enabled
2. Run `npx expo config --type public`, the push config validator, and changed
   file validation.
3. Record APNs setup status in `memory-bank.md` using only the verified Firebase
   project/app/bundle identity, validated Apple identifier handoff, Key ID,
   matching Team ID, manual-upload confirmation, and confirmation timestamp.
   Do not record the key name if it may reveal user or organization data.

End this workflow with the exact status **configured, device verification
pending** after the manual upload is confirmed and static validation passes.
Do not mark APNs complete here. Return to `/add-push-notifications` to complete
the native client, then follow sender authentication and
`/create-push-notification-flow`, `/build-ios`, and `/verify-ios-push`. Do not
duplicate any owner workflow.

Only `/verify-ios-push` may change the status to physically verified after its
entire physical-device matrix passes. A simulator, Expo Go, Metro, config
validation, successful Firebase Console upload, accepted FCM request, or
foreground-only receipt is not a substitute. Any partial or failed device run
keeps the APNs status **configured, device verification pending**.
