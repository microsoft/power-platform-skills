---
name: setup-apns
description: Use when manually creating or reusing an Apple APNs authentication key and uploading it to Firebase Console for the exact iOS Firebase app after manual Apple setup. Preserves Team, Expo/Firebase bundle, and immutable Firebase app identity; never handles the .p8 key or automates Apple/Firebase portal actions. Use add-push-notifications for runtime integration and verify-ios-push for delivery proof.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Push contract: [push-notifications.md](${PLUGIN_ROOT}/shared/references/push-notifications.md)**.

**Manual Apple identity handoff: [apple-ios-signing-provisioning.md](${PLUGIN_ROOT}/shared/references/apple-ios-signing-provisioning.md)**.

# Set up APNs manually through Firebase

Guide the user through APNs authentication-key creation/reuse in Apple Developer
and manual upload in Firebase Console. FCM on iOS depends on Firebase Messaging
mapping the APNs device token to an FCM registration token;
`expo-notifications` alone is insufficient.

Official references:

- Apple account keys:
  <https://developer.apple.com/help/account/keys/>
- APNs authentication tokens:
  <https://developer.apple.com/help/account/capabilities/communicate-with-apns-using-authentication-tokens/>
- Create a private key:
  <https://developer.apple.com/help/account/keys/create-a-private-key/>
- Firebase Cloud Messaging for Apple apps, including APNs key upload:
  <https://firebase.google.com/docs/cloud-messaging/ios/get-started#upload_your_apns_authentication_key>

## Non-negotiable boundary

The APNs `.p8` is a credential. The user creates or selects, downloads, stores,
and uploads it entirely in their own Apple Developer and Firebase Console
browser sessions.

Never request, accept, read, list, locate, copy, move, inspect, encode, validate,
upload, or persist the `.p8`, its contents, derived values, or local path.
Never persist the `.p8`.
Never request Apple/Firebase credentials, 2FA, sessions, cookies, or screenshots
containing sensitive data. Do not use third-party Apple automation, Apple APIs, Firebase APIs,
Firebase MCP, Firebase CLI, browser automation, portal scraping, or
undocumented endpoints for key creation or upload. Do not generate APNs
certificates or `.p12` files.

The only supported Firebase credential route in this workflow is the user's
manual APNs authentication-key upload. There is no supported automated Firebase
upload in this workflow.

This skill does not manage App IDs, Push capability, devices, signing
certificates, or provisioning profiles. Route those to `/setup-apple-ios`.

## Phase 1 — Consume the `/setup-fcm` handoff and re-establish identity

1. Read the `/setup-fcm` handoff and the `Apple iOS manual setup
   (user-confirmed; not portal proof)` block from `memory-bank.md`.
2. Require the Firebase project ID, immutable selected Firebase iOS app ID,
   Firebase iOS bundle identifier, evaluated plist path, Apple Team ID, and
   explicit App ID/Push user confirmations. Do not reconstruct missing values.
   STOP if any field is absent.
3. Run `npx expo config --type public --json` to evaluate the local
   `ios.bundleIdentifier` and `ios.googleServicesFile`.
4. Require exact equality among:
   - Expo bundle identifier;
   - `/setup-fcm` Firebase iOS bundle identifier;
   - Apple manual setup bundle identifier.
5. Require the evaluated plist path to equal the path recorded by `/setup-fcm`,
   resolve inside the project root, and refer to a regular non-symlink file.
   Only the bounded local validators may parse its non-secret project, app, and
   bundle identity fields. Do not print raw plist contents or inspect unrelated
   fields.
6. Require the Apple Team ID to be exactly 10 uppercase ASCII letters/digits.
   Display only project ID, immutable Firebase app ID, bundle ID, plist path,
   and Team ID.

Stop on missing state or drift. Preserve all recorded values and route Firebase
or plist identity issues to `/setup-fcm`; route Apple Team, App ID, or Push
confirmation issues to `/setup-apple-ios`. A newly typed Team, bundle, or
Firebase app ID is not a repair.

Require:

```text
confirm APNs identity: <PROJECT_ID> <FIREBASE_IOS_APP_ID> <TEAM_ID> <BUNDLE_ID>
```

