---
name: deploy
description: Use to deploy, publish, or push an Expo/React Native Power Apps mobile app to a Power Platform tenant.
user-invocable: true
allowed-tools: Read, Glob, Bash, AskUserQuestion, Skill
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

# Deploy

Builds the mobile app in the current directory and pushes it to the Power Platform environment recorded in `power.config.json`.

This skill uses the standard 4-step deployment flow for this plugin: check memory bank, build, deploy, then update memory bank.

## Out of scope (deliberately)

- `expo run:ios` / `expo run:android` — local native compile is the user's choice; run your platform-specific native command directly when ready.
- OTA updates and store distribution — out of scope for v0.
- Starting Metro for local dev — run `npm run dev` (= `expo start`) directly.

## Workflow

1. Check memory bank → 1.5 App ID preflight → 2. Build → 2.4 Native package → 2.5 Offline profile coverage gate → 3. Deploy → 4. Update memory bank

---

### Step 1 — Check memory bank

Read `memory-bank.md` from the project root if present. Capture:

- Project name
- Environment (id + display name)
- Current version

If absent, continue — the project may have been created without the plugin. Re-derive env from `power.config.json` if needed.

### Step 1.5 — App ID preflight (first-deploy gate)

Read `power.config.json` **before building anything**:

```bash
node -e "const c=require('./power.config.json');console.log(c.appId||'MISSING')"
```

- **Prints a GUID** → normal path. Continue to Step 2.
- **Prints `MISSING`** (null, absent, or empty) → this is a **first deploy**. Say so plainly *before* doing any work:

  > "⚠️ First deploy detected — `power.config.json` has no `appId` yet. The app ID is minted by the first push, but it is compiled **into** the native bundle at build time. So two full build+push cycles are required. I'll run both; the second is not optional."

  Then run Steps 2 → 2.4 → 2.5 → 3 **twice**. In cycle 2, `npm run build` *and* `npm run package:android` / `package:ios` must all re-run — the Hermes bundles from cycle 1 have an empty app ID compiled in. Step 2.5 (offline profile gate) may be skipped on cycle 2 **only if** no schema or profile file changed between the two cycles; if in doubt, re-run it — it is a local, no-network check.

**Why two cycles are unavoidable.** `power-apps push` mints the app ID and writes it back to `power.config.json`, but it refuses to run at all without an existing build (`PushApp.js`: `throw new Error('Build path ${buildPath} does not exist')`). So the ID cannot be minted before the first build, and the first build cannot contain the ID.

**Why this is so easy to miss.** The runtime guard is:

```js
Platform.OS !== 'web' && !isDevPlayer && !hasConfiguredValue(powerConfig.appId)
```

Web is **exempt**, and so is Dev Player. The Code App, `npm run dev`, and the browser preview all look perfectly healthy. The failure appears only in the **wrapped native app**, as a full-screen red *"App ID is missing — Push the mobile app to the Power Platform environment, rebuild it, and try again."* That is after a base-package wrap, a signed build, and a device install — the most expensive possible place to discover a one-line config gap.

### Step 2 — Build

**Print before starting:**
> "→ Building production web bundle via `npm run build` (= `expo export --platform web`). ~30–90 seconds."

First regenerate `connectorSchemas.ts` so `app/_layout.tsx`'s `schemaMap` import reflects every connector currently in `.power/schemas/`. The npm `prestart`/`preandroid`/`preios` hooks cover dev runs, but `npm run build` does **not** — if a connector was added since the last `npm run dev`, the bundled JS would ship a stale schema map. Always regenerate before build:

```bash
npm run generate-schemas
npm run build
```

If `package.json` has no `build` script, fall back to:

```bash
npx expo export --platform web
```

(The current template does not define a `build` script, so this fallback is the normal path for freshly scaffolded apps. Both forms produce the same `dist/` web output.)

