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
- APNs `.p8` contents or paths. `/setup-apns` owns the separate manual APNs
  authentication-key handoff.

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
4. Ask for the section's exact confirmation phrase.
5. Continue only after the exact phrase is supplied.

These confirmations are attestations from the user, not portal read-back,
machine validation, or proof. Never describe them as verified, validated, or
proven by Apple.

## 1. Membership, access, and agreements

Guide the user to sign in at <https://developer.apple.com/account/> and select
the exact approved Team. They confirm:

- Apple Developer Program membership is active;
- their role can manage Certificates, Identifiers & Profiles for the work;
- no blocking agreements or account notices remain.

Do not accept agreements, alter membership, invite users, change roles, or
change legal/billing data. Those actions belong to the Account Holder or the
organization's Apple administrator.

Require:

```text
confirm Apple access: <TEAM_ID>
```

## 2. Exact explicit App ID and Push Notifications

In Certificates, Identifiers & Profiles, guide the user to Identifiers. They
must reuse the exact explicit App ID for `<BUNDLE_ID>` or create it only if
absent on the approved Team. Wildcard IDs are not acceptable.

Before creation, require:

```text
create explicit App ID: <TEAM_ID> <BUNDLE_ID>
```

The user then enables only the required Push Notifications capability for that
exact identifier. Do not create an App Store Connect record, rename/delete
another identifier, or alter unrelated capabilities.

Require after the portal displays the exact explicit identifier and capability:

```text
confirm App ID and Push: <TEAM_ID> <BUNDLE_ID>
```

If an identifier exists on another team, only a wildcard match exists, or the
exact identifier cannot be created, stop for an Apple administrator decision.

## 3. Physical device registration

For development and ad-hoc profiles, every target device must be registered on
the approved Team. Guide the user to obtain each UDID locally through Finder,
Xcode, or Apple Configurator and enter it directly in the Apple Developer portal.

Never ask for UDIDs or device names. Do not accept batch files, screenshots,
paths, masks, suffixes, or pasted identifiers. Do not disable, remove, or rename
existing devices.

Ask only for the non-sensitive total count the user expects the profiles to
cover, then require:

```text
confirm registered devices: <TEAM_ID> count=<COUNT>
```

If the portal reports a device-limit or registration conflict, stop and direct
the user to their Apple administrator.

## 4. Mode-specific signing certificates

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

Require the applicable confirmation or confirmations:

```text
confirm Apple Development certificate: <TEAM_ID>
```

```text
confirm Apple Distribution certificate: <TEAM_ID>
```

## 5. Mode-specific provisioning profiles

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

Require the applicable confirmation or confirmations:

```text
confirm development profile: <TEAM_ID> <BUNDLE_ID> count=<COUNT>
```

```text
confirm ad-hoc profile: <TEAM_ID> <BUNDLE_ID> count=<COUNT>
```

## 6. Local Xcode installation

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

Require:

```text
confirm local Xcode signing: <TEAM_ID> <BUNDLE_ID> modes=<SELECTED_MODES>
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
- membershipAccessAgreements: user-confirmed
- explicitAppId: user-confirmed
- pushNotificationsCapability: user-confirmed
- registeredDeviceCount: <COUNT>
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

Route next to `/setup-apns`. `/build-ios` must still perform its own current
local signing preflight, and `/verify-ios-push` remains the only physical
delivery evidence.
