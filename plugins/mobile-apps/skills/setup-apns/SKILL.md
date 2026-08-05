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

1. Verify iOS is a target and the Firebase Messaging modules are runtime-shipped.
2. Resolve the final iOS bundle identifier; it must match the Firebase iOS app.
3. Ask the user to create/select an Apple APNs authentication key and upload it
   in Firebase Console -> Project settings -> Cloud Messaging -> Apple app
   configuration.
4. Capture only confirmation plus Apple Team ID and Key ID for diagnostics.
   Never read, copy, or commit the `.p8` file.
5. Verify `GoogleService-Info.plist` matches the bundle identifier.
6. Verify `app.config.js` includes:
   - `expo-notifications`
   - Firebase app/messaging plugins
   - `aps-environment`
   - `UIBackgroundModes: ['remote-notification']` when background data handling
     is enabled
7. Run `npx expo config --type public`, the push config validator, and changed
   file validation.
8. Record APNs setup status in `memory-bank.md` without secret material.

Do not claim success without a physical-device iOS notification test using a
matching native build.