This is a user confirmation of continuity, not Firebase or Apple portal proof.

## Phase 2 — Create or reuse the APNs authentication key manually

Guide the user to <https://developer.apple.com/account/resources/authkeys/list>
while signed into the exact confirmed Team ID.

1. Prefer reusing an existing APNs-capable key when the organization knows it
   is active, securely retained, and appropriate for this Firebase project.
2. Otherwise guide an authorized user to create a key with Apple Push
   Notifications service enabled. Do not enable unrelated services.
3. Remind the user that the `.p8` can be downloaded only once and Apple account
   key limits may apply.
4. The user downloads it directly to a secure, user-controlled location outside
   this and every other repository. They must not provide its path or contents.
   Keep the one-time download outside this and every other repository.
5. The user keeps the safe 10-character Key ID visible for the next manual
   portal step. The Key ID is not the key.

If access is missing, agreements block the action, the Team differs, or the key
limit is reached, stop for the Account Holder or Apple administrator. Do not
delete/revoke another key or switch Teams.

Require:

```text
confirm APNs key selected: <TEAM_ID> keyId=<KEY_ID>
```

Validate only the format of Team ID and Key ID as 10 uppercase ASCII
letters/digits and exact Team continuity. Do not validate or inspect the key.

## Phase 3 — Upload manually to the exact Firebase iOS app

Guide the user to Firebase Console:

1. Open the exact recorded Firebase project.
2. Open Project settings > Cloud Messaging.
3. Locate the exact immutable iOS Firebase app ID and bundle ID from Phase 1.
4. In Apple app configuration, upload the APNs authentication key.
5. The user selects the `.p8` locally and enters the safe Key ID and the exact
   Apple Team ID.

Stop if Firebase Console shows a different project, app ID, bundle ID, or Team
ID. Do not fall back to another same-bundle Firebase app, create a replacement,
replace the plist, or upload to a convenient default.

Require:

```text
confirm Firebase APNs upload: <PROJECT_ID> <FIREBASE_IOS_APP_ID> <TEAM_ID> <BUNDLE_ID> keyId=<KEY_ID>
```

This attests that the user completed the Console action. It is not portal
read-back or physical delivery evidence.

## Phase 4 — Static app checks and safe state

Verify local, non-secret app configuration includes:

- `expo-notifications`;
- Firebase app and messaging plugins;
- the intended `aps-environment`;
- `UIBackgroundModes: ['remote-notification']` when background data handling is
  enabled.

Run the existing push configuration validator and changed-file validation
appropriate to files actually changed. Static checks do not validate the
credential or its upload.

For each selected build mode, use the matching non-secret environment:

```bash
APNS_ENVIRONMENT="<development|production>" \
  node "${PLUGIN_ROOT}/scripts/validate-push-notification-config.js" \
    --project-root .
```

Use `development` for a development profile and `production` for an ad-hoc
profile. Do not run strict client-integration validation here because
`/add-push-notifications` owns the runtime wrapper and may not have run yet.

After the exact upload confirmation and static checks, update
`memory-bank.md` with only:

```markdown
## APNs manual setup (user-confirmed; not portal proof)
- confirmationBasis: user-confirmed
- portalProof: false
- firebaseProjectId: <PROJECT_ID>
- firebaseIosAppId: <FIREBASE_IOS_APP_ID>
- bundleIdentifier: <BUNDLE_ID>
- appleTeamId: <TEAM_ID>
- apnsKeyId: <KEY_ID>
- firebaseConsoleUpload: user-confirmed
- status: configured, device verification pending
- confirmedAt: <ISO-8601 timestamp>
```

Do not record key name, key contents/path, browser evidence, account identity,
credentials, or diagnostics.

## Completion and separation

End with exactly:

```text
APNs manual setup user-confirmed; not portal proof.
Status: configured, device verification pending.
```

Do not mark APNs physically verified. Return to `/add-push-notifications` for
native client integration, then sender authentication and
`/create-push-notification-flow`, `/build-ios`, and `/verify-ios-push`.

Only `/verify-ios-push` may mark physical delivery verified after its complete
physical-device matrix. Firebase Console upload, static checks, simulator,
Expo Go, Metro, accepted FCM request, or foreground-only receipt are not
delivery proof.