**Known issue — `expo export --platform web` never exits.** The export finishes its work (writes `dist/`, prints `Exported: dist` and the asset count) and then **hangs indefinitely**. Reproduced deterministically across separate runs; observed still alive 2h34m after completing. `dist/` is complete and correct when this happens. Suspected cause: `config.server.enhanceMiddleware` / `withPowerNativeMetroLogging` in `metro.config.js` holding an open handle — a web *export* should not need a dev server. **Not yet root-caused.**

**Do not wait on the process.** Run it detached and poll for the artifact:

```bash
npx expo export --platform web > /tmp/expo-web-export.log 2>&1 &
EXPORT_PID=$!
for _ in $(seq 1 90); do
  grep -q "Exported: dist" /tmp/expo-web-export.log 2>/dev/null && break
  sleep 2
done
if ! grep -q "Exported: dist" /tmp/expo-web-export.log 2>/dev/null; then
  echo "web export did not complete in 180s"; tail -30 /tmp/expo-web-export.log; exit 1
fi
test -f dist/index.html || { echo "dist/index.html missing"; exit 1; }
kill "$EXPORT_PID" 2>/dev/null || true
echo "✓ web export complete (process terminated manually — known hang)"
```

Treat a completed `dist/` as success even though the process had to be killed. `npm run package:android` / `package:ios` are **not** affected — both exit 0 cleanly and stage into `dist/` via a temp dir, so they do not clear the web build.

If the build fails:

- **`TS6133` (unused import)** → remove the import and retry once.
- **Other TypeScript errors** → report file + line and STOP. Don't deploy a broken build.
- **Metro bundler errors** → surface the full stack and STOP.

Verify `dist/` exists with `index.html` before continuing.

### Step 2.4 — Native package (Hermes bundle + customer assets)

**Print before starting:**
> "→ Compiling the native Hermes bundle and hash-addressed asset package for iOS and Android via `npm run package:android` + `npm run package:ios`. No JavaScript is compiled inside the wrap pipeline — it only consumes these prebuilt files. ~1–3 minutes."

**Node version gate (required).** The native export crashes on **Node < 20.19.4** — it hits `util.styleText(['yellow','inverse','bold'], …)`, which older Node rejects, failing the Metro bundle with a cryptic `ERR_INVALID_ARG_VALUE`. Check first:

```bash
node -v
```
If it prints below **v20.19.4**, STOP and tell the user to switch (`nvm use 20.19.4`, or install Node ≥ 20.19.4) and rerun. Do **not** run the `package:*` commands on older Node.

The web build above produces `dist/index.html` (the hosted Code App). Native **wrapped** apps additionally need a precompiled Hermes bundle **and** the customer's images/fonts as hash-addressed asset files, so the wrap pipeline never compiles or downloads JavaScript.

**Script preflight (required).** `package:android` / `package:ios` were added to the template after the initial release, so apps scaffolded earlier will not have them and `npm run package:android` fails with a bare `Missing script: "package:android"`. Check before invoking:

```bash
node -e '
const s = require("./package.json").scripts || {};
const missing = ["package:android","package:ios"].filter(k => !s[k]);
if (missing.length) { console.log("MISSING:" + missing.join(",")); process.exit(1); }
console.log("OK");
'
```

If it prints `MISSING:…`, STOP and tell the user exactly what to add — do not silently skip native packaging, and do not guess at the command:

> "⚠️ This app was scaffolded before native packaging was added to the template, so `package:android` / `package:ios` are missing from `package.json`. Add both scripts (copy them from the current plugin template at `plugins/mobile-apps/template/package.json`) and re-run. Without them the deploy produces a web-only build, and the wrapped native app will have no Hermes bundle to load."

Once the preflight passes, produce both platforms:

```bash
npm run package:android
npm run package:ios
```

Each command produces that platform's native Hermes bundle **and** its customer asset package, writing next to `dist/index.html`:

- `dist/index.android.bundle.hbc` / `dist/main.jsbundle.hbc` — the Hermes bytecode bundle.
- `dist/powerapps-customer-assets-android/` and `dist/powerapps-customer-assets-ios/` — `manifest.json` plus `assets/<fileHash>.<type>` for every image/font.

These sit alongside `index.html` under the same container SAS, so the wrap pipeline fetches them as siblings — no RP or connector change is required.

**Verify before continuing** — STOP on any failure (never push a web-only build for a native-wrapped app):

```bash
# Hermes magic bytes on both bundles (expect c61fbc03)
for f in dist/index.android.bundle.hbc dist/main.jsbundle.hbc; do
  test -f "$f" || { echo "MISSING $f"; exit 1; }
  node -e 'const fs=require("fs"),b=Buffer.alloc(4),fd=fs.openSync(process.argv[1],"r");fs.readSync(fd,b,0,4,0);fs.closeSync(fd);process.exit(b.toString("hex")==="c61fbc03"?0:1)' "$f" || { echo "$f is not Hermes bytecode"; exit 1; }
done
# both asset manifests present
test -f dist/powerapps-customer-assets-android/manifest.json || { echo "MISSING android manifest"; exit 1; }
test -f dist/powerapps-customer-assets-ios/manifest.json     || { echo "MISSING ios manifest"; exit 1; }
echo "✓ native package + asset manifests present"
```

