# Mobile release compatibility

Use package-owned compatibility for creation, native changes, upgrades, previews,
and deployment. npm identifies published versions; the selected host supplies its
template/native requirements and migrations. The matching immutable template
supplies dependency declarations and locked native versions. A newer npm package,
matching Hermes header, or successful TypeScript build does not prove that a
player or wrapped binary contains the same native runtime.

## Resolve before native work

```bash
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root '<working_dir>'
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
Tenant settings such as `tenantMode`, `appDisplayName`, `appName` and
`tenantPolicy` may share the `powerappsNative` object. Read only the three
protected compatibility fields for release selection, and preserve the
remaining app-owned configuration. Tenant configuration is not native release
evidence and must not be included in sanitized release/telemetry summaries.

`--requirements-only` reads the recorded source and installed host identity for
**upgrade planning**, even when installed dependencies have drifted. It does not
query npm or require a historical release record. It is not a native admission or
deployment check. Source/UI-only work can continue without claiming native
compatibility; adding or updating dependencies still needs explicit validation.

## Published package selection

There is no plugin-owned release catalogue to populate or republish. Keep
`npm outdated --json --depth=0` for update discovery and select an exact stable
host version from the supported npm channel. The resolver uses npm's configured
registry/authentication without reading or printing credentials. It downloads
archives with scripts disabled into temporary private storage, checks published
integrity and contained archive paths, reads package metadata without executing
package code, and removes its scratch files.
Template archives require sha512 integrity. Historical host packages that only
publish npm's SHA-1 shasum retain verification against that exact registry digest;
the helper never treats a missing hash as success.

The published host's `compatibility/current.json` owns target template/runtime
requirements, managed dependencies and migration references. A matching published
template's protected metadata and packaged lock provide the immutable native
inventory, including nested packages. The app's own lock is checked against that
reference; it is not allowed to declare new native packages compatible with a
fixed binary. Missing or malformed metadata, fingerprint disagreement, an
unpublished/unfinalized target, and dependency drift remain blockers.

Inspect a target without changing the app:

```bash
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --host-version "<exact-host-version>"
```

For creation, inspect `--template-version "<exact-template-version>"` and acquire
that immutable package only after approval. For an upgrade, use
`mobile-template-lifecycle.js plan --project-root '<working_dir>' --host-version
"<exact-host-version>"`, then acquire the approved host into a separate empty
tooling directory. The host CLI, not the skill, owns migration writes and install
validation. Never independently upgrade every native dependency to npm `latest`.

Isolated acquisition retains the caller's effective project npm settings and
the original user/global configuration precedence. A project `.npmrc`, including
scoped registry authentication, exists only in the private installation directory
during npm execution and is removed on success or failure before invoking a
creation CLI. npm runs from the original context with an explicit isolated
prefix, global mode off and workspaces off, so relative TLS/auth file paths keep
their meaning without installing into the old app's dependency graph.
Credentials are never emitted in results or copied into the created app.
Template creation CLIs must be self-contained: dependency declarations,
bundled dependencies or unexpected acquired packages block execution even when
the template's own archive integrity matches.

For a proposed new app directory, the creation owner first runs
`mobile-template-lifecycle.js destination --destination '<proposed_working_dir>'`
from an existing parent. This only binds a canonical destination; acquisition
still needs approval. Existing-app and continuation flows cannot use this
creation-only exception to bypass missing-root checks.

Managed native registry ranges are checked against their exact inventory
versions with the bundled npm SemVer implementation. Reviewed vendor archives
retain their separate archive validation. Explicit template selections remain
attached to subsequent project resolution rather than silently choosing a
different, newer template with the same runtime.

Package compatibility and binary availability are separate. A same-runtime
patch/minor host update needs no new Player/base record. Native changes need a
host major, a template migration and matching native binaries before those
features can run. Compare actual Player metadata when available; do not invent
store availability or a future release date. Wrap must supply and verify its
selected base's version, native runtime and fingerprint before deployment.
The resolver reports binary availability as **not checked**, not success.

Do not invent missing package metadata or CLI flags. The template CLI's
`--manifest` reports package identity and template/runtime requirements, not
store readiness. Package inspection uses npm and `tar`; native build tools are
not prerequisites.

## Published package verification and rehearsal

The former local diagnostic artifact mode is retired. Missing or unfinalized
publications block native adoption; do not substitute local archives, a mutable
Git checkout or the plugin's bundled template. Package archive inspection keeps
the archive and extraction in one private scratch directory for Windows drive
safety, rejects links and unsafe paths, and removes scratch on success or failure.

For hosts advertising a versioned offline contract, the installed SDK's exact
version and integrity must match the selected published template lock. Its host
and React Native peers, runtime family, offline-contract version, Hermes/New
Architecture declarations and native artifact hashes must agree with the
published host. Read the expected SDK contract and complete declared native
artifact inventory from its integrity-verified registry archive, bound to the
immutable template lock's SHA-512 integrity. Compare the installed metadata and
every declared artifact against that reference; editing a local manifest or
removing one of its entries cannot authorize changed native files. Archive
inspection never installs packages or runs their lifecycle scripts. Missing or
unverifiable publication evidence blocks admission rather than trusting local
hashes. Historical hosts without that contract retain their existing
native admission rules; do not invent new metadata for them.
Do not delete profiles, disable offline or remove SDK imports to make validation
pass. Preserve app-owned source, settings, overrides, database contents and pending
writes. Offline synchronization, disconnected cold launch and database upgrades
need separate device tests. A source manifest or profile is not evidence of a
matching binary.

Use the **verified reference installation's target host CLI** for rehearsal, not
an older app's host or an invented target. Resolve its real `package.json`
`bin["upgrade-template"]` path. Restore the preview's source dependencies from its
unchanged source lock before reading inherited TypeScript configurations.
Do not use target-reference `NODE_PATH` instead of the source dependency context.
Preview one edge with `--project '<preview_dir>' --dry-run`, then apply only an
approved clean edge with the same CLI and its normal validated installation.
An intermediate write-only operation must use `--no-install` separately; it
does not advance state and is not completed migration.

An incompatible retained direct-dependency override is a blocking preview, not
permission to delete a customer pin or bypass npm `EOVERRIDE`. Review and approve
the exact override resolution, then rerun the preview. Keep test-fixture-only
pins distinguishable from genuine customer customizations.
Published migrations use the host-owned strict npm installer and guarded lock
regeneration. A broken published CLI requires a producer fix; do not locally
rewrite first-party packages or use Player-build scripts to repair an app.
After every edge, re-resolve the app and run changed-file validation before
advancing through the reviewed migration chain.

Compare app requirements with the actual supported counters of a selected Player
when available. A mismatch requires a matching binary or an approved migration,
never rewriting compatibility labels. Package publication does not establish
store availability or device qualification.

## Immutable creation

After the user approves acquisition and installation, use:

```bash
node "${PLUGIN_ROOT}/scripts/mobile-template-lifecycle.js" acquire \
  --template-version "<exact-template-version>" --destination '<new-empty-directory>'
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
  --project-root '<working_dir>' --host-version "<exact-host-version>"
