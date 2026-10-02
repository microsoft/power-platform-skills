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
block. Do not work around this with `latest`, a bundled snapshot, local overrides,
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
