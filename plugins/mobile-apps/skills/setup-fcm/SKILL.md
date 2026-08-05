---
name: setup-fcm
description: Use when configuring Firebase Cloud Messaging for a Power Apps Expo mobile app on Android or iOS, including Firebase client files, FCM registration tokens, topic subscriptions, Entra OID topics, allUsers, or repairing Firebase messaging configuration.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Push contract: [push-notifications.md](${PLUGIN_ROOT}/shared/references/push-notifications.md)**.

# Setup FCM

Configure client-side Firebase Messaging without storing server credentials.

1. Verify the app and the four required template dependencies.
2. Ask for or locate the Firebase project ID and platform client files:
   - Android: `google-services.json`
   - iOS: `GoogleService-Info.plist`
3. Validate that Android package and iOS bundle identifiers match
   `app.config.js`/the selected build identity.
4. Copy only the two client configuration files into a user-approved path inside
   the project. These files contain client identifiers, not the Firebase Admin
   private key.
5. Set `GOOGLE_SERVICES_JSON` and `GOOGLE_SERVICE_INFO_PLIST` through the
   project's documented build environment/config. Do not hard-code an absolute
   machine path.
6. Verify `app.config.js` contains the React Native Firebase app and messaging
   plugins and the matching service-file fields.
7. Record the exact topic policy (`allUsers` and the validated lowercase Entra
   OID) and the accepted client-subscription security risk in `memory-bank.md`.
8. Run `npx expo config --type public`, `npx tsc --noEmit`, the push config
   validator, and changed-file validation.

Never request, copy, or commit a Firebase service-account private-key JSON. The
sender flow uses keyless Google Workload Identity Federation.
