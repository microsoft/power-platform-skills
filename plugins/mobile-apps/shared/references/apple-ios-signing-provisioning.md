# Manual Apple signing and registered-device provisioning

Canonical manual guidance for `/setup-apple-ios`. This workflow supports only
physical, registered-device development and ad-hoc builds. Simulator, TestFlight,
App Store, enterprise, and store distribution are outside its scope.

Apple Developer and Xcode actions are performed by the user in their own browser
and local macOS UI. Do not use third-party Apple tooling, Apple APIs, browser
automation, portal scraping, or signing-keychain automation. Do not create
generated Apple proof files.
The agent coordinates identity, sequencing, and safe confirmations; it does not
claim portal proof.

## Internal orchestrated owner contract

The existing direct mode remains interactive and user-owned. Internal push
orchestration validates the combined Apple-before-APNs envelope through the
exact internal `mobile-app:push-ios-prerequisites-worker` contract below. When
worker dispatch is unavailable, `/setup-apns` is the single combined fallback
owner: it applies this `/setup-apple-ios` guide first, then its APNs guide, and
returns one final iOS worker result. Do not invoke `/setup-apple-ios`
separately in that fallback or emit an intermediate Apple result. This is not
a new user-facing command.

The operation is a normal prompt field, never a `Task` API mode. Every prompt
starts with:

```yaml
contract_version: 1
run_id: <opaque parent-generated id>
working_dir: <canonical absolute project root>
plugin_root: <absolute plugin root>
worker_name: mobile-app:push-ios-prerequisites-worker
operation: preflight|execute
```

For `operation: preflight`, that common envelope is complete. It must inspect
no project state, access no memory, make no network/cloud call, acquire no
ownership, and read/write no file.

For `operation: execute`, also require:

```yaml
memory_bank_path: <working_dir>/memory-bank.md
memory_bank_sha256: <pre-wave hash>
exclusive_files: []
decision_envelope:
  firebase_project_id: <exact>
  firebase_ios_app_id: <exact>
  bundle_identifier: <exact>
  plist_path: <exact absolute active plist path>
  apple_team_id: <10 uppercase ASCII letters/digits>
  selected_modes: development|ad-hoc|development,ad-hoc
  apple_confirmations:
    identity: true
    explicit_app_id: true
    push_capability: true
    intended_devices_registered: true
    development_certificate: true|not-applicable
    development_profile: true|not-applicable
    distribution_certificate: true|not-applicable
    ad_hoc_profile: true|not-applicable
    local_xcode_signing: true
  apns_method: p8|p12
  apns_key_id: <safe id or null>
  certificate_environments: development|production|development,production|null
  firebase_console_upload_confirmed: true
  apple_confirmed_at: <UTC timestamp>
  apns_confirmed_at: <UTC timestamp>
```

Resolve `working_dir` and `plist_path` with `realpath`; require the first to be
the current project and the second to be the exact regular non-symlink active
plist inside it. Require Firebase project/app/plist identity, evaluated Expo
bundle, Apple Team, selected mode set, and safe existing handoff state to
remain exact. Do not substitute a convenient project, same-bundle Firebase
app, active Xcode Team, portal default, remembered value, or newly typed
identity. Verify `memory_bank_sha256` at start and before return; the hash is a
concurrency guard, not permission to source missing decisions from memory.

The iOS prerequisite worker is credential-blind and read-only.
`exclusive_files` must be empty. It may read bounded local non-secret identity,
run the existing local identity/config validator, and consume parent-supplied
safe confirmations. It must not mutate project files, `memory-bank.md`,
Apple/Firebase portals, cloud resources, Keychain, Xcode signing state,
credentials, profiles, or devices. All manual Apple and Firebase Console
actions remain user-operated and parent-coordinated.

Worker-mode protocol:

1. Never call `AskUserQuestion`. If a required decision or user attestation is
   absent, ambiguous, stale, or newly required, return
   `NEEDS_CONTEXT: <exact missing parent decision>` as the literal first line.
   Never infer Yes, choose a credential route, or expand the selected modes.
2. Return `BLOCKED: <safe identity mismatch>` for project/environment,
   Firebase app/plist, Team, bundle, or mode drift. Do not repair identity.
