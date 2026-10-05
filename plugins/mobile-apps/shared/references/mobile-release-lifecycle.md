# Mobile release compatibility

Use one reviewed release set for creation, native changes, upgrades, previews,
and deployment. A newer npm package, matching Hermes header, or successful
TypeScript build does not prove that a player or wrapped binary contains the
same native runtime.

## Resolve before native work

```bash
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root "<working_dir>"
```

Only exit 0 authorizes using the returned release as a native dependency
baseline. Pass the sanitized result to planners/builders, not a copy of
`app.json`, auth settings, or connection strings. Never substitute the plugin's
bundled `template/package.json`. An old app does not gain capabilities when its
plugin is updated.

The protected source is `app.json` → `expo.extra.powerappsNative`:
`schemaVersion`, `templateVersion`, and per-platform `nativeRuntimeVersions`.
These are not npm versions. Preserve them during preparation and ordinary app
edits. Only a successful host migration may advance them. Missing, malformed,
or unknown state blocks native work; do not backfill it from installed packages.
App-owned extras, telemetry preferences, branding, navigation, authentication,
offline settings, and custom instruction files remain customer-owned.

`--requirements-only` resolves the recorded source for **upgrade planning**,
even when installed dependencies have drifted. It is not a native admission or
deployment check. Source/UI-only work can continue without claiming native
compatibility; adding or updating dependencies still needs explicit validation.

## Reviewed release policy

[`mobile-releases.json`](../mobile-releases.json) is this plugin's own reviewed
policy, not an upstream service or a manifest emitted by npm or the host CLI.
It initially has **no releases and no default**. Creation, native dependency
admission, native upgrades, and deployment therefore stop with a release-evidence
block. Do not work around this with `latest`, a bundled snapshot, implicit local overrides,
or an app-authored “verified” flag. This is intentional until a maintainer has
verified an actual release set.

Each record binds an exact template package version and npm integrity to its
template/runtime requirements, managed dependency declarations, installed native
package inventory (including nested native dependencies), and Android/iOS base
and player versions/fingerprints. Evidence references must be public and contain
no credentials. Maintainers must verify publication, exact package content,
native inventory, matching binaries, store/distribution availability, and device
validation on **both platforms** before adding a record or promoting a default.
A schema-valid record alone is not evidence that those checks happened.

Inspect a reviewed target without changing the app:

```bash
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --release "<release-id>"
```

Do not invent missing package metadata or CLI flags. The template CLI's
`--manifest` reports package identity and template/runtime requirements, not
release readiness or an entire native dependency inventory.

## Explicit local diagnostic artifacts (not a release)

An explicitly requested, reviewed **online-only Android diagnostic** may select
`--diagnostic-artifacts "<manifest.json>"` instead of a published release. This
is a separate local test contract, never a catalogue entry, default promotion,
publication claim, or deployment approval. Do not create production records or
invent registry versions to make an unpublished package installable. Ordinary
commands without this option stay fail closed. No environment variable, bypass
boolean, or automatic player/device discovery enables this mode.

Before executing package code, review the producer-supplied manifest, archive
hashes, known player, and required tools with the user; obtain approval for local
inspection. Use `tar`, `unzip` and an explicitly chosen Android SDK `aapt2` on `PATH`.
Do not download tools or packages implicitly. Keep local paths and artifacts
private and uncommitted; never include them in reports or telemetry.
Archive inspection copies the verified archive into its private scratch directory
and runs `tar` there using a local filename, avoiding Windows drive-letter and
cross-drive extraction handling. The scratch copy is removed after inspection.
Inspection/acquisition uses private operating-system scratch directories outside
the app target and removes them afterward. No scratch directory makes an empty
creation destination nonempty or writes private package contents into the app.

The local JSON contract is `schemaVersion: 1`, `kind: "mobile-local-diagnostic"`:

| Field | Required evidence |
|---|---|
| `packages` | Exactly the host, auth, common, assets, and template package archives. Each has `name`, its actual exact `version`, contained relative `path`, `sha256`, and `integrity` (`sha512-…`). Use the packed identity, not a predicted production release or source-version provenance. |
| `referenceProject` | `path` to a protected **template staging snapshot**, `packageJsonSha256`, and `packageLockSha256`. Its `.branch-install.json` protects `package.json`, lock and local archives. Export omits `node_modules` and registry credentials. This is not an older customer app. |
| `player` | `platform: "android"`, relative APK `path`, `sha256`, and full baked `metadata`: existing player compatibility fields plus `diagnostic: { protocol: "online-only-57-v1", nativeRuntime: <versions and fingerprints> }`. |

