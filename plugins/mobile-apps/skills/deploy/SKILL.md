---
name: deploy
description: Use to deploy, publish, or push an Expo/React Native Power Apps mobile app to a Power Platform tenant.
user-invocable: true
allowed-tools: Read, Glob, Bash, AskUserQuestion, Skill
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` - if it outputs a message, show it to the user before proceeding.

**📋 Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

# Deploy

Builds the mobile app in the current directory and pushes it to the Power Platform environment recorded in `power.config.json`.

This skill checks the app-matched verified release and actual selected bases
before building and pushing. Read
[release lifecycle](../../shared/references/mobile-release-lifecycle.md).
Native compatibility is a separate gate from artifact format, environment
confirmation, offline coverage, and TypeScript.

## Out of scope (deliberately)

- `expo run:ios` / `expo run:android` — local native compile is the user's choice; run your platform-specific native command directly when ready.
- OTA updates and store distribution — out of scope for v0.
- Starting Metro for local dev — created apps use `npm run dev`; template Metro config writes `.powernative` logs for `/debug-app`.

## Workflow

1. Check memory bank → 1.2 Verified release + selected bases → 1.3 Build/upload contract → 1.5 App ID preflight → 2. Web build → 2.4 Native packages + staging → 2.5 Offline profile coverage gate → 3. Deploy → 4. Update memory bank

---

### Step 1 — Check memory bank

Read `memory-bank.md` from the project root if present. Capture:

- Project name
- Environment (id + display name)
- Current version

If absent, continue — the project may have been created without the plugin. Re-derive env from `power.config.json` if needed.

### Step 1.2 — Verified release and actual intended bases

Reject any `--diagnostic-artifacts` selection or `local-diagnostic-only` context
before building or pushing. Local test archives and APK metadata never authorize
tenant/store deployment, even when their hashes and counters match. Do not
silently replace the selection with a published/default release.

Resolve the app's installed/locked template, host, Expo, React Native, and
native inventory; never use the newest bundled template as its runtime allowlist.

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root '<working_dir>'
```

