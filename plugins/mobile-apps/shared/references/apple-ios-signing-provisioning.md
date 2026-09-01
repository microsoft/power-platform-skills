# Apple retained signing and registered-device provisioning

Canonical `/setup-apple-ios` lanes for the retained project keychain, modern
signing certificates, explicit device registration, and installed development
and ad-hoc profiles. These lanes support physical registered-device builds
only—not simulator, TestFlight, App Store, enterprise, or store distribution.

All interactive Fastlane lanes run only in the user's own uncaptured terminal.
Never execute them with Bash, redirect/pipe them, use `tee`, enable debug
output, or request raw output. Use only pinned `bundle exec fastlane`.

## 1. Retained project signing keychain

Read `apple-signing-keychain.md`, then create or reuse:

```bash
node "${PLUGIN_ROOT}/scripts/manage-apple-signing-keychain.js" \
  --project-root . --timeout 3600
```

The helper generates the password in-process, stores/retrieves it only as a
generic-password item in login Keychain, and never exposes it in argv,
environment, files, logs, or transcripts. It rejects repository/symlink paths
and fails closed on missing, mismatched, or corrupt retained state.

Offer only the reference's explicit paired recovery; never silently delete
either retained asset. Record only `serviceIdentifier` and `pathFingerprint`,
never the raw external path. Every later command needing signing material must
use the same helper with `-- <absolute-command>` so the previous search list is
restored on success or failure.

## 2. Modern signing certificates

Have the user run:

```bash
node "${PLUGIN_ROOT}/scripts/manage-apple-signing-keychain.js" \
  --project-root . --timeout 3600 -- \
  /usr/bin/env bundle exec fastlane ensure_signing_certificates \
  team_id:<TEAM_ID>
```

The lane reads only the exact team's portal certificates and proves private-key
usability in the dedicated keychain. Consider only modern `Apple Development`
and `Apple Distribution`. Reuse an identity expiring more than 30 days away;
otherwise propose creation with exact token:

```text
ensure-signing-certificates-<TEAM_ID>
```

Only after exact confirmation may the user rerun with
`confirm:ensure-signing-certificates-<TEAM_ID>`. Fastlane `cert` uses
`generate_apple_certs:true`; absent identity uses `force:false`, while an
explicitly approved near-expiry renewal uses pinned Fastlane 2.238.0 with
`force:true` to create a replacement without revocation.

Never revoke/delete a certificate. Apple quota is a hard stop for an
administrator decision. Transport certificate/private-key files may exist only
in a unique mode-0700 OS staging directory outside repositories and must be
removed on success/failure. Suppress Fastlane/security output that can disclose
names, hashes, paths, or signing commands.

Require `apple-ios-certificates.json` containing only Team ID, renewal window,
resource ID, safe type, expiry, reused/created action, and dedicated-keychain
usability proof. It must not contain names/hashes, private-key/keychain paths,
passwords, or commands.

## 3. Explicit development-device registration

This lane is additive and idempotent. It never displays inventory, disables or
removes devices, or manages certificates/profiles. The user runs:

```bash
bundle exec fastlane register_apple_devices
```

Never accept a UDID in chat, `AskUserQuestion`, lane options, argv, environment,
command history, project files, fixtures, logs, screenshots, memory, plans, or
handoffs.

The lane requires the approved Team ID and matching preflight, then offers:

- **single:** prompt for ordinary display name/platform; read UDID only through
  a non-echoing terminal prompt;
- **external-batch:** absolute JSON, CSV, or Apple tab-delimited file path.
  Require a regular non-symlink file outside every Git repository.

The converter validates names, iOS platform, accepted 40-hex and 8-hex/16-hex
UDIDs, limits, duplicate identifiers, and duplicate-name conflicts. It creates
a mode-0600 Apple-compatible file in a unique mode-0700 OS temporary directory
outside repositories. Confirmation exposes only aggregate counts and last-four
masks; batch registration needs explicit confirmation.

Suppress action output. Require exact matched count and `enabled=true`. Stop on
wrong Team, malformed input, duplicates, device limits, Apple failure, disabled
matches, count mismatch, or missing confirmation. Cleanup runs on success and
failure. Record at most Team ID, timestamp, count, and enabled state—never
names, masks, or identifiers.

## 4. Development and ad-hoc profiles

Have the user run:

```bash
node "${PLUGIN_ROOT}/scripts/manage-apple-signing-keychain.js" \
  --project-root . --timeout 3600 -- \
  /usr/bin/env bundle exec fastlane ensure_provisioning_profiles \
  team_id:<TEAM_ID> bundle_id:<BUNDLE_ID>
```

The lane validates current identifier/certificate proofs, Team/bundle,
dedicated keychain, and complete enabled-device count. It uses
`get_provisioning_profile`/sigh with the exact bundle, Team, and certificate
resource ID, attempting read-only reuse first.

A missing, expired, stale-device, wrong-certificate, wrong-mode,
wrong-Team/bundle, or wrong-APNs profile requires a narrow force refresh. Show
the lane's exact token containing Team ID, bundle ID, enabled-device count, and
`development`, `ad-hoc`, or both. A generic yes is not approval. Only after the
exact token is confirmed may the wrapped command be rerun with
`confirm:<TOKEN> refresh:true`.

After device registration, the next run must include `devices_changed:true`;
this forces explicit refresh approval for both registered-device profiles and
their exact count/scope.

The lane decodes metadata in process and never prints profile contents,
certificate bytes, device IDs, or raw paths. Require:

- exact application identifier, Team, and bundle;
- development: `get-task-allow:true`,
  `aps-environment:development`;
- ad hoc: `get-task-allow:false`, `aps-environment:production`;
- intended modern certificate resource ID/type;
- expiry beyond the proof window;
- exact enabled-device count.

Install only verified profiles to the directory for the selected Xcode:

- Xcode 16+: `~/Library/Developer/Xcode/UserData/Provisioning Profiles`
- older Xcode: `~/Library/MobileDevice/Provisioning Profiles`

Never copy a profile into the project. Read back and reverify installation.
Stop on stale coverage, wrong certificate/APNs/mode/Team/bundle, expiry,
disabled devices, or install failure.

## 5. Completion contract

Emit `apple-ios-provisioning.json` only after identifier, Push capability,
keychain, both modern certificate identities, both installed profiles, and
device-count proofs validate. Its safe fields are limited to Team/bundle,
keychain service/fingerprint, certificate resource IDs/types/expiry, and
profile UUID/type/expiry/count/certificate proof.

```bash
node "${PLUGIN_ROOT}/scripts/validate-apple-ios-provisioning.js" \
  --project-root . --file apple-ios-provisioning.json \
  --expected-team "<TEAM_ID>" --expected-bundle "<BUNDLE_ID>"
```

Exit `0` and `status: valid` are required. This contract—not manual
confirmation—is the build handoff. Route next to `/setup-apns`.