The exported reference is intentionally uninstalled. After reviewing the supplied
hashes, protected lock, packages and lifecycle scripts, separately approve
`npm ci` in the copied reference directory using existing registry authentication.
Do not provision/copy credentials, install implicitly from a guard, or run this
preparation in an older app. Full resolution blocks with preparation guidance
until the reference is installed; it does not substitute lock-only guesses for
installed native inventory.

The helper verifies archive hashes/SRI before using package code; invokes only
the template's real `--manifest`; reads packed host `compatibility/current.json`
(`targetTemplateVersion`, `nativeRuntime` versions/fingerprints, managed
dependencies/overrides, migration list); checks the protected reference lock,
installed package bytes, aliases, platform omissions and exact native inventory;
and checks the **actual APK** in two independent ways: `unzip -p` reads
`assets/powerapps-player-compatibility.json` and must match the full supplied
metadata, including diagnostic fingerprints matching the packed host profile;
`aapt2` reads the authoritative AndroidManifest compatibility key and must match
the asset's corresponding runtime fields. Do not discard `diagnostic` fields or
use runtime-counter equality to excuse stale native builds after auth changes.
It also checks the verified installed target host's `--help` for its actual
`--project`, `--dry-run`, `--no-install` and `--diagnostic-artifacts` support.
An older CLI without that implementation blocks; do not invent the flag.
A generated source manifest, current profile, build directory, or metadata
capture alone is not evidence of a matching binary. APK metadata verification
does not assert device testing or prove that iOS was built. iOS remains
**not validated** and this diagnostic never authorizes iOS native work.
Admission uses the actual APK's supported Android runtime counters; its internally
consistent recommended template is advisory and may have an older npm version.
Report that recommendation honestly rather than rewriting it to the selected
diagnostic package version.

The current controlled SDK 57 host and template archives both have the actual
private version `1.0.0-expo57-diagnostic.0`, not merely a rewritten selection
record. Both require `private: true` and `powerAppsDiagnostic` with protocol
`online-only-57-v1`, an exact `0.x` `sourceVersion`, and the package-specific role:
host `purpose: "upgrade-target"`; template `purpose: "upgrade-inspection-only"`.
The producer prepares these private artifacts before locking its reference;
production source versions, sealing and publication guards remain unchanged.
`sourceVersion` is provenance, never a substitute for the selected archive's
version. The template's real `--manifest` must report that private version.
The APK may still recommend template `0.1.0`; supported runtime counters and the
full baked fingerprints, not npm-version equality, govern binary admission.

The inspection-only template excludes a stale canonical lock and cannot scaffold.
Its separately hashed staging lock is the install-graph evidence. A private
prerelease must enter the new host and template major required by the native
transition, but cannot satisfy production admission or promote a default.
Previously verified `0.x` source-version inspection bundles retain their original
two-field marker and report the future production-major requirement; do not
substitute them for a producer CLI requiring the current private target.
Equal npm versions do not imply equal builds: lock integrity and installed bytes
decide whether the selected local host needs installation. Consume all four
already-staged runtime archives unchanged. Never transform package code or
manifests in the consumer/customer app to simulate the producer's private target.
The migration's host `from` range establishes the source major even if the host
is already updated; its future `to` range never overrides the verified local
archive declaration or selects a registry package.

```bash
# After approval to inspect these exact local artifacts:
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" \
  --diagnostic-artifacts "<manifest.json>"

# Read-only source/target planning; no migration, installation or customer copy:
node "${PLUGIN_ROOT}/scripts/mobile-template-lifecycle.js" plan \
  --project-root "<working_dir>" --diagnostic-artifacts "<manifest.json>"
```

Record the returned `manifestSha256` with the private approval. Changed
manifest, archives, lock, player, app source or configuration invalidates the
review. An `expo.extra.__offlineProfile`, offline profile/plugin or native offline source usage
blocks this online-only test. Dynamic configuration is read, never executed.
Literal offline keys in source/configuration are checked in both quoted and
unquoted object/assignment forms; an ambiguous offline reference blocks for review.
Do not delete profiles,
disable offline, strip source imports or alter customer configuration to pass.
An optional baseline import of `../offline-profile.json` is not active offline
by itself when no profile exists. Only the unused retired
`dependencies["@microsoft/power-apps-native-offline"] = "^0.1.32"` baseline may be
removed by the reviewed producer migration; customized versions, placement,
aliases or overrides block. There is no `expo.extra.appConfig` offline wrapper.