Then obtain the **actual intended base version, native runtime version and fingerprint** for each target
from the selected deployment target's verifiable metadata. Do not silently
substitute the policy's expected values, assume “latest”, or claim a player/base
is available because its package exists on npm. Missing selection is a blocker.
If the target cannot expose these values, STOP; a version label alone does not
prove matching native runtime content.

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root '<working_dir>' --platform android --base-version "<actual-intended-android-base-version>" --base-fingerprint "<actual-intended-android-base-fingerprint>" --base-runtime-version "<actual-intended-android-runtime-version>" || exit $?
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root '<working_dir>' --platform ios --base-version "<actual-intended-ios-base-version>" --base-fingerprint "<actual-intended-ios-base-fingerprint>" --base-runtime-version "<actual-intended-ios-runtime-version>" || exit $?
```

Every resolver invocation must succeed. Unknown/missing package contracts or base metadata
STOP before build/push. npm publication does not attest regional base availability;
that selection and publication check belongs to Wrap, not a skills catalogue.
Each deployment check requires `--platform`, `--base-version`, and
`--base-fingerprint` together, plus `--base-runtime-version`. The native runtime
and fingerprint must exactly match the published host contract; a missing or mismatched fingerprint blocks.
`--requirements-only` is planning-only and cannot authorize deployment.
There is no `deploy without compatibility` override. A successful web preview,
Metro run, native import, or Hermes magic check is not evidence of native
compatibility. A newer plugin/template is not an app upgrade.

Keep only the sanitized resolved tuple and selected base versions/fingerprints in the
deployment summary; never dump raw app/auth/config files. Re-run these checks
before each push and after any manifest, lockfile, host, native inventory, or
base selection change, including the first-deploy second pass.

Package inclusion, OS declarations, runtime grants, and actual use remain
distinct. Disabling controls does not remove unused default Android permissions.
Different declarations require another verified base; optional per-customer
permission wrapping is deferred. Do not edit plugins/permissions or run a local
native build to bypass a mismatch.

### Step 1.3 — Resolve the build and upload directories

From the same `<working_dir>`, inspect the app's `package.json`, installed Host
documentation/scripts, and `power.config.json`. Resolve the installed CLI per
[cli-binary.md](../../shared/cli-binary.md). Record the web output directory,
native output directory, configured upload directory, and web entry point
before running a build.

For the published Host **1.0.4** / template package **0.1.4**, the contract is:

| App command | Output | Owner |
|---|---|---|
| `npm run bundle:web` | `dist-web/index.html` and the complete hosted web assets | Host `js-bundle web`, including hosted-path handling |
| `npm run bundle:android` | `dist/index.android.bundle.hbc` and `dist/powerapps-customer-assets-android/` | Host native package producer |
| `npm run bundle:ios` | `dist/main.jsbundle.hbc` and `dist/powerapps-customer-assets-ios/` | Host native package producer |

These are version-specific examples, not pins or permission to update an older
app. Prefer the app's supported `bundle:web` command. If an older/customized app
uses a declared `build` script instead, inspect its installed release contract
and review its actual outputs; do not invent aliases, fetch newer tooling, or
fall back to a raw Expo export that omits Host-owned web preparation.

The grouped `pa` CLI uses `buildPath` and `buildEntryPoint` in
`power.config.json`; legacy CLIs may use `distPath`. Follow the selected CLI's
actual configuration semantics. Do not assume that it uploads `dist/`, and do
not change `appType`, `appId`, environment, or the configured upload directory
just to accommodate the build output. Missing, conflicting, or unsupported
configuration requires review before proceeding.

Resolve all output paths within the app and reject symlinks, paths outside the
app, and destinations overlapping source, configuration, `.git`, or
`node_modules`. Before **each** build/push cycle, identify and obtain approval
to clear only confirmed generated build outputs, including any separate upload
directory. Preserve source and configuration; never clear the app root or an
unreviewed custom directory. A previous build must not satisfy this run's checks.

### Step 1.5 — App ID preflight (first-deploy gate)

Read `power.config.json` **before building anything**:

```bash
cd -- '<working_dir>' || exit $?
node -e "const c=require('./power.config.json');console.log(c.appId||'MISSING')"
```

- **Prints a GUID** → normal path. Continue to Step 2.
- **Prints `MISSING`** (null, absent, or empty) → this is a **first deploy**. Say so plainly *before* doing any work:

  > "⚠️ First deploy detected — `power.config.json` has no `appId` yet. The app ID is minted by the first push, but it is compiled **into** the native bundle at build time. So two full build+push cycles are required. I'll run both; the second is not optional."

  Then run Steps 2 → 2.4 → 2.5 → 3 **twice**. In cycle 2, the web build, both native packaging commands, staging, and final upload verification must all re-run — the Hermes bundles from cycle 1 have an empty app ID compiled in. Step 2.5 (offline profile gate) may be skipped on cycle 2 **only if** no schema or profile file changed between the two cycles; if in doubt, re-run it — it is a local, no-network check.

**Why two cycles are unavoidable.** The first app push mints the app ID and writes it back to `power.config.json`, but it refuses to run at all without an existing build — it fails immediately if the configured upload directory is absent. So the ID cannot be minted before the first build, and the first build cannot contain the ID.

**Why this is so easy to miss.** The runtime guard is:

```js
Platform.OS !== 'web' && !isDevPlayer && !hasConfiguredValue(powerConfig.appId)
```

Web is **exempt**, and so is Dev Player. The Code App, `npm run dev`, and the browser preview all look perfectly healthy. The failure appears only in the **wrapped native app**, as a full-screen red *"App ID is missing — Push the mobile app to the Power Platform environment, rebuild it, and try again."* That is after a base-package wrap, a signed build, and a device install — the most expensive possible place to discover a one-line config gap.

### Step 2 — Build

**Telemetry checkpoint: `build_power_apps_bundle`**

**Print before starting:**
> "→ Building the production web bundle with the app's published Host command. ~30–90 seconds."

Regenerate `connectorSchemas.ts` so the bundled schema map reflects every
connector currently in `.power/schemas/`, then type-check. Do not assume `predev`
or a bundle command performs both checks. With the current template's scripts:

```bash
cd -- '<working_dir>' || exit $?
npm run generate-schemas || exit $?
npm run type-check || exit $?
npm run bundle:web || exit $?
```

For a different supported script contract, use the commands and output directory
reviewed in Step 1.3. If TypeScript is declared without a `type-check` script,
use the installed `npx --no-install tsc --noEmit`; do not add scripts or silently
skip type-checking.

Wait for the package-owned command to exit successfully. The Host owns export
completion handling and hosted web postprocessing. Do not duplicate its logic
with a detached raw Expo command, log-marker polling, or manually killing a
process and treating existing files as success. A nonzero exit or timeout blocks
deployment even when an output directory exists.

If the build fails:

- **`TS6133` (unused import)** → remove the import and retry once.
- **Other TypeScript errors** → report file + line and STOP. Don't deploy a broken build.
- **Metro bundler errors** → surface the full stack and STOP.

Verify the reviewed web output contains its entry point and complete generated
assets before continuing. For the contract above this is `dist-web/index.html`,
not yet the final upload directory. Do not copy only `index.html`.

### Step 2.4 — Native package (Hermes bundle + customer assets)

**Print before starting:**
> "→ Compiling the native Hermes bundle and hash-addressed asset package for iOS and Android. No JavaScript is compiled inside the wrap pipeline — it only consumes these prebuilt files. ~1–3 minutes."

**Node version gate (required).** Follow
[version-check.md](../../shared/version-check.md) and any higher engine
requirements of the resolved release. Check the common Node 22+ floor first:

```bash
node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 22) { console.error("Node 22+ required; also check resolved release engines"); process.exit(1); }'
```
If this or a release-specific engine check fails, STOP and ask the user to
switch to a supported Node version. Do not fetch newer native dependencies.

The web build above produces the hosted entry point in the reviewed web output
directory (`dist-web/` for the current contract). Native **wrapped** apps
additionally need a precompiled Hermes bundle **and** the customer's images/fonts
as hash-addressed asset files, so the wrap pipeline never compiles or downloads
JavaScript. Produce both platforms:

```bash
cd -- '<working_dir>' || exit $?
npm run bundle:android || exit $?
npm run bundle:ios || exit $?
```

Each current Host command produces that platform's native Hermes bundle **and**
its customer asset package under `dist/`, separately from the web output:

- **Android:** `dist/index.android.bundle.hbc` (Hermes bytecode) + `dist/powerapps-customer-assets-android/` (`manifest.json` + `assets/<fileHash>.<type>`)
- **iOS:** `dist/main.jsbundle.hbc` (Hermes bytecode) + `dist/powerapps-customer-assets-ios/` (`manifest.json` + `assets/<fileHash>.<type>`)

Both platforms are required — the verification below fails if either bundle or either manifest is missing.

#### Stage one complete upload directory

After the web build and **both** native commands succeed in this pass, assemble
the configured upload directory recorded in Step 1.3:

1. Copy the **complete web output**, preserving relative paths, including
   `index.html`, `_expo/`, assets, and any other generated web files.
2. Place both `.hbc` files and both complete platform asset directories at that
   same upload root. Preserve their manifests, hashed assets, and any packaged
   Firebase client files byte-for-byte. Do not rewrite manifests or their hashes.
3. If an output already is the upload directory, leave it in place and copy only
   the other outputs. Do not copy a directory onto itself, nest `dist-web/`
   inside the upload root, or overwrite a conflicting web/native path.
4. Recheck the final upload contents after copying. Never upload source,
   dependencies, or files left over from a previous build.

For the current contract **only when the reviewed upload directory is `dist/`**,
the native producer has already placed its files at the upload root. After the
path/cleanup checks above, stage the complete web output into it:

```bash
cd -- '<working_dir>' || exit $?
test -f dist-web/index.html || { echo "MISSING web entry"; exit 1; }
test -f dist/index.android.bundle.hbc || { echo "MISSING android bundle"; exit 1; }
test -f dist/main.jsbundle.hbc || { echo "MISSING ios bundle"; exit 1; }
test -f dist/powerapps-customer-assets-android/manifest.json || { echo "MISSING android manifest"; exit 1; }
test -f dist/powerapps-customer-assets-ios/manifest.json || { echo "MISSING ios manifest"; exit 1; }
cp -R dist-web/. dist/ || exit $?
```

For a reviewed `dist-web/` upload directory, the web files are already in place;
copy the two native bundles and complete platform asset directories there
instead. For a custom generated upload directory, copy both output sets there.
Preserve `power.config.json`; an unsupported path/layout requires review, not
an automatic configuration rewrite. Rebuild before restaging if a later command
cleared or changed an output.

All files must be siblings under the same uploaded root so Wrap can fetch the
native bundles and matching asset directories next to the web entry point.

**Verify before continuing** — STOP on any failure (never push a web-only build for a native-wrapped app):

This checks packaging only. Hermes magic bytes identify the file format, not
bytecode/engine ABI, Expo/RN, native module, player, or selected-base
compatibility; Step 1.2 must also pass for both platforms.

```bash
cd -- '<reviewed-upload-root>' || exit $?
test -f index.html || { echo "MISSING web entry"; exit 1; }
# Hermes magic bytes on both bundles (expect c61fbc03)
for f in index.android.bundle.hbc main.jsbundle.hbc; do
  test -f "$f" || { echo "MISSING $f"; exit 1; }
  node -e 'const fs=require("fs"),b=Buffer.alloc(4),fd=fs.openSync(process.argv[1],"r");fs.readSync(fd,b,0,4,0);fs.closeSync(fd);process.exit(b.toString("hex")==="c61fbc03"?0:1)' "$f" || { echo "$f is not Hermes bytecode"; exit 1; }