3. Preserve all direct-mode manual-action, privacy, credential, ordering,
   static-check, and proof boundaries. Parent confirmation remains
   user-confirmed, not portal proof.
4. Return exactly one terminal result for the combined Apple-before-APNs
   validation. Never emit a setup-Apple intermediate result. The parent alone
   joins this result and merges its safe memory sections.

### Exact worker return protocol

Every operation returns a literal first line, one blank line, and exactly one
single-line `WORKER_RESULT: {...}` with no additional prose. Status mapping is
exact:

| Literal first line | JSON `status` | Required matching array |
|---|---|---|
| `DONE` | `done` | `concerns`, `contextRequests`, and `blockers` are empty |
| `DONE_WITH_CONCERNS: <comma-separated concerns>` | `done_with_concerns` | `concerns` is the same non-empty ordered list; the other two are empty |
| `NEEDS_CONTEXT: <stable reason code>` | `needs_context` | `contextRequests` is exactly `[<stable reason code>]`; the other two are empty |
| `BLOCKED: <reason>` | `blocked` | `blockers` is exactly `[<reason>]`; the other two are empty |

Do not use another JSON status spelling.

A successful `preflight` is exactly:

```text
DONE

WORKER_RESULT: {"contractVersion":1,"worker":"mobile-app:push-ios-prerequisites-worker","runId":"<id>","operation":"preflight","stage":"preflight","status":"done","capabilities":{"supportedOperations":["preflight","execute"],"preflightRequiresExecutionEnvelope":false,"preflightCloudCalls":false,"preflightFileReads":false,"preflightFileWrites":false,"mayPrompt":false,"mayDelegate":false,"memoryWrites":false,"executeSupported":true,"executeCloudAccess":"none","executeWriteScope":"none"},"identities":{},"decisions":{},"changedFiles":[],"validatedFiles":[],"validations":[{"name":"capability-contract","ok":true}],"memoryPatch":{"sections":[]},"contextRequests":[],"concerns":[],"blockers":[],"summary":"Push iOS prerequisites worker capability preflight succeeded."}
```

A successful `execute` uses this exact shape:

```text
DONE

WORKER_RESULT: {"contractVersion":1,"worker":"mobile-app:push-ios-prerequisites-worker","runId":"<id>","operation":"execute","stage":"ios-prerequisites","status":"done","capabilities":null,"identities":{"firebaseProjectId":"<id>","firebaseIosAppId":"<id>","bundleIdentifier":"<id>","appleTeamId":"<id>"},"decisions":{"plistPath":"<project-relative plist path>","selectedModes":"development,ad-hoc","appleConfirmations":{"identity":true,"explicitAppId":true,"pushCapability":true,"intendedDevicesRegistered":true,"developmentCertificate":true,"developmentProfile":true,"distributionCertificate":true,"adHocProfile":true,"localXcodeSigning":true},"apnsMethod":"p8","apnsKeyId":"<safe id>","certificateEnvironments":null,"firebaseConsoleUploadConfirmed":true,"appleConfirmedAt":"<UTC timestamp>","apnsConfirmedAt":"<UTC timestamp>"},"changedFiles":[],"validatedFiles":["<project-relative plist path>"],"validations":[{"name":"ios-identity","ok":true},{"name":"apple-confirmation-envelope","ok":true},{"name":"apns-confirmation-envelope","ok":true}],"memoryPatch":{"sections":[]},"contextRequests":[],"concerns":[],"blockers":[],"summary":"<one safe sentence>","appleState":{"status":"user-confirmed; not portal proof"},"apnsState":{"status":"configured, device verification pending"},"selectedModes":"development,ad-hoc","credentialType":"apns-auth-key"}
```

The JSON status must agree with the first line. Require exact `contractVersion`,
worker, run ID, operation, stage, Firebase project/iOS app, bundle, Team,
selected modes, all mode-aware Apple confirmations, APNs method, safe
conditional Key ID/environments, upload attestation, and timestamps. All
result paths are normalized `/`-separated project-relative paths, never
absolute. Resolve `decisions.plistPath` and every `validatedFiles` entry
against `working_dir` before comparing them with the absolute active plist
path; never compare raw relative and absolute strings. `changedFiles` must
remain empty. `memoryPatch.sections` may contain only the safe Apple and APNs
templates derived from the supplied confirmations. Never return credentials,
paths to credentials, account identity, device data, signing-asset
identifiers, screenshots, or raw config/portal output.

