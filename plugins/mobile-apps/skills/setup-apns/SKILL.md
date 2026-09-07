---
name: setup-apns
description: Use when manually selecting an APNs authentication key (.p8) or APNs certificate (.p12) and uploading it to Firebase Console for the exact iOS Firebase app after manual Apple setup. Preserves Team, Expo/Firebase bundle, and immutable Firebase app identity; never handles credential files or automates Apple/Firebase portal actions. Use add-push-notifications for runtime integration and verify-ios-push for delivery proof.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Push contract: [push-notifications.md](${PLUGIN_ROOT}/shared/references/push-notifications.md)**.

**Manual Apple identity handoff: [apple-ios-signing-provisioning.md](${PLUGIN_ROOT}/shared/references/apple-ios-signing-provisioning.md)**.

# Set up APNs manually through Firebase

Guide the user through choosing either an APNs authentication key (`.p8`) or an
APNs certificate (`.p12`), preparing it in Apple-controlled interfaces, and
uploading it manually in Firebase Console. FCM on iOS depends on Firebase
Messaging mapping the APNs device token to an FCM registration token;
`expo-notifications` alone is insufficient.

Official references:

- Apple account keys:
  <https://developer.apple.com/help/account/keys/>
- APNs authentication tokens:
  <https://developer.apple.com/help/account/capabilities/communicate-with-apns-using-authentication-tokens/>
- Create a private key:
  <https://developer.apple.com/help/account/keys/create-a-private-key/>
- Apple certificate types:
  <https://developer.apple.com/help/account/certificates/certificates-overview/>
- Create a certificate signing request:
  <https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/>
- Firebase Cloud Messaging for Apple apps, including APNs key upload:
  <https://firebase.google.com/docs/cloud-messaging/ios/get-started#upload_your_apns_authentication_key>

## Non-negotiable boundary

APNs `.p8` authentication keys and `.p12` certificate bundles are credentials.
The user creates or selects, downloads or exports, stores, and uploads the
chosen credential entirely in their own Apple Developer, Keychain/Xcode, and
Firebase Console interfaces.

Never request, accept, read, list, locate, copy, move, inspect, encode, validate,
upload, or persist a `.p8` or `.p12`, its password, contents, derived values,
private key, or local path. Never persist either credential type.
Never request Apple/Firebase credentials, 2FA, sessions, cookies, or screenshots
containing sensitive data. Do not use third-party Apple automation, Apple APIs, Firebase APIs,
Firebase MCP, Firebase CLI, browser automation, portal scraping, or
undocumented endpoints for credential creation or upload. Do not generate,
export, or convert APNs credentials.

The supported routes in this workflow are user-operated Firebase Console upload
of either an APNs authentication key (`.p8`) or an APNs certificate (`.p12`).
The authentication key is recommended because it avoids certificate renewal,
but it is not mandatory and its absence is not a blocker when the user can use
a valid APNs certificate. There is no supported automated Firebase upload in
this workflow.

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

Use `AskUserQuestion` to display the exact identity and ask:

```text
Continue with APNs setup for project <PROJECT_ID>, Firebase iOS app
<FIREBASE_IOS_APP_ID>, Team <TEAM_ID>, and bundle <BUNDLE_ID>?
Choices: Yes / No
```

Continue only on **Yes**. On **No**, stop and route the mismatched identity to
its owning setup skill. This is a user confirmation of continuity, not
Firebase or Apple portal proof.

## Phase 2 — Choose the APNs credential route

Use `AskUserQuestion` with these choices:

```text
Which APNs credential will you upload manually in Firebase Console?
Choices:
- APNs authentication key (.p8, recommended)
- APNs certificate (.p12)
```

Do not block or warn as an error merely because the user selects `.p12`.

### Route A — APNs authentication key (`.p8`)

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
5. The user keeps the safe 10-character Key ID visible for the Firebase step.

If access is missing, agreements block the action, the Team differs, or the key
limit is reached, offer the `.p12` route as a valid alternative when permitted
by the organization's Apple policy and Firebase Console. Do not delete/revoke
another key or switch Teams.

Ask:

```text
Is an APNs authentication key ready for Team <TEAM_ID>, with its Key ID
available for entry directly in Firebase Console?
Choices: Yes / No
```

Continue only on **Yes**. The user may provide the non-secret Key ID for safe
state recording; validate only its 10-character uppercase ASCII letter/digit
format and Team continuity. Never inspect the key.

### Route B — APNs certificate (`.p12`)

Guide the user to create or reuse an Apple Push Services certificate for the
exact App ID `<BUNDLE_ID>` on Team `<TEAM_ID>`. The user creates any required
CSR locally, installs the issued certificate with its matching private key in
Keychain, and exports a password-protected `.p12` to a secure location outside
every repository.

Explain that certificate credentials expire and must be renewed before expiry.
For the selected build modes, the Firebase Console credential must cover the
matching APNs environment: development builds use the sandbox/development
environment; ad-hoc builds use production. Follow the environment labels shown
in Firebase Console and upload every credential required by the approved mode
scope.

Never ask for the certificate name, serial number, fingerprint, password,
private key, file path, or screenshots. If the certificate is for another Team,
App ID, or environment, stop without uploading it.

Ask:

```text
Is an APNs certificate (.p12) ready for Team <TEAM_ID>, bundle <BUNDLE_ID>, and
the APNs environment(s) required by <SELECTED_MODES>?
Choices: Yes / No
```

Continue only on **Yes**.

## Phase 3 — Upload manually to the exact Firebase iOS app

Guide the user to Firebase Console:

1. Open the exact recorded Firebase project.
2. Open Project settings > Cloud Messaging.
3. Locate the exact immutable iOS Firebase app ID and bundle ID from Phase 1.
4. In Apple app configuration, use the upload control for the selected
   credential route:
   - for `.p8`, select the authentication key and enter its Key ID and the exact
     Apple Team ID;
   - for `.p12`, select the APNs certificate entry matching the required
     environment, select the certificate locally, and enter its password only
     in Firebase Console.
5. When the approved modes require more than one environment-specific
   certificate entry, complete each required upload before confirming.

Stop if Firebase Console shows a different project, app ID, bundle ID, or Team
ID. Do not fall back to another same-bundle Firebase app, create a replacement,
replace the plist, or upload to a convenient default.

Ask:

```text
Did Firebase Console accept the selected APNs <CREDENTIAL_TYPE> credential for
project <PROJECT_ID>, app <FIREBASE_IOS_APP_ID>, Team <TEAM_ID>, bundle
<BUNDLE_ID>, and all APNs environments required by <SELECTED_MODES>?
Choices: Yes / No
```

Continue only on **Yes**. On **No**, remain in this phase and troubleshoot only
with non-secret error text that the user chooses to summarize. This attests
that the user completed the Console action. It is not portal read-back or
physical delivery evidence.

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
- credentialType: apns-auth-key # .p8 route; use apns-certificate for .p12
- apnsKeyId: <KEY_ID> # .p8 route only; omit for .p12
- certificateEnvironments: <development|production|development,production> # .p12 route only; omit for .p8
- firebaseConsoleUpload: user-confirmed
- status: configured, device verification pending
- confirmedAt: <ISO-8601 timestamp>
```

The comments above describe conditional fields; do not copy them into
`memory-bank.md`. Do not record key/certificate names, certificate identifiers,
credential contents/paths/passwords, browser evidence, account identity,
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
