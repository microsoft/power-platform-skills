# Android physical push matrix

Use this reference only after the common
[physical push verification protocol](../../../shared/references/push-physical-verification.md)
has established privacy-safe correlation and exact FlowAgent read-back.

## Exact `android-build.json` handoff

Consume the exact project-root `android-build.json`; never infer a build from
an APK filename or directory listing. Before requesting install confirmation,
obtain the expected signer certificate SHA-256 independently from the
customer-managed signing identity, then run:

```bash
node "${PLUGIN_ROOT}/scripts/validate-android-build-handoff.js" \
  --project-root . --file android-build.json --max-age-hours 24 \
  --expected-signer-sha256 "<64-hex-certificate-sha256>"
```

Exit 0 and JSON `status: valid` are mandatory. The same command must succeed
again immediately before the first live send using the same expected signer.
Manual inspection or matching a subset of fields never substitutes for the
validator.

The expected signer fingerprint is non-secret, but it must not be sourced
solely from editable `android-build.json.signing.certificateSha256`. Accept a
fresh customer-supplied value or the build owner's separately recorded
customer-confirmed signer handoff. Never request a certificate file, keystore,
alias, password, SHA-1 redirect hash, or signing command.

Consume the finalized strict schema version 1:

| Object | Exact fields |
| --- | --- |
| Root | `schemaVersion: 1`, `platform: "android"`, `purpose: "direct-physical-device-testing"`, `status: "verified"` |
| `artifact` | `path`, `sha256`, `sizeBytes`, `modifiedAt`, plus decimal-string `modifiedAtNs`, `changedAtNs`, `device`, `inode` |
| `app` | `package`, `displayName`, `versionName`, `versionCode`, `minSdkVersion`, `targetSdkVersion`, `sourceIconPath`, `sourceIconSha256`, `packagedIconResource`, `packagedIconSha256` |
| `firebase` | `projectId`, `androidAppId`, `package`, `clientConfigPath` |
| `auth` | `clientId`, `tenantId` |
| `signing` | `verified`, `verificationTool`, `certificateSha256`, `schemes` |
| `tooling` | `metadataTool`, `wrapPackage`, `wrapVersion` |
| `timestamps` | `inputsCapturedAt`, `buildStartedAt`, `verifiedAt`, `validUntil` |
| `inputs` | `schemaVersion: 1`, `algorithm: "sha256"`, lowercase `digest: "sha256:<64 hex>"`, positive safe-integer `fileCount`/`totalBytes`, `files` |
| `inputs.files[]` | exactly normalized POSIX project-relative `path`, nonnegative safe-integer `sizeBytes`, lowercase `sha256: "sha256:<64 hex>"`; paths are unique and sorted by UTF-8 byte order |

The strict validator, not this verification workflow, validates the schema and
recomputes the current declared-input snapshot. Its comparison covers the full
build-owner input set and rejects file additions/removals plus aggregate
digest, content SHA-256, size, count, or total-byte drift. Do not manually
choose a smaller source set, recalculate only selected files, or accept a
handoff that lacks `timestamps.inputsCapturedAt`, `inputs.digest`, or the full
`inputs.files` snapshot.

The aggregate digest is the build owner's deterministic
`android-declared-inputs-v1` SHA-256 contract over each sorted file's
path/decimal size/file SHA-256 tuple. Verification consumes the validated
digest summary (`digest`, `fileCount`, `totalBytes`) and may read the full
path/size/hash list from the validated handoff, but never file contents. Do not
independently reimplement the digest algorithm; the validator remains
authoritative and race-checks the current declared inputs.

`timestamps.inputsCapturedAt` is the declared-input snapshot file time. The
validator requires it to precede or equal `buildStartedAt` and to be no more
than 24 hours older; a missing, later, or older snapshot blocks verification.

The validator also requires the handoff and APK to remain regular non-symlink
files under the project root and proves artifact SHA-256/size/time, proof age,
project identity, Firebase/auth/tooling identity, and signing/metadata status.
Do not accept a copied/renamed substitute, a second APK, or an artifact outside
the project.

The high-resolution artifact fields are validator-owned TOCTOU evidence, not
downstream parsing inputs. `verify-android-push` consumes exit 0,
`status: "valid"`, and the safe returned digest summary; it must not
independently stat or compare `modifiedAtNs`, `changedAtNs`, `device`, or
`inode`.

## Signed APK-embedded input proof

Handoff validation must open the exact APK and prove all of these together:

- exactly one
  `assets/power-platform/android-build-input-proof.json` ZIP entry;
- exact canonical bytes: minified one-line JSON plus LF, with no other fields
  or whitespace:

  ```text
  {"schemaVersion":1,"algorithm":"sha256","declaredInputsDigest":"sha256:<64 lowercase hex>"}\n
  ```

- the embedded digest exactly equals the validated handoff's `inputs.digest`;
- the proof entry is located before and covered by the final APK Signature
  Scheme v2-or-newer whole-file signing block; and
- the exact APK path, size, modification time, and SHA-256 still match
  `android-build.json`.

Only `validate-android-build-handoff.js` success proves this binding for
downstream verification. Do not unzip or parse the proof manually, run a
partial timestamp check, or infer it from the handoff JSON alone.

The validator reads proof/signing/metadata from a private byte-identical
read-only snapshot of the APK. It rechecks current source inputs, the snapshot,
and the live artifact's real path, high-resolution identity, size, and SHA-256
after validation phases and immediately before returning `status: "valid"`.
This closes replacement, symlink-swap, touch, truncation, and same-size-content
races; downstream verification must not recreate a weaker check.

The validator also resolves trusted `apksigner`, `aapt`, and `unzip` itself.
Against the private snapshot it requires fresh v2+ signature schemes and a
fresh signer fingerprint matching both the handoff value and the separately
supplied expected signer. It freshly compares package, display name,
versionName/versionCode, minSdkVersion/targetSdkVersion, Firebase
project/app/package, packaged icon resource, and extracted icon SHA-256 before
returning `status: "valid"`.

Bind install and test evidence to the successful validator output's safe
`inputs.digest`, `fileCount`, `totalBytes`, and `timestamps.inputsCapturedAt`.
Before the first live send, require the rerun to return the same
`inputs.digest`; otherwise the installed-artifact boundary is no longer proven.

Temporal-only evidence is invalid. A recent `.tmp/android-build-start`, recent
APK modification time, matching visible version, or a copied/touched file can
describe an older or substituted binary. Reject any APK whose embedded digest
is absent, non-canonical, post-sign inserted, covered only by v1/JAR signing, or
different from `inputs.digest`, even when its timestamps look fresh.

Run the strict handoff validator before install confirmation and again before
the first live send. Any source change, artifact touch/replacement, embedded
proof change, or signature-layout drift requires `/build-android` and a new
validated APK; never refresh timestamps or reuse the old handoff.

Require the handoff identity to match the active evaluated Expo configuration
and `firebase/google-services.json`:

- `android.package` / application ID;
- app version and version code;
- Firebase `project_id`;
- Firebase `mobilesdk_app_id`;
- Android client `package_name`;
- evaluated project-relative `googleServicesFile`.

Any mismatch requires client repair followed by a new build. Static
configuration success does not prove the installed APK or delivery.

## Physical-install boundary

Require user confirmation that the exact handoff APK was installed after the
old app was removed or replaced on one physical Android 8+ device. Record only
the Android major/API branch needed for the permission test and the safe
installed app name/version/version code.

Reject:

- Android emulator or cloud virtual device;
- Expo Go, Metro-only preview, browser/web preview;
- generic Power Apps Developer;
- an older, copied, renamed, or similarly versioned APK;
- a build made before the active client, route, or push implementation;
- an installation claim that cannot name the handoff's exact project-relative
  APK.

Never run `adb devices`, collect an ADB serial, or request any device ID.

## Execute A-H in order

Use a fresh opaque case label and one confirmed user-approved send for every delivery
case. Record device observation immediately. Stop when correlation becomes
ambiguous.

### A. Android-version permission branch

First verify cold launch shows the app's pre-permission explanation and does
not initialize messaging or request notification access automatically. `Not
now` must preserve normal app/sign-in use without claiming registration.

Then branch on the physical device OS:

**Android 13+ (API 33+)**

1. Tap `Enable notifications`; require the
   `POST_NOTIFICATIONS` runtime prompt.
2. Deny it; require a non-throwing denied state, normal app use, and an action
   that opens app notification settings.
3. Grant access through the supported retry/settings path; require the app to
   report enabled/registered without displaying a token.

**Android 8-12 (API 26-32)**

1. Do not expect or simulate an Android 13 runtime prompt.
2. Verify the app distinguishes the pre-13 platform path and can proceed after
   explicit in-app opt-in.
3. Verify system notification settings remain reachable and disabled
   notifications are handled without throwing.