### `setup-apple-ios` worker decisions

The envelope must carry the identity-continuity decision plus every applicable
manual section attestation from this guide. If a missing explicit App ID would
need creation, the parent must also supply the user's exact create/do-not-create
decision before the user performs that action and dispatches the worker. The
worker checks `apple_confirmations` in canonical order and returns the safe
Apple memory block in `WORKER_RESULT.memoryPatch.sections`; it does not write
the block itself.

### `setup-apns` worker decisions and prerequisite

Within the combined worker or the single `/setup-apns` fallback owner, apply
all `/setup-apple-ios` identity, capability, device, signing, profile, and
Xcode semantics before applying `/setup-apns` semantics. Every applicable
`apple_confirmations` field must be complete and mode-correct before APNs state
is considered. Missing, false, contradictory, or mode-inapplicable Apple state
returns
`NEEDS_CONTEXT: setup-apple-ios-confirmation-required`; an APNs confirmation
cannot compensate for it.

The APNs envelope must also carry the user-selected `.p8`/`.p12` route, every
applicable readiness and Firebase Console acceptance attestation, and the exact
certificate environments required by the selected modes. For `p8`, require
`certificate_environments: null`; include the safe Key ID only when the owner
handoff needs it. For `p12`, require no Key ID and exact development/production
environment coverage for the selected modes. Credential material and local
credential paths remain prohibited. Return the safe APNs memory block in
`WORKER_RESULT.memoryPatch.sections`; never write it.

Direct behavior remains unchanged unless all worker contract markers are
present and `worker_name` is exactly
`mobile-app:push-ios-prerequisites-worker`. Direct use remains
`/setup-apple-ios` followed by `/setup-apns`, each with its existing
interactive completion and safe memory write.

Official references:

- Apple Developer Program enrollment:
  <https://developer.apple.com/help/account/membership/program-enrollment/>
- Apple Developer account help:
  <https://developer.apple.com/help/account/>
- Locate a Team ID:
  <https://developer.apple.com/help/account/manage-your-team/locate-your-team-id/>
- Roles and access:
  <https://developer.apple.com/help/account/access/roles/>
- Register an App ID:
  <https://developer.apple.com/help/account/identifiers/register-an-app-id/>
- Enable app capabilities:
  <https://developer.apple.com/help/account/identifiers/enable-app-capabilities/>
- Register a device:
  <https://developer.apple.com/help/account/devices/register-a-single-device/>
- Create a certificate signing request:
  <https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/>
- Create certificates:
  <https://help.apple.com/xcode/mac/current/en.lproj/dev154b28f09.html>
- Create a development provisioning profile:
  <https://developer.apple.com/help/account/provisioning-profiles/create-a-development-provisioning-profile/>
- Create an ad-hoc provisioning profile:
  <https://developer.apple.com/help/account/provisioning-profiles/create-an-ad-hoc-provisioning-profile/>
- Xcode support and downloads:
  <https://developer.apple.com/support/xcode/>
- Xcode accounts:
  <https://help.apple.com/xcode/mac/current/en.lproj/dev8fbf65ad9.html>
- Manual signing:
  <https://help.apple.com/xcode/mac/current/en.lproj/dev80cc24546.html>

## Secret and privacy boundary

Never request, accept, read, repeat, inspect, store, or transmit:

- Apple account email, password, 2FA/OTP, recovery data, session, cookie, or
  app-specific password;
- certificate private keys, exported `.p12` files, keychain passwords, or
  certificate signing request private material;
- device UDIDs, device names, screenshots that expose them, profile contents,
  profile UUIDs, or local credential/profile paths;
- APNs `.p8` contents or paths, or APNs certificate `.p12` files, passwords,
  private keys, contents, or paths. `/setup-apns` owns the separate manual APNs
  credential handoff.