done
# both asset manifests present
test -f powerapps-customer-assets-android/manifest.json || { echo "MISSING android manifest"; exit 1; }
test -f powerapps-customer-assets-ios/manifest.json     || { echo "MISSING ios manifest"; exit 1; }
echo "✓ native package + asset manifests present"
```

The example expects the current Host's `index.html` entry point. If the reviewed
release uses another entry point, verify the configured file instead. Confirm
each manifest's platform, bundle path/hash, and referenced assets agree with the
staged files; file presence alone is not an integrity check.

If a native packaging step fails, surface the error and STOP. If the app renders bundled images/fonts, also confirm each `manifest.json` `assets` array is non-empty (an empty array means the app doesn't `require()` any static asset yet).

### Step 2.5 — Offline profile coverage gate

**Telemetry checkpoint: `validate_offline_profile_coverage`**

This is the final chance to catch schema that never made it into the Mobile Offline Profile before it ships — a table added to the data model but not the profile never syncs to devices, and a new column arrives blank offline. Validate that every schema change is covered **before** pushing.

For this offline gate, first resolve the approved app's absolute `working_dir`
using [app-working-directory.md](${PLUGIN_ROOT}/shared/references/app-working-directory.md)
before running the check below or any helper. Bind every offline check, file
read, and helper call to that same root.

Run the local, no-network delta check (`.datamodel-manifest.json` vs `offline-profile.json`):

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/offline-profile-delta.js" --project-root '<working_dir>'
```