If a `package:*` step fails, surface the error and STOP. If the app renders bundled images/fonts, also confirm each `manifest.json` `assets` array is non-empty (an empty array means the app doesn't `require()` any static asset yet).

### Step 2.5 — Offline profile coverage gate

This is the final chance to catch schema that never made it into the Mobile Offline Profile before it ships — a table added to the data model but not the profile never syncs to devices, and a new column arrives blank offline. Validate that every schema change is covered **before** pushing.

Run the local, no-network delta check (`.datamodel-manifest.json` vs `offline-profile.json`):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/offline-profile-delta.js"
```

Branch on the JSON `status` (full contract in [offline-profile-reconciliation.md](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-reconciliation.md)):

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

- **Update the offline profile now (recommended)** — read and execute `${CLAUDE_SKILL_DIR}/../add-table-to-offline-profile/SKILL.md` for each `missingTables[]` entry (or once with `--all-new`), then read and execute `${CLAUDE_SKILL_DIR}/../edit-offline-profile/SKILL.md` with `--table <t> --columns add:<newColumns>` for each `tablesWithNewColumns[]` entry. Follow the ordering in the reconciliation reference, then re-run the delta check; when it reports `in-sync`, continue to Step 3.
- **Deploy anyway** — requires an explicit override. Wait for the exact phrase `deploy without offline` (case-insensitive); a bare `y`/`yes` is not enough, mirroring the environment-mismatch gate in Step 3. Then continue to Step 3 and note the skipped reconciliation in the Step 4 build-history row.

Do not push until the gate is resolved (reconciled to `in-sync`, or explicitly overridden).

### Step 3 — Deploy

**Resolve and confirm the target environment FIRST.** `npx power-apps push` deploys to the environment configured in `power.config.json`. Resolve that ID to a Dataverse URL so the user catches drift before pushing.

Run:

```bash
ENV_ID=$(node -e "console.log(require('./power.config.json').environmentId)")
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$ENV_ID"
```

From `resolve-environment.js` capture the **Environment URL** (e.g. `https://contoso.crm.dynamics.com/`), **Environment ID**, and **Tenant ID**. Cross-check against `memory-bank.md` / `power.config.json`:

- **Match** → proceed to the confirmation prompt below.
- **Mismatch** → STOP. Surface both values side-by-side and ask the user to either (a) update `power.config.json` by re-running init in the intended app root, or (b) explicitly type `override` to push to the environment already recorded in `power.config.json`. Do not proceed on a bare `y`.
- **Cannot resolve/authenticate** → STOP with `az login --tenant <env-tenant>` instructions, or ask the user to provide the environment URL directly.

**Print before starting:**
> "→ Pushing bundle to Power Platform via `npx power-apps push`. ~30–60 seconds."

Confirm with the user using the **resolved env URL, not just the friendly name**:

> "Ready to deploy to **<env-name>** (`<env-url>`)? This will update the live app for every user in that environment. Type `yes deploy to <env-name>` to confirm."

Wait for the exact phrase `yes deploy to <env-name>` (case-insensitive, env-name matching). A bare `y` / `yes` is not enough — too easy to fire on autopilot when the wrong env is active. Then:

```bash
npx power-apps push --non-interactive
```

Capture the app URL from the output if printed.

**First-deploy loop-back.** If Step 1.5 reported `MISSING`, re-read the config now:

```bash
node -e "const c=require('./power.config.json');console.log(c.appId||'STILL MISSING')"
```

- **GUID** → the app was registered. **Go back to Step 2 and run Build → 2.4 → 2.5 → Deploy one more time.** The artifacts now sitting in `dist/` (and already uploaded to the blob) still have an empty app ID compiled in; without the second cycle the wrapped app fails on-device. Step 2.5 may be skipped on this second pass **only if** nothing under `.datamodel-manifest.json` / `offline-profile.json` changed since cycle 1.
- **`STILL MISSING`** → push did not register the app. STOP and report. Do not proceed to wrap.

On the second pass this check is a no-op, and Step 4 runs as normal.

If deploy fails, report the error and STOP — do not retry silently. Common fixes:

| Error | Fix |
|---|---|
| `npx power-apps push` auth error, wrong user, or multiple accounts | Follow shared-instructions command-failure handling. `az login` / `az account set` does not switch the standalone Power Apps CLI account. |
| Environment mismatch | Re-run `npx power-apps init -t MobileApp --display-name <name> --environment-id <id> --non-interactive` in a fresh/app root for the intended target|
| `npx power-apps push` not recognised | Run `npm install` in the project so `@microsoft/power-apps` provides the CLI, or install `@microsoft/power-apps-cli` only as a last-resort prerequisite after user confirmation. |

### Step 4 — Update memory bank

If `memory-bank.md` exists, increment the version (`v1.0.0` → `v1.1.0`) and update:

- Current version
- Last deployed timestamp
- App URL (if captured)
- Append a row to the **Build history** section: `| v1.1.0 | <timestamp> | deploy | success |`

Print the summary card:

```
✅ Deploy — <project-name>
─────────────────────────────────────────────
Version       : <new-version>
Environment   : <env-name>
App URL       : <url or "see make.powerapps.com">
Bundle path   : dist/

Local dev:    npm run dev          (= expo start, QR for native dev clients)
Re-deploy:    /deploy
List conns:   /list-connections
─────────────────────────────────────────────
```

---

## Local dev (out of scope for this skill — for reference only)

When the user wants to iterate locally, they run **directly**:

```bash
npm run dev          # = expo start  →  Metro + QR for native dev clients
```

This launches Metro and prints a QR code. They can:

- Scan the QR with the installed native dev client
- Press `r` to reload, `j` to open the debugger, `m` for the dev menu

Runtime debugging for this plugin uses `/debug-app` with native dev-client sessions and Metro terminal logs. Do not use React Native Web, browser automation, direct Metro/localhost HTTP probes, or screen-by-screen runtime checks.

If they want to compile a native binary locally, they run the platform-specific native command directly. Local native compile and manual device testing are user-owned and are not deployment gates for this skill.

## Reference

- [`shared/version-check.md`](${CLAUDE_SKILL_DIR}/../../shared/version-check.md) — min versions (only Always-required tier matters here)
- [`shared/memory-bank.md`](${CLAUDE_SKILL_DIR}/../../shared/memory-bank.md) — Build history schema
- [`shared/references/offline-profile-reconciliation.md`](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-reconciliation.md) — Step 2.5 offline coverage gate