The user enters credentials and device identifiers only in Apple, Xcode, or
macOS interfaces they control. If sensitive material appears in chat, do not
quote or persist it; tell the user to rotate or invalidate it when appropriate.

## Identity invariant

Resolve these values before any portal action:

- the approved 10-character Apple Team ID;
- the evaluated Expo `ios.bundleIdentifier`;
- the exact Firebase iOS bundle identifier selected by `/setup-fcm`;
- development and/or ad-hoc as the approved registered-device modes.

The Expo and Firebase bundle identifiers must match exactly, including case.
Every Apple identifier, certificate, profile, Xcode selection, and later APNs
upload must remain on that bundle ID and Team ID. A convenient portal default,
another visible team, a wildcard identifier, or a newly typed value is not a
replacement.

On drift, stop before changes. Show only the conflicting non-secret Team/bundle
values and route the owning identity back to the plan or `/setup-fcm`. Do not
silently update `memory-bank.md`.

## Manual section protocol

For each section:

1. Explain the exact user action and its official URL.
2. State what must match the approved Team ID and bundle ID.
3. State what is out of scope and what must not be shared.
4. Use `AskUserQuestion` to ask whether the section is complete, with explicit
   **Yes** and **No** choices.
5. Continue only after **Yes**. On **No**, remain at the current section and
   provide safe remediation or the correct owner.

In orchestrated worker mode, the parent-supplied decision and attestation for
each section replaces only the corresponding question. Missing or changed
decisions return `NEEDS_CONTEXT`; the worker never calls `AskUserQuestion`.

These confirmations are attestations from the user, not portal read-back,
machine validation, or proof. Never describe them as verified, validated, or
proven by Apple.

## 1. Exact explicit App ID and Push Notifications

In Certificates, Identifiers & Profiles, guide the user to Identifiers. They
must reuse the exact explicit App ID for `<BUNDLE_ID>` or create it only if
absent on the approved Team. Wildcard IDs are not acceptable.

Before creating a missing identifier, explain the exact Team, bundle, and
capability change and ask whether the user wants to proceed, with **Yes** and
**No** choices. Do not create or guide creation after **No**.

The user then enables only the required Push Notifications capability for that
exact identifier. Do not create an App Store Connect record, rename/delete
another identifier, or alter unrelated capabilities.

After the portal displays the exact explicit identifier and capability, ask:

```text
Is the explicit App ID <BUNDLE_ID> present with Push Notifications enabled on
Team <TEAM_ID>?
Choices: Yes / No
```

If an identifier exists on another team, only a wildcard match exists, or the
exact identifier cannot be created, stop for an Apple administrator decision.

## 2. Physical device registration

For development and ad-hoc profiles, every target device must be registered on
the approved Team. Guide the user to obtain each UDID locally through Finder,
Xcode, or Apple Configurator and enter it directly in the Apple Developer portal.

Never ask for UDIDs or device names. Do not accept batch files, screenshots,
paths, masks, suffixes, or pasted identifiers. Do not disable, remove, or rename
existing devices.

```text
Are all intended test devices registered on Team <TEAM_ID>?
Choices: Yes / No
```

If the portal reports a device-limit or registration conflict, stop and direct
the user to their Apple administrator.

## 3. Mode-specific signing certificates

Explain which certificate type each selected mode requires:

- **Apple Development** for development builds/profiles;
- **Apple Distribution** for ad-hoc builds/profiles.

Require only the certificate types needed by the approved mode set. A
development-only setup does not require Apple Distribution; an ad-hoc-only
setup does not require Apple Development.

Guide the user to Xcode > Settings > Accounts, select the exact Team, open
Manage Certificates, and reuse or create the required identities on the Mac
that will build the app. If organizational policy requires portal-based
creation, the user creates the certificate signing request locally, creates
the certificate in Apple Developer, then opens the downloaded certificate on
the same Mac so its matching private key remains available to Xcode.

Private keys stay in the user's macOS login keychain. Never ask the user to
export a `.p12`, share a keychain path/password, or provide certificate names,
serial numbers, fingerprints, private-key details, or screenshots. Never revoke
or delete a certificate. Certificate quota or an unusable/missing private key is
a hard stop for the user or Apple administrator to resolve.