Branch on the JSON `status` (full contract in [offline-profile-reconciliation.md](${PLUGIN_ROOT}/shared/references/offline-profile-reconciliation.md)):

| `status` | Action |
|---|---|
| `no-manifest` | Connectors-only app — no Dataverse schema. Continue to Step 3 silently. |
| `no-profile` | No offline profile in this project. Print one line: `↷ No offline profile — skipping offline coverage check. Run /setup-offline-profile if you want offline support.` Continue to Step 3. |
| `in-sync` | Print `✓ Offline profile covers all schema changes.` Continue to Step 3. |
| `error` | `offline-profile.json` is unreadable — the script prints `status: error` and **exits non-zero**. Offline coverage can't be validated against a corrupt file, so **STOP before pushing**: surface the `error` string and have the user fix `offline-profile.json` and re-run, or type the `deploy without offline` override (below) to push anyway. |
| `delta` | **STOP before pushing.** See below. |

**On `delta`** — print the uncovered schema, then gate with `AskUserQuestion`:

```
⚠ The offline profile is missing schema changes. If you deploy now, these won't be
  available on disconnected devices:

  Tables not in the profile : <missingTables[].logicalName>
  Tables with new columns   : <tablesWithNewColumns[].logicalName (newColumns)>
```

Options:

- **Update the offline profile now (recommended)** — use the reconciliation reference's **Scoped helper handoffs** with `orchestrator: deploy`, absolute `working_dir`, `phase: implementation`, and the approved environment/profile/table scope. Read and execute `${PLUGIN_ROOT}/skills/add-table-to-offline-profile/SKILL.md` with `--working-dir '<working_dir>' --table <t>` for each approved `missingTables[]` entry, then `${PLUGIN_ROOT}/skills/edit-offline-profile/SKILL.md` with those arguments plus `--columns add:<newColumns>` for each approved `tablesWithNewColumns[]` entry. Re-run the guarded delta check; when it reports `in-sync`, continue to Step 3.
- **Deploy anyway** — requires an explicit override. Wait for the exact phrase `deploy without offline` (case-insensitive); a bare `y`/`yes` is not enough, mirroring the environment-mismatch gate in Step 3. Then continue to Step 3 and note the skipped reconciliation in the Step 4 build-history row.

