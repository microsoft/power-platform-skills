---
name: deploy
description: Use when the user wants to deploy / publish / push a Power Apps mobile app to a Power Platform tenant so others can run it.
user-invocable: true
allowed-tools: Read, Glob, Bash, AskUserQuestion
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

1. Check memory bank → 2. Build → 3. Deploy → 4. Update memory bank

---

### Step 1 — Check memory bank

Read `memory-bank.md` from the project root if present. Capture:

- Project name
- Environment (id + display name)
- Current version

If absent, continue — the project may have been created without the plugin. Re-derive env from `power.config.json` if needed.

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

(That's what the upstream template's `build` script runs.)

If the build fails:

- **`TS6133` (unused import)** → remove the import and retry once.
- **Other TypeScript errors** → report file + line and STOP. Don't deploy a broken build.
- **Metro bundler errors** → surface the full stack and STOP.

Verify `dist/` exists with `index.html` before continuing.

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