Follow `/check-updates`' existing isolated-preview and aggregate-application
approvals, snapshot, per-edge conflict review, rollback, and telemetry checkpoints.
After explicit approval, keep the immutable artifact bundle in a controlled,
stable directory. Do not re-scaffold, copy reference source/lock into an old app,
or pre-edit its package declarations. The producer host CLI owns all migration
writes and binds all four local archives/overrides itself. Offline preflight must
precede even creating a directory inside the target app.

Use the **verified reference installation's target host CLI** for the preview,
not an older app's host or an invented registry target. Resolve its real
`package.json` `bin["upgrade-template"]` path. After the helper confirms that CLI
actually supports the diagnostic flag, preview one edge with
`--project "<preview_dir>" --dry-run --diagnostic-artifacts "<manifest.json>"`;
apply a clean approved edge with
`--project "<preview_dir>" --diagnostic-artifacts "<manifest.json>"` and its normal
validated installation. The target
CLI must preserve the selected local archive declarations. If it does not, stop
for a producer fix; do not fetch a nonexistent npm version or patch the host.
These reviewed producer archives are not a package-defect workaround or permission
to fork, rewrite, or re-pack first-party code in a customer app.
Do not install a new host with incompatible peers into an old dependency set
before previewing the coupled migration. If a reviewed intermediate write-only
step is necessary, run `--no-install` separately: it writes files but does not
advance state and must be followed by the normal validated apply. Do not combine
it with `--dry-run` or mistake it for completed migration.

After each final migration, use the diagnostic option on both the resolver and
`validate-mobile-files.js --file package.json`; the same exact inventory/JS
approval checks apply. Pass the sanitized `local-diagnostic-only` context and
explicit selection to nested skills/agents. Do not silently fall back to the
published resolver, or drop the selection on a follow-up call.
The producer may write absolute `file:` archive declarations while npm records
equivalent relative lock paths. The validator verifies identical resolved files,
hashes/SRI and installed bytes; it does not require identical path spellings.
Those absolute paths stay internal and never enter the sanitized context.
Diagnostic apply validates the immutable reference graph, selected Expo
configuration and TypeScript before advancing state. It must not run floating
`expo install --fix`/`--check` or doctor recommendations that change or judge the
target against a newer remote SDK patch. Managed baseline semver ranges may be
pinned to the exact verified reference resolutions; the consumer accepts only
those pins, not a newer patch or rewritten custom declarations. Production
validation remains unchanged.
Replay requires a standalone npm project; do not install through a parent
workspace or use peer-dependency/validation bypasses to force the selected graph.
End diagnostic `/check-updates` after its coupled upgrade/repair is validated
(or declined/blocked). Do not follow it with generic dependency maintenance,
floating Expo checks/fixes or doctor recommendations. Report only checkpoints
that actually ran; a separate read-only advisory audit does not authorize updates.

Creation into a new/empty directory may use `mobile-template-lifecycle.js acquire
--destination "<working_dir>" --diagnostic-artifacts "<manifest.json>"` after
separate acquisition approval. It invokes the packed template CLI and stages its
verified local packages/reference lock; it never installs dependencies. Approve
`npm ci` separately. Existing customer apps never use acquisition.
An `upgrade-inspection-only` template is explicitly rejected before destination
writes; it is only evidence for an existing-app diagnostic upgrade. Do not
reconstruct a scaffold or borrow its staging source/lock to evade that boundary.

`/edit-app` and `/add-native` may use only capabilities in this validated Android
test inventory. `/debug-app` compares the app's **required counter** to the
selected APK's **actual supported counters** returned by planning; a mismatch
means an approved migration or a different explicitly verified player, not an npm
install or metadata rewrite. No automatic device discovery is needed.
`/deploy` must reject this mode before build/push. Never upload the diagnostic to
a tenant, wrap it for distribution, publish it, or submit it to a store.

## Immutable creation

After the user approves acquisition and installation, use:

```bash
node "${PLUGIN_ROOT}/scripts/mobile-template-lifecycle.js" acquire \
  --release "<release-id>" --destination "<new-empty-directory>"
```

