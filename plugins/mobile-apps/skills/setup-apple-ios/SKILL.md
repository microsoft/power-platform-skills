---
name: setup-apple-ios
description: Use when preparing Apple Developer signing prerequisites for a Power Apps Expo iOS app, including Fastlane setup, Apple Team access, Certificates/Identifiers/Profiles permissions, blocking agreements, exact explicit iOS bundle-identifier creation/reuse, Push Notifications capability enablement, safe development-device registration, or repairing Apple preflight/identifier drift. This is the required entry point before certificate, profile, or registered-device iOS provisioning work.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Signing/provisioning lanes: [apple-ios-signing-provisioning.md](${PLUGIN_ROOT}/shared/references/apple-ios-signing-provisioning.md)** —
read before keychain, certificate, device, or profile work.

**Retained keychain details: [apple-signing-keychain.md](${PLUGIN_ROOT}/shared/references/apple-signing-keychain.md)**.

**Final handoff contract: [apple-ios-provisioning-contract.md](${PLUGIN_ROOT}/shared/references/apple-ios-provisioning-contract.md)** —
this workflow is complete only when the exact current contract validates.

# Set up Apple iOS prerequisites

Prepare one exact Apple Team/bundle identity, its explicit identifier and Push
capability, retained signing keychain, modern certificates, registered devices,
and installed development/ad-hoc profiles.

Apple provisioning intentionally stays on pinned local Fastlane. Apple does not provide a vendor-official MCP for these Developer Portal operations, and
community/unofficial MCP servers are out of scope.

## Credential and account boundary

Never accept, request, read, paste, echo, log, persist, or remember Apple
account/email, password, 2FA/OTP, session/cookie, app-specific password, or
authentication diagnostics in chat, prompts, arguments, environment variables,
project files, memory, captured output, transcripts, screenshots, or copied
Fastlane errors.

The user enters credentials only into Fastlane's own prompt in their terminal.
Never run an interactive lane through Bash, redirect/pipe it, use `tee`, enable
verbose/debug output, or ask for raw output. Reject `FASTLANE_USER`,
`FASTLANE_PASSWORD`, `FASTLANE_SESSION`, `DELIVER_PASSWORD`, and other external
credential/session routes. The lanes intentionally bypass cached sessions.

Never accept agreements, change legal/billing details, enroll/renew membership,
invite users, change roles, or enable Certificates, Identifiers & Profiles
access. Missing access, membership, or agreements is a hard stop for the
appropriate Apple administrator.

## Phase 1 — Resolve one immutable identity

1. Read `memory-bank.md`, `native-app-plan.md`, `package.json`,
   `app.config.js`, evaluated Expo config, and the `/setup-fcm` handoff.
2. Require macOS and a physical registered-device development/ad-hoc intent.
   Simulator, TestFlight, App Store, enterprise, and store distribution are out
   of scope.
3. Resolve the exact approved 10-character Team ID from the plan.
   `/setup-apple-ios` precedes `/setup-apns`; APNs is not an identity source.
   A typed replacement is not equivalent. Stop on malformed or conflicting
   identity.
4. Run `npx expo config --type public --json`. Require its exact
   `ios.bundleIdentifier` to match the recorded Firebase iOS bundle and the
   validated active `GoogleService-Info.plist`. Reuse `/setup-fcm` validation;
   never select/register another Firebase app here.
5. Print only display name, Team ID, bundle ID, and supported modes—never Apple
   account identity.

## Phase 2 — Scaffold and verify pinned Fastlane

```bash
node "${PLUGIN_ROOT}/scripts/scaffold-apple-fastlane.js" --project-root .
node "${PLUGIN_ROOT}/scripts/check-apple-fastlane-prereqs.js" --project-root .
```

The scaffold owns only `Gemfile`, `Gemfile.lock`, `fastlane/Fastfile`,
`fastlane/README.md`, the Apple helpers, and
`fastlane/lib/apple_signing_keychain.swift`. Reuse identical files.
Customized files block atomically: show relative paths and require exact
`replace apple scaffold: <comma-separated-paths>`, then pass one `--replace`
per approved path.

Require managed Ruby 3.3+, Bundler exactly 4.0.19, Fastlane exactly 2.238.0 in
the Gemfile and matching lockfile. Do not use system Ruby. Ask before any
global/user gem install. Then:

```bash
bundle _4.0.19_ install
bundle exec fastlane --version
```

Every later invocation uses `bundle exec fastlane`, never global/npx Fastlane,
browser automation, or community MCP tooling.

## Phase 3 — Reuse or establish Apple preflight

Validate the final contract first:

```bash
node "${PLUGIN_ROOT}/scripts/validate-apple-ios-provisioning.js" \
  --project-root . --file apple-ios-provisioning.json \
  --expected-team "<TEAM_ID>" --expected-bundle "<BUNDLE_ID>"
```

If current and valid, do not authenticate or recreate anything; record safe
reuse and hand off to `/setup-apns`. If same-identity repair is needed, use the
narrow issue-code lane: keychain -> signing reference Section 1; certificate ->
Section 2; device coverage -> Sections 3–4 with `devices_changed:true`;
profile/APNs/install proof -> Section 4. Wrong Team/bundle is not silently
repairable; preserve it until exact replacement approval.

Otherwise validate:

```bash
node "${PLUGIN_ROOT}/scripts/validate-apple-fastlane-preflight.js" \
  --project-root . --file apple-ios-preflight.json \
  --expected-team "<TEAM_ID>" --expected-bundle "<BUNDLE_ID>"
```

Use one route:

| Route | Action |
|---|---|
| Complete reuse | Final contract validates; stop mutation. |
| Validate/reuse | Current exact preflight validates; do not authenticate. |
| Register/refresh | Proof absent/stale with no identity conflict; user runs preflight. |
| Provision-missing | Valid proof reports `identifier.status=missing`; continue after confirmation. |
| Approved repair | Require exact path/identity-specific approval; never widen/switch identity. |

A proof for another Team/bundle is not refreshable. Preserve it until the user
reconfirms plan identity and explicitly approves replacing only
`apple-ios-preflight.json`.

## Phase 4 — User-owned preflight

Have the user run in their own uncaptured terminal:

```bash
bundle exec fastlane ios apple_preflight \
  team_id:<TEAM_ID> bundle_id:<BUNDLE_ID>
```

For an approved same-identity refresh, append `refresh:true`. The lane proves
Team membership, read-only Certificates/Identifiers/Profiles access without
listing devices, agreement status, and exact identifier presence, then writes
only a one-hour non-secret proof. Never execute/capture it or ask for output.

`APPLE_PREFLIGHT_BLOCKED=agreements`, membership, permission,
authentication, or Apple-service failures stop. Direct the Account Holder or
administrator to Apple; never change the account.

After completion, require the proof file and rerun the validator. Record only
timestamp, Team/bundle, valid-until, read-access proof, clear agreement status,
and identifier present/missing. The validator must reject account/session/
credential content, stale proof, wrong identity, unsafe paths, and symlinks.
Never record account identity or diagnostics.

## Phase 5 — Ensure exact identifier and Push capability

Validate reuse:

```bash
node "${PLUGIN_ROOT}/scripts/validate-apple-identifier-capability.js" \
  --project-root . --file apple-ios-identifier.json \
  --expected-team "<TEAM_ID>" --expected-bundle "<BUNDLE_ID>"
```

Otherwise have the user run:

```bash
bundle exec fastlane ios ensure_identifier_capabilities \
  team_id:<TEAM_ID> bundle_id:<BUNDLE_ID> app_name:<SHELL-SAFE_APP_NAME>
```

This Developer-Portal-only lane reads all accessible teams before writes,
reuses only the exact explicit selected-Team identifier, creates it only when
absent, and enables only Push Notifications. It never invokes App Store
Connect, renames/deletes/wildcard-registers/replaces, switches identity, or
works around wrong-team/case-only/wildcard conflicts.

Permission, membership, agreement, authentication, and Apple-service failures
block without copying raw diagnostics.

No-change reuse writes the safe proof. A required create/capability mutation
returns:

```text
ensure-identifier-capability-<TEAM_ID>-<BUNDLE_ID>
```

Explain exact mutations and require that token—not generic yes—then have the
user rerun with `confirm:<TOKEN>`. Append `refresh:true` only for separately
approved stale same-identity proof replacement. Never capture the lane.

Rerun the validator; require developer-portal-only mode, exact Team/bundle,
explicit iOS identifier, Push enabled, and fresh read-back with no App Store
Connect side effect. Record only those safe fields and expiry.

## Phase 6 — Retained signing and device provisioning

Execute every lane in `apple-ios-signing-provisioning.md` in order unless the
validated final contract's safe issue codes select a narrower repair:

1. retained keychain;
2. modern Apple Development and Distribution certificates;
3. explicitly supplied device registration;
4. development and ad-hoc profile reuse/refresh/install/read-back;
5. final contract validation.

All exact confirmations, `devices_changed:true`, no-revocation policy,
certificate staging/cleanup, UDID secrecy, installed-profile directories, and
read-back gates in that reference are mandatory.

## Completion

Exit 0 and `status: valid` are the only completion condition for:

```bash
node "${PLUGIN_ROOT}/scripts/validate-apple-ios-provisioning.js" \
  --project-root . --file apple-ios-provisioning.json \
  --expected-team "<TEAM_ID>" --expected-bundle "<BUNDLE_ID>"
```

The contract, not a statement that assets exist, is the `/build-ios` handoff.
Route next to `/setup-apns`; its APNs `.p8` creation/upload remains a manual
Apple Developer and Firebase Console path. Never handle that key here.

Run `validate-mobile-files.js` for only the scaffold/proof/memory files this
skill changed:

```bash
node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" --project-root . \
  --file Gemfile --file Gemfile.lock --file fastlane/Fastfile \
  --file fastlane/README.md --file fastlane/lib/apple_preflight.rb \
  --file fastlane/lib/apple_device_input.js \
  --file fastlane/lib/apple_certificates.rb \
  --file fastlane/lib/apple_identifier.rb \
  --file fastlane/lib/apple_profiles.rb \
  --file fastlane/lib/apple_signing_keychain.swift \
  --file apple-ios-preflight.json --file apple-ios-identifier.json \
  --file apple-ios-certificates.json --file apple-ios-provisioning.json \
  --file memory-bank.md
```

Omit unchanged files and omit `memory-bank.md` when no safe state was written.
