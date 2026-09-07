---
name: setup-apple-ios
description: Use when manually preparing Apple Developer and local Xcode signing prerequisites for a Power Apps Expo iOS app. Membership/access and agreements, exact explicit App ID, Push Notifications, physical devices, Apple Development and Apple Distribution certificates, development/ad-hoc profiles, or Team/bundle drift. This is the required guided entry point before APNs or registered-device iOS builds; it never automates Apple or handles credentials.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Manual signing/provisioning guide: [apple-ios-signing-provisioning.md](${PLUGIN_ROOT}/shared/references/apple-ios-signing-provisioning.md)** —
read and follow in full.

# Set up Apple iOS manually

Guide the user through Apple Developer and local macOS/Xcode setup for one exact
Team and bundle identity. This skill coordinates a manual checklist; it does
not operate Apple Developer, inspect signing assets, or manufacture proof.

## Non-negotiable boundaries

- Do not use or install third-party Apple automation tooling.
- Do not call Apple APIs, App Store Connect APIs, community MCP servers,
  browser automation, portal scraping, or undocumented endpoints.
- Do not automate signing keychains or inspect Keychain/Xcode signing assets
  with scripts.
- Do not create or validate generated Apple proof files.
- Never request or handle Apple credentials, 2FA, sessions, device UDIDs,
  certificate private keys, `.p12` files, profile contents/UUIDs, or APNs
  `.p8` material.
- Never accept agreements, alter membership/access, revoke certificates,
  remove devices, or create an App Store Connect listing.

All account, portal, device, certificate, profile, and Xcode interactions are
performed by the user in interfaces they control. Present one section at a
time, then use `AskUserQuestion` with explicit **Yes** and **No** choices to ask
whether the displayed instructions were completed for the displayed Team,
bundle, and mode scope. Never ask the user to type a confirmation phrase.

## Phase 1 — Resolve immutable identity and scope

1. Read `memory-bank.md`, `native-app-plan.md`, `package.json`,
   `app.config.js`, and the `/setup-fcm` handoff.
2. Require macOS plus a physical registered-device development and/or ad-hoc
   intent. Simulator, TestFlight, App Store, enterprise, and store distribution
   are out of scope.
3. Run `npx expo config --type public --json` only to evaluate local,
   non-secret app configuration. Resolve the exact `ios.bundleIdentifier`.
4. Require it to exactly equal the bundle identifier and selected Firebase iOS
   app identity recorded by `/setup-fcm`. Do not select or register Firebase
   apps here.
5. Resolve the approved 10-character uppercase Apple Team ID from the plan or
   existing safe memory state. A Team selected by default in Xcode or Apple
   Developer is not an identity source.
6. Display only app display name, Team ID, bundle ID, and supported modes.

Stop before portal changes if Team or bundle identity is missing, malformed, or
conflicting. Route Firebase/Expo drift to `/setup-fcm` or the owning plan step;
never repair it by changing Apple resources. Require an explicit approved plan
change before replacing previously recorded Team identity.

Use `AskUserQuestion` to display the resolved Team ID, bundle ID, and approved
development and/or ad-hoc scope, then ask:

```text
Continue with this Apple identity and registered-device build scope?
Choices: Yes / No
```

Continue only on **Yes**. A **No** response stops before portal changes and
returns to identity or scope correction. This is a user confirmation of the
displayed local identity, not Apple portal proof.

## Phase 2 — Guide every manual section

Follow `apple-ios-signing-provisioning.md` in order:

1. active membership, Certificates/Identifiers/Profiles access, and agreements;
2. exact explicit App ID and Push Notifications capability;
3. intended physical-device registration without receiving UDIDs;
4. Apple Development certificate and development profile when development is
   selected;
5. Apple Distribution certificate and ad-hoc profile when ad-hoc is selected;
6. current Xcode installation and local signing availability.

Skip only certificate/profile sections for modes that are not in the approved
scope; never require distribution assets for development-only setup or
development assets for ad-hoc-only setup. For each applicable section, provide
the official Apple URL, restate the exact Team and bundle identity, explain
sensitive values the user must keep out of chat, and use `AskUserQuestion` to
ask whether that section is complete with **Yes** and **No** choices. Advance
only on **Yes**. On **No**, keep the workflow at that section, explain the safe
remediation or owner, and do not claim later sections complete. A blocked
agreement, missing role, quota, identifier conflict, device limit, absent
private key, profile mismatch, or Xcode identity drift stops the workflow at
that section.

## Phase 3 — Record safe user-confirmed state

Only after every applicable section confirmation, update `memory-bank.md` with
the mode-aware safe template in the shared guide. The heading and fields must
explicitly say:

```text
user-confirmed; not portal proof
confirmationBasis: user-confirmed
portalProof: false
```

Store only Team ID, bundle ID, selected mode scope, registered-device
scope/count, applicable section statuses, and confirmation timestamp. Omit
certificate/profile fields for unselected modes. Do not store account identity,
UDIDs/device names, certificate/profile identifiers, paths, credentials,
screenshots, or copied portal output.

This memory state is a resumable manual checklist, not Apple read-back and not
build readiness proof. Never use words such as verified, validated, or proven
for Apple portal state.

## Completion

Complete only when all manual sections received **Yes** confirmation for the
same Team ID, bundle ID, and approved mode scope and the safe memory block has
been written. Report:

```text
Apple iOS manual setup user-confirmed; not portal proof.
Scope: registered-device <SELECTED_MODES>.
Next owner: /setup-apns.
```

`/setup-apns` separately owns the manual choice and Firebase Console upload of
either an APNs authentication key (`.p8`) or APNs certificate (`.p12`).
`/build-ios` owns current local signing preflight and build output;
`/verify-ios-push` owns physical delivery evidence.

Run changed-file validation only for `memory-bank.md` when this skill changed it:

```bash
node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" \
  --project-root . --file memory-bank.md
```
