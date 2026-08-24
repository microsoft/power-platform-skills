# Apple iOS provisioning handoff contract

Apple provisioning preflight workflows may write
`apple-ios-provisioning.json` in the app project root. Consumers must validate
it before use:

```bash
node "${PLUGIN_ROOT}/scripts/validate-apple-ios-provisioning.js" \
  --project-root . \
  --file apple-ios-provisioning.json \
  --expected-team "$APPLE_TEAM_ID" \
  --expected-bundle "$IOS_BUNDLE_ID" \
  --expected-mode "$IOS_BUILD_MODE"
```

This is a **versioned, non-secret metadata handoff**, not an Apple credential
or signing-asset store. It must never contain Apple IDs or email addresses,
passwords, 2FA values, session cookies, API keys, tokens, private keys,
certificate/profile contents, certificate/profile file paths, raw keychain
paths, device UDIDs, or other secrets. Opaque certificate resource IDs and the
keychain path fingerprint must be derived without exposing the source path.

## Version 1

```json
{
  "version": 1,
  "modes": ["development", "ad-hoc"],
  "teamId": "A1B2C3D4E5",
  "bundleId": "com.contoso.fieldapp",
  "pushCapability": {
    "capability": "aps-environment",
    "enabled": true,
    "proof": "app-id-capability-readback"
  },
  "keychain": {
    "serviceIdentifier": "security-default-keychain",
    "pathFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "certificates": {
    "development": {
      "resourceId": "apple-development:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "type": "apple-development",
      "expiresAt": "2027-08-21T06:00:00.000Z",
      "proof": "keychain-identity-readback"
    },
    "distribution": {
      "resourceId": "apple-distribution:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "type": "apple-distribution",
      "expiresAt": "2027-08-21T06:00:00.000Z",
      "proof": "keychain-identity-readback"
    }
  },
  "profiles": {
    "development": {
      "uuid": "11111111-2222-3333-4444-555555555555",
      "type": "development",
      "expiresAt": "2027-08-21T06:00:00.000Z",
      "bundleId": "com.contoso.fieldapp",
      "teamId": "A1B2C3D4E5",
      "apnsEnvironment": "development",
      "getTaskAllow": true,
      "deviceCount": 12,
      "certificateResourceId": "apple-development:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "certificateType": "apple-development",
      "proof": "installed-profile-metadata-readback"
    },
    "adHoc": {
      "uuid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "type": "ad-hoc",
      "expiresAt": "2027-08-21T06:00:00.000Z",
      "bundleId": "com.contoso.fieldapp",
      "teamId": "A1B2C3D4E5",
      "apnsEnvironment": "production",
      "getTaskAllow": false,
      "deviceCount": 12,
      "certificateResourceId": "apple-distribution:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "certificateType": "apple-distribution",
      "proof": "installed-profile-metadata-readback"
    }
  },
  "proof": {
    "verifier": "apple-ios-provisioning-preflight",
    "verifierVersion": "1.0.0",
    "verifiedAt": "2026-08-21T05:00:00.000Z",
    "validUntil": "2026-08-22T05:00:00.000Z",
    "steps": {
      "teamAndBundleVerified": true,
      "pushCapabilityVerified": true,
      "keychainVerified": true,
      "developmentCertificateVerified": true,
      "distributionCertificateVerified": true,
      "developmentProfileVerified": true,
      "adHocProfileVerified": true
    }
  }
}
```

Team and bundle identity is repeated in each profile so a stale or cross-app
profile cannot be silently combined with the envelope. Development profiles
must prove `aps-environment=development`; ad-hoc profiles must prove
`aps-environment=production`. Development must also prove
`get-task-allow=true`; ad hoc must prove `get-task-allow=false`. Each profile
must name the exact verified certificate resource ID and modern certificate
type. Device count is allowed, but device identifiers are not.

All timestamps are canonical UTC ISO 8601. Proof is valid for at most 24 hours,
must not be more than 24 hours old, and may be at most five minutes ahead of
the validator clock. Every certificate and profile must remain valid beyond
the proof window.

Unknown fields, versions, resource proof values, certificate/profile types,
and implied distribution modes are rejected. Version 1 intentionally supports
only registered-device development and ad-hoc readiness; it does not model App
Store, TestFlight, enterprise, or simulator signing.

`/build-ios` must also run
`scripts/verify-apple-ios-build-signing.js` through the retained secure
keychain helper immediately before Wrap. That live proof selects only the
requested mode, checks the required Development or Distribution identity
inside the dedicated keychain, decodes the exact installed profile in-process,
and verifies Team, bundle, registered-device scope, `get-task-allow`, and APNs
environment. It resolves the installed-profile directory from `xcodebuild
-version`: Xcode 16+ uses `~/Library/Developer/Xcode/UserData/Provisioning
Profiles`, while older Xcode uses `~/Library/MobileDevice/Provisioning
Profiles`. Its output must not include certificate names, profile UUIDs,
device identifiers, raw keychain paths, or profile contents.

## CLI result and exit codes

- Exit `0`: `{ "status": "valid", ... }`
- Exit `2`: parsed contract is invalid and `issues` contains safe field-level
  failures.
- Exit `1`: CLI input, project path, contract path, file, or JSON could not be
  safely processed.

The project root itself, every contract path component, and the contract file
must not be symbolic links. The contract must remain a regular file inside the
supplied project root.