For each applicable certificate type, ask the matching Yes/No question:

```text
Is an Apple Development certificate with its private key available to Xcode
for Team <TEAM_ID>?
Choices: Yes / No
```

```text
Is an Apple Distribution certificate with its private key available to Xcode
for Team <TEAM_ID>?
Choices: Yes / No
```

## 4. Mode-specific provisioning profiles

Guide the user to create or regenerate each profile selected in the approved
mode set:

- iOS App Development profile for the exact explicit App ID, Apple Development
  certificate, and all intended registered devices;
- Ad Hoc profile for the same App ID, Apple Distribution certificate, and all
  intended registered devices.

If devices changed after profile creation, every selected profile must be
regenerated.
Do not use wildcard identifiers, mismatched certificates, another Team, or a
profile for another bundle. Never ask for profile contents, UUIDs, device lists,
certificate identifiers, or local paths.

For each applicable profile, ask the matching Yes/No question:

```text
Is the development profile current for Team <TEAM_ID>, bundle <BUNDLE_ID>, and
all intended registered devices?
Choices: Yes / No
```

```text
Is the ad-hoc profile current for Team <TEAM_ID>, bundle <BUNDLE_ID>, and all
intended registered devices?
Choices: Yes / No
```

## 5. Local Xcode installation

Guide the user to install the current supported Xcode from the Mac App Store or
Apple Developer downloads, launch it once, accept its license locally, and
install requested platform components. In Xcode Settings > Accounts, the user
signs in locally and selects the approved Team. Credentials remain in Xcode.

The user opens the downloaded certificates and selected development/ad-hoc
profiles on the same Mac. In Xcode Settings > Accounts, they confirm that the
exact Team is available and that every certificate type required by the
approved mode set is managed on this Mac.
When Wrap generates the Xcode build, its manual signing selection must use the
same Team, bundle ID, and profile mode. Do not require a pre-existing native
Xcode project, and do not inspect Keychain Access, Xcode account data,
provisioning directories, or signing assets by script.

Ask:

```text
Is local Xcode signing ready for Team <TEAM_ID>, bundle <BUNDLE_ID>, and
registered-device modes <SELECTED_MODES>?
Choices: Yes / No
```

Use `development`, `ad-hoc`, or `development,ad-hoc` exactly as approved. If a
selected mode is missing or Xcode selects another Team/bundle, stop and return
to the relevant manual section.

## Safe memory-bank handoff

After all scoped confirmations, append or update only a clearly labeled,
non-secret block:

```markdown
## Apple iOS manual setup (user-confirmed; not portal proof)
- confirmationBasis: user-confirmed
- portalProof: false
- teamId: <TEAM_ID>
- bundleIdentifier: <BUNDLE_ID>
- scope: registered-device <SELECTED_MODES>
- explicitAppId: user-confirmed
- pushNotificationsCapability: user-confirmed
- intendedDevicesRegistered: user-confirmed
- appleDevelopmentCertificate: user-confirmed # development only; omit otherwise
- developmentProfile: user-confirmed # development only; omit otherwise
- appleDistributionCertificate: user-confirmed # ad-hoc only; omit otherwise
- adHocProfile: user-confirmed # ad-hoc only; omit otherwise
- localXcodeSigning: user-confirmed
- confirmedAt: <ISO-8601 timestamp>
```

The comments above describe conditional fields; do not copy the comments into
`memory-bank.md`.

Do not store account identity, device data, certificate/profile identifiers,
paths, screenshots, credentials, or diagnostics. This state is a resumable
checklist and continuity handoff only. It is not evidence from Apple and must
not be used to claim that a build or physical delivery succeeded.

In orchestrated worker mode, return this allowlisted block under
`WORKER_RESULT.memoryPatch.sections` for the parent to merge serially. Do not
write `memory-bank.md` or any other file.

Route next to `/setup-apns`, where the user may choose a manually uploaded APNs
authentication key (`.p8`) or APNs certificate (`.p12`). `/build-ios` must
still perform its own current local signing preflight, and `/verify-ios-push`
remains the only physical delivery evidence.