The helper installs the exact template package in a private temporary directory
with install scripts disabled, checks its lockfile integrity before executing
its CLI, compares `--manifest`, and scaffolds only a new/empty destination. It
does not install app dependencies. Use the shipped lockfile with `npm ci` after
approval, then resolve the resulting app release before preparation. If package
publication, authentication, CLI support, manifest, or integrity checks fail,
stop; never fall back to `degit`, a mutable branch, or copying a bundled template.
Failed creation may leave a partial target: report it and preserve it for review,
do not overwrite it on retry.

Keep scaffolded `AGENTS.md`, `CLAUDE.md`, and `.github/copilot-instructions.md`.
Existing apps opt into instruction changes through a separate reviewed merge;
upgrades never silently replace or delete them.

## Coordinated upgrade or repair

Use `/check-updates` for the full approval/rollback workflow. Its read-only
decision helper runs even if `npm outdated` reports no host update:

```bash
node "${PLUGIN_ROOT}/scripts/mobile-template-lifecycle.js" plan \
  --project-root "<working_dir>" --release "<release-id>"
```

An equal supported target is valid. A stale template still needs migrations
when the host is already at target; a host-only repair does not require template
advancement. Downgrades and runtime-ID changes without a published migration
are blocked. No independent host, Expo, React Native, controls, or other native
package bumps are permitted.

At planning, a runtime counter/fingerprint or Expo/React Native transition must
target a **new host and template package major**, not only new runtime counters.
Published paths require stable versions. Scaffoldable local diagnostics and
controlled private prerelease targets must also satisfy this transition rule.
Previously verified `0.x` source-version `upgrade-inspection-only` artifacts
instead report the required production major and cannot claim to satisfy that
production release requirement.

The currently supported `upgrade-template` CLI previews **one edge** per call
with `--dry-run`. It has no promised JSON/multi-edge planning API or
`--from-version` flag. `--no-install` does not advance template state. A nonzero
dry-run can mean conflicts, not just a broken command. Diagnose its sanitized
output; never treat every failure as a clean preview or apply it to the real app.

To approve a whole chain, first rehearse it in a user-approved private disposable
copy of the app, with the exact target host, normal validated installs, and a
separate preview and diff for **every edge**. Record source/target state and
customer conflicts throughout. Stop on conflicts, no progress, skipped edges,
overshoot, unsupported CLI behavior, or an interrupted journal. Never guess
later operations from the first preview. If a complete safe rehearsal cannot
be produced, block the real upgrade and report the missing contract.

Review the aggregate diff, installs, runtime/base/player change, and recovery
plan with the user before touching the real app. Approval of the rehearsal is
not approval of application. Preserve local uncommitted changes with a bounded
file snapshot; never use a Git reset. Recheck source bytes and dependency state
after approval. Any changed input or newly discovered operation invalidates
approval. Apply only the reviewed sequence and validate after each edge.

## Controls and binary boundaries

Use controls only when the resolved inventory includes them. Existing aggregate
controls are `@microsoft/power-apps-native-controls/pdf`, `/pen`, and
`/geolocation`; the root exports metadata, not these native functions.
An older binary cannot acquire those native modules through an npm install.

Dependency inclusion, signed OS declarations, runtime permission grants, and
actually using a control are different. The existing aggregate retains its
Android library declarations even when a control is unused. A fixed-capability
base may contain unused compiled code. Different declarations require another
verified base build. Per-customer optional-permission selection during wrapping
is not part of this workflow.

## Deployment and diagnostics

For each target platform, verify the **actual intended base** before packaging,
again before push if anything changed:

```bash
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" \
  --project-root "<working_dir>" --platform android \
  --base-version "<actual-base-version>" --base-fingerprint "<actual-base-fingerprint>"
```

Use `ios` independently for iOS. Obtain both values from the selected deployment
target, not by copying expected policy values just to pass. If the target
cannot expose a verifiable version/fingerprint, block native deployment rather
than infer it from Hermes bytecode or the npm host. Preserve deployment approval,
first-app-ID regeneration, and offline reconciliation gates.

When debugging or reporting, include only the helper's sanitized tuple and
whether resolution succeeded. Do not attach full manifests, auth/config files,
logs, reject files, dependency snapshots, or tenant identifiers. A compatibility
failure is not permission to patch first-party packages or suppress diagnostics.