```

An equal supported target is valid. A stale template still needs migrations
when the host is already at target; a host-only repair does not require template
advancement. Reject lower target host versions or recorded template/native
versions; never infer an old template package version from a runtime counter.
Runtime counter or fingerprint changes require a published template migration.
No independent host, Expo, React Native, controls, or other native package bumps
are permitted.

At published planning, a native transition must target a **new host major** and
a host-owned template migration, not only new runtime counters. Producers own
the coordinated host/template release-version rules.
Published host and template identities require exact stable versions; prerelease
hosts are restricted to the diagnostic contract. Scaffoldable local diagnostics and controlled private prerelease targets require
a new host and template package major for a native transition.
Previously verified `0.x` source-version `upgrade-inspection-only` artifacts
instead report the required production major and cannot claim to satisfy that
production release requirement.

The currently supported `upgrade-template` CLI previews **one edge** per call
with `--dry-run`. It has no promised JSON/multi-edge planning API or
`--from-version` flag. `--no-install` does not advance template state. A nonzero
dry-run can mean conflicts, not just a broken command. Diagnose its sanitized
output; never treat every failure as a clean preview or apply it to the real app.

Keep the target CLI outside the source dependency graph. For a published
release, reuse `mobile-template-lifecycle.js acquire` with a new private
tooling directory and `--host-version "<exact-host-version>"`. The helper installs
that exact host with scripts disabled, verifies its registry/lock integrity,
and resolves its installed host's actual `bin["upgrade-template"]` path.
Review any required lifecycle scripts before separately approving them.
The tooling directory is not a scaffold and its lock never replaces the app lock.
Use that same verified CLI with `--project` for both the disposable rehearsal
and the separately approved real application. Diagnostic mode already supplies
its immutable reference. Neither path preinstalls an incompatible target host
into the old app, chooses `latest`, or re-scaffolds over customer files.

The host owns dependency edits, guarded lock regeneration and validation.
For changed standalone npm inputs it resolves in isolation, checks retained
direct dependency versions, then installs with strict `npm ci`. It never copies
the reference/template lock over the customer's lock; phase rollback retains
the original. Workspace and shrinkwrap upgrades keep their package-manager
boundary and strict in-place resolution, with conflicts requiring review.
Do not duplicate this installer in a skill or invoke migration-authoring,
runtime-preparation, release-tagging or Player-build scripts on a customer app.
An older published host without a safe install path requires a producer fix,
not a force/legacy-peer bypass or a skill-authored repair.

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
  --project-root '<working_dir>' --platform android \
  --base-version "<actual-base-version>" --base-fingerprint "<actual-base-fingerprint>" \
  --base-runtime-version "<actual-base-runtime-version>"
```

Use `ios` independently for iOS. Obtain all three values (base version, native
fingerprint and native runtime counter) from the selected deployment target,
not by copying expected policy values just to pass. If the target cannot expose
a verifiable version, fingerprint and runtime counter, block native deployment rather
than infer it from Hermes bytecode or the npm host. Preserve deployment approval,
first-app-ID regeneration, and offline reconciliation gates.
`--platform` always requires `--project-root`: inspecting a catalogue default
or named release alone is not deployment admission.

When debugging or reporting, include only the helper's sanitized tuple and
whether resolution succeeded. Do not attach full manifests, auth/config files,
logs, reject files, dependency snapshots, or tenant identifiers. A compatibility
failure is not permission to patch first-party packages or suppress diagnostics.