Do not push until the gate is resolved (reconciled to `in-sync`, or explicitly overridden).

### Step 3 — Deploy

**Telemetry checkpoint: `push_app_to_power_platform`**

Re-run Step 1.2 for the app and both actual intended base versions and
fingerprints before this push. Neither the environment override nor the
offline override can waive it.
Also recheck the Step 1.3 upload path and entry point against the unchanged
configuration, and verify the complete staged payload from this build pass.

**Resolve and confirm the target environment FIRST.** `pa app push` deploys to the environment configured in `power.config.json`. Resolve that ID to a Dataverse URL so the user catches drift before pushing.

Run:

```bash
cd -- '<working_dir>' || exit $?
ENV_ID=$(node -e "console.log(require('./power.config.json').environmentId)")
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$ENV_ID"
```

From `resolve-environment.js` capture the **Environment URL** (e.g. `https://contoso.crm.dynamics.com/`), **Environment ID**, and **Tenant ID**. Cross-check against `memory-bank.md` / `power.config.json`:

- **Match** → proceed to the confirmation prompt below.
- **Mismatch** → STOP. Surface both values side-by-side and ask the user to either (a) update `power.config.json` by re-running init in the intended app root, or (b) explicitly type `override` to push to the environment already recorded in `power.config.json`. Do not proceed on a bare `y`.
- **Cannot resolve/authenticate** → STOP with `az login --tenant <env-tenant>` instructions, or ask the user to provide the environment URL directly.

**Print before starting:**
> "→ Pushing bundle to Power Platform via `pa app push`. ~30–60 seconds."

Confirm with the user using the **resolved env URL, not just the friendly name**:

> "Ready to deploy to **<env-name>** (`<env-url>`)? This will update the live app for every user in that environment. Type `yes deploy to <env-name>` to confirm."

Wait for the exact phrase `yes deploy to <env-name>` (case-insensitive, env-name matching). A bare `y` / `yes` is not enough — too easy to fire on autopilot when the wrong env is active. Then:

> Resolve the CLI first (see [cli-binary.md](${PLUGIN_ROOT}/shared/cli-binary.md)): run as `$PA app push` (`npx --no-install pa …`), never a bare `pa`. On `power-apps`-only projects, translate to `power-apps push`.

```bash
cd -- '<working_dir>' || exit $?
$PA app push --non-interactive
```

Capture the app URL from the output if printed.

**First-deploy loop-back.** If Step 1.5 reported `MISSING`, re-read the config now:

```bash
cd -- '<working_dir>' || exit $?
node -e "const c=require('./power.config.json');console.log(c.appId||'STILL MISSING')"
```

- **GUID** → the app was registered. **Go back to Step 2 and run Web build → 2.4 Native packages + staging → 2.5 → Deploy one more time.** Clear only the reviewed generated outputs as in Step 1.3, then rebuild and restage everything: the first payload still has an empty app ID compiled in. Without this second cycle the wrapped app fails on-device. Step 2.5 may be skipped on this second pass **only if** nothing under `.datamodel-manifest.json` / `offline-profile.json` changed since cycle 1.
- **`STILL MISSING`** → push did not register the app. STOP and report. Do not proceed to wrap.

On the second pass this check is a no-op, and Step 4 runs as normal.

If deploy fails, report the error and STOP — do not retry silently. Common fixes:

| Error | Fix |
|---|---|
| `pa app push` auth error, wrong user, or multiple accounts | Follow shared-instructions command-failure handling. `az login` / `az account set` does not switch the standalone Power Apps CLI account. |
| Environment mismatch | Re-run `$PA app init -t MobileApp --display-name <name> --environment-id <id> --non-interactive` in a fresh/app root for the intended target|
| `$PA` is empty (`PA_KIND=none` — CLI not installed) | Ask the user to restore the resolved release's existing exact locked dependencies in the project root, then re-resolve `$PA` per [cli-binary.md](${PLUGIN_ROOT}/shared/cli-binary.md). Never fall back to a bare `npx pa` or `npx power-apps`, a newer host/native package or an unrelated global CLI. |

### Step 4 — Update memory bank

If `memory-bank.md` exists, increment the version (`v1.0.0` → `v1.1.0`) and update:

- Current version
- Last deployed timestamp
- App URL (if captured)
- Append a row to the **Build history** section: `| v1.1.0 | <timestamp> | deploy | success |`
- Record the sanitized verified release tuple and both actual selected base
  versions/fingerprints; record native device validation separately from packaging success.

Print the summary card:

```
✅ Deploy — <project-name>
─────────────────────────────────────────────
Version       : <new-version>
Environment   : <env-name>
App URL       : <url or "see make.powerapps.com">
Bundle path   : <reviewed configured upload directory>

Local dev:    npm run dev  (writes .powernative logs for /debug-app)
Re-deploy:    /deploy
List conns:   /list-connections
─────────────────────────────────────────────
```

---

## Local dev (out of scope for this skill — for reference only)

When the user wants normal Expo iteration with portable monitoring, they can run:

```bash
npm run dev          # Metro + QR + .powernative log
```

This launches Metro, prints a QR code, and writes sanitized output to `.powernative/metro-logs/` so `/debug-app` can reattach after a host/session restart. They can:

- Scan the QR with the installed native dev client
- Reload from the native dev-client menu

Do not use React Native Web, browser automation, direct Metro/localhost HTTP probes, or screen-by-screen runtime checks.

If they want to compile a native binary locally, they run the platform-specific native command directly. Local native compile and manual device testing are user-owned and are not deployment gates for this skill.

## Reference

- [`shared/version-check.md`](${PLUGIN_ROOT}/shared/version-check.md) — min versions (only Always-required tier matters here)
- [`shared/memory-bank.md`](${PLUGIN_ROOT}/shared/memory-bank.md) — Build history schema
- [`shared/references/offline-profile-reconciliation.md`](${PLUGIN_ROOT}/shared/references/offline-profile-reconciliation.md) — Step 2.5 offline coverage gate