Do not mark the Android 13 denial/grant case passed on a pre-13 device. Record
the non-applicable branch explicitly rather than fabricating evidence.

### B. Channel and signed-out foreground `allUsers`

Keep the user signed out and the exact app foregrounded.

1. Require the app-created Android notification channel used by push delivery
   to exist with the intended user-visible name and non-silent importance.
   Channel configuration alone is not delivery proof.
2. Send one approved `allUsers` case.
3. Require one outbox lifecycle, one sender run, and one visible foreground
   presentation matching the case label and UTC window.
4. Require the app to remain usable and avoid duplicate foreground display.

Do not expose raw payload or provider response while checking presentation.

### C. Signed-out background `allUsers`

Move the exact app to background without force-stopping it. Send a new approved
`allUsers` case and require an independent outbox/run chain plus one visible
system notification while backgrounded. Foreground success cannot satisfy this
case. A sender success or `Sent` row without device receipt fails the case.

### D. Terminated tap and exactly-once deep link

Terminate the exact app through normal user controls, send one new `allUsers`
case with an allowlisted internal route, and tap the system notification.
Require:

- cold launch of the exact wrapped app;
- navigation only after router/auth readiness;
- exactly one navigation to the expected safe destination, or the documented
  login-then-resume path;
- no duplicate navigation from warm and initial-response handlers;
- invalid or stale route rejection/fallback rather than navigation.

App launch without a tap, a warm callback, duplicate navigation, default-home
arrival, or navigation to an unvalidated route fails this case.

### E. Lowercase-OID sign-in

Sign in as consenting test account A. The live producer read-back must prove it
validates the Entra OID and lowercases it before user-topic routing; never
request or inspect the actual OID.

Exercise the exact producer with one approved event owned by account A. Require
one producer run, one queued user-audience outbox row, one sender run, terminal
`Sent`, and one device receipt. Do not insert a user-targeted outbox row
directly and do not use Firebase Console.

### F. Account switch and sign-out

Switch from consenting account A to consenting account B without reinstalling.
Require the client transition order to subscribe the new lowercase OID topic
before removing the prior app-owned topic.

1. Send one producer-owned approved account-B event and require receipt.
2. Send one producer-owned approved account-A negative case and require no
   receipt during the fixed two-minute window.
3. Sign out; require transition order to subscribe exact `allUsers` before
   removing the remembered account-B topic.
4. Send a fresh approved `allUsers` case and require receipt as the positive
   control for the account transition.

Refer to the accounts only as `account-A` and `account-B`. Never collect,
display, or persist either OID.

### G. Opt-out negative

Use the app's notification opt-out. Require a non-throwing disabled state and
the intended unsubscribe behavior for the remembered app-owned topic plus
`allUsers`.

Send one new approved `allUsers` case. The server path may finish, but the device
must not present it during a fixed two-minute observation window. Record the
non-receipt as provisional until H's positive control passes.

### H. Token refresh or exact same-APK re-registration

Re-enable notifications. Use one supported recovery route:

1. **Token-refresh signal:** exercise a documented non-secret test signal and
   require the listener to re-sync the current desired topic without exposing
   the token; or
2. **Same-APK re-registration:** remove and reinstall the exact APK still
   identified by the unchanged `android-build.json`. Rerun
   `validate-android-build-handoff.js` and require exit 0 plus `status: valid`
   with the same independently sourced expected signer before asking for this
   reinstall confirmation; this must re-prove the signer, packaged metadata,
   and signed embedded digest equals `inputs.digest`, not merely that the APK
   is recent. Then reconfirm the safe installed app identity and permission
   branch, and restore the signed-out `allUsers` state.

Do not claim token-refresh coverage when only reinstall/re-registration was
tested. Send one final approved `allUsers` control and require the full
outbox/run/device receipt chain. This receipt is both recovery proof and the
positive control that makes G's non-delivery meaningful.

## Android completion

Android push is physically verified only when:

- the exact fresh handoff APK and active Firebase client identity stayed
  unchanged;
- the exact recorded flows stayed published, read back, connected, and
  correlated;
- the applicable Android permission branch passed;
- channel, foreground, background, and terminated behavior passed;
- the terminated tap navigated exactly once;
- sign-in, account switch, sign-out, and lowercase-OID routing behavior passed
  without collecting an OID;
- opt-out non-delivery passed with H's positive control; and
- token refresh or exact same-APK re-registration recovery passed.

Anything less remains **pending physical verification**.
