---
name: debug-app
description: Use when the user has finished building a mobile app, started Metro with `npm run dev`, and wants the running app monitored for runtime errors AND silent failures (empty lists, blank screens, swallowed network errors) and fixed autonomously. Accepts a free-text symptom (e.g., `/debug-app "todos not appearing on home screen"`) to drive persisted-log diagnostics — injects temporary console.log statements at data-path boundaries, reads the sanitized `.powernative/metro-logs/` log, and cleans up logs after the root cause is fixed. Supports port/platform filtering, configurable clean-cycle and timeout limits, and watch-only `--no-fix` mode. Otherwise polls with a durable byte cursor, fixes inline or routes appropriately, verifies each fix from new output, and exits after the configured clean checks (default 3). Foreground loop — blocks the conversation while running. Run only after the app is loaded.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, WebFetch, mcp__plugin_mobile-app_microsoft-learn__microsoft_docs_search
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** — read first.

# Debug App — Monitor & Fix

Monitor the running app through the project-local `.powernative/metro-logs/` files written by `metro.config.js`, detect runtime and bundle errors, and fix them autonomously by editing the affected files (or routing to the right skill when the fix belongs in a domain like Dataverse schema or auth registration). For silent failures, inject temporary `console.log` statements at data-path boundaries, read only newly appended log bytes, then clean the traces after the root cause is fixed. Modeled on the upstream `app-debugger.agent.md` pattern — foreground loop, bounded polling, configurable clean-check/timeout exits, and optional watch-only operation.

> **Dev-client limitation:** the standalone dev client sends app/runtime logs, React errors, host diagnostics, and Metro bundler output through Metro. The template's `metro.config.js` writes Metro terminal output and HTTP bundle failures into `.powernative/metro-logs/`; there is no separate device log source. Host diagnostics include strings such as `[AuthProvider] MSAL init failed:`, `[bridge] fetch THREW for`, `[bridge] HTTP <status> for`, `[addAadAppToConnectionAcl] failed HTTP <status> for connection`, `[useConnectionRefs] could not verify connection ACLs; treating existing connections as setup-required`, and `[PAHost][ErrorBoundary] Unhandled JS error:`.

## Subcommands (parsed from `$ARGUMENTS`)

| Form | Behavior |
|---|---|
| `/debug-app` (no args) | **Default — project-log-driven mode.** Run Phase 0, discover valid project-local Metro sessions, select automatically when one is live or ask when several are live, then monitor the selected log. No host terminal ID is required. |
| `/debug-app "<symptom text>"` | **Symptom-driven mode** (recommended when there's a user-visible problem). Free-text symptom such as `"todos not appearing on home screen"`, `"login button does nothing"`, `"list empty after refresh"`. Run Phase 0 → Phase 0.5 (parse symptom → ask the user to reproduce/navigate → walk the likely data path from terminal traces) → enter monitor loop. Catches silent failures (empty lists, blank screens, swallowed errors) that pure log polling misses. |
| `/debug-app status` | Discover all project-local Metro logs and print each valid session's project, platform, PID, port, start time, and log path. Mark the session referenced by the saved cursor when present, then print fixes and unresolved errors. Do NOT ask for a selection or enter the loop. |
| `/debug-app stop` | Stop only the foreground debug loop and preserve `.powernative/debug-app/` state. It does not stop Metro; the user owns the `npm run dev` process. |

### Monitoring options

Options may follow the default command, a symptom, or `status`:

| Option | Meaning | Default |
|---|---|---|
| `--port <1-65535>` | Monitor only the valid Metro session on this port. | Any port |
| `--platform <ios\|android>` | Consider only sessions whose recent log identifies this platform. | Any platform |
| `--cycles <1-50>` | Exit after this many consecutive clean observation intervals. | `3` |
| `--timeout <duration>` | Maximum wall-clock monitoring time. Accept `30s`–`60m` using `s`, `m`, or `h`. | `5m` |
| `--no-fix` | Watch-only mode: classify and report, but never edit project source/config, inject traces, install dependencies, regenerate files, or invoke a mutating handoff. Debug cursor/audit/health state still advances. | Fix enabled |

Examples:

```text
/debug-app --port 8082 --platform ios
/debug-app "orders screen is empty" --cycles 10 --timeout 15m
/debug-app --no-fix --timeout 30m
/debug-app status --platform android
```

**Argument parsing:**

1. Parse quoted text as one symptom value and parse recognized flags wherever they appear.
2. The first reserved token (`status`, `stop`, `help`, `--help`, `-h`, `version`, `--version`) selects the subcommand. `stop`, help, and version do not accept monitoring options. `status` accepts only `--port` and `--platform`; reject symptoms, `--cycles`, `--timeout`, and `--no-fix` because it does not enter the loop.
3. After removing recognized options and their values, any remaining non-reserved text is the symptom and enables symptom mode.
4. Reject unknown flags, duplicate flags, missing values, invalid numbers, unsupported platforms, or more than one free-text symptom. Print the valid forms and exit without monitoring.
5. Normalize `platform` to lowercase. Convert `timeout` to `timeoutSeconds`; require `30 <= timeoutSeconds <= 3600`.
6. Initialize:
   ```text
   portFilter=<number|none>
   platformFilter=<ios|android|none>
   targetCleanCycles=<number, default 3>
   timeoutSeconds=<number, default 300>
   noFix=<true|false, default false>
   monitorStartedAt=<current ISO timestamp>
   ```

For `help` / `--help` / `-h`, print the subcommands and monitoring-options tables and exit.

**Tip — "play around then debug":** Metro persists recent app output in `.powernative/metro-logs/` even across chat/editor restarts. If something weird just happened, keep using the app normally, then run `/debug-app` or `/debug-app "<what you saw>"`. The first cycle reads the latest persisted log window; subsequent cycles read only bytes appended after the saved cursor.

## Core Principles

- **Foreground autonomous loop** — Once started, this skill owns the conversation until `targetCleanCycles` consecutive clean polls confirm the app is healthy, `timeoutSeconds` elapses, the user types `stop`, or the escalation rule trips. **Do not run other skills concurrently** — they'll queue behind the loop.
- **Watch-only means no project mutation** — With `--no-fix`, do not edit project source/configuration, inject diagnostic logs, install packages, regenerate schemas, switch accounts, or invoke a mutating skill. Continue to advance `.powernative/debug-app/` cursor/audit/health state, classify errors, and provide the fix/handoff that would have been used.
- **Run AFTER the app is loaded** — Metro must be running through `npm run dev` and the simulator/device must have the app open. Phase 0 verifies that a live `.powernative` log exists; the skill stops cleanly if no app is detected.
- **Native-only runtime target** — The app must be loaded in a native dev client on a device or simulator; `.powernative/metro-logs/` is the authoritative log source for that native session.
- **No web or direct Metro probes** — Do not use React Native Web, browser automation, `curl`, `fetch`, `WebFetch`, or any direct request to a Metro/localhost endpoint for runtime diagnosis. Read only the `.powernative` log and source files.
- **No screen-by-screen verification** — Do not crawl routes or validate every screen. In symptom mode, focus only on the user-reported workflow and the terminal/source evidence needed to diagnose it.
- **One fix at a time** — Fully resolve one issue (context → fix → type-check → reload → re-poll) before starting the next. No batching.
- **Working-dir state** — Debug audit state lives in `.powernative/debug-app/`: `fixes.md`, `unresolved.md`, `injected-logs.md`, `health.json`, and `metro-cursor.json`. Metro logs live in the already-ignored `.powernative/metro-logs/`. Both survive chat/editor restarts without binding state to a specific agent host.
- **Defense-in-depth redaction** — The Metro logger removes credential-like lines before writing `.powernative`, but `/debug-app` must independently minimize and sanitize every value before persisting it to `.powernative/debug-app/`. Never copy raw response bodies, record objects, tokens, headers, trace payloads, or absolute home-directory paths into debugger state.
- **The port is the log identity** — the dev-server port is the number the QR encodes, the device dials, and this skill verifies. Liveness is a socket probe (does the log's PID still hold that port?), never terminal scrollback. A `port-taken` status means the log belongs to a dead session and must not be diagnosed.
- **Never fix history** — the log is a record of the past, so an error in it is not proof of a current problem. Errors found in the baseline window must pass the Phase 0.2.1 supersession check before any code is edited. Editing working code to chase an already-resolved error is a worse outcome than reporting nothing.
- **Host terminal APIs are optional only** — If the current host already exposes Metro terminal output, it may be consulted as a low-latency convenience. Never ask the user for a terminal ID, never persist one, and never make a diagnosis from host output without advancing the authoritative `.powernative` log cursor too.
- **Context-first diagnosis** — Read `memory-bank.md` when present. Read `power.config.json` for environment, Dataverse, and connector context. Consult `native-app-plan.md` only when the failure concerns a planned screen, data model, connector, offline profile, or native capability; do not parse it for unrelated syntax/runtime errors.
- **Reference resolution order** — For Dataverse/Power Platform errors: read [skills/add-dataverse/references/dataverse-reference.md](../add-dataverse/references/dataverse-reference.md) first, inspect generated services/models and project context, then query `mcp__plugin_mobile-app_microsoft-learn__microsoft_docs_search` when behavior remains uncertain. For Expo/Expo Router/React Native errors: inspect installed versions and project code first, then use targeted `WebFetch` against official `https://docs.expo.dev/` documentation. Use package documentation next and general web search only as a last resort.

## Workflow — Task List First

Before entering the monitor loop, write a task list and keep it up to date:

```
- [ ] Discover valid `.powernative` Metro sessions and select one when needed
- [ ] Capture baseline log state from the selected session and save its byte cursor
- [ ] (Symptom mode only) Phase 0.5: parse symptom → ask user to navigate → inject console.logs → read new log bytes → walk data path → clean up logs
- [ ] Monitoring cycle 1: collect → classify → fix if needed
- [ ] Monitoring cycle 2: collect → classify → fix if needed
- [ ] Monitoring cycle 3: collect → classify → fix if needed
      (add cycles as needed; stop after <targetCleanCycles> consecutive clean cycles AND symptom resolved/flagged)
- [ ] Fix: <error summary> → <inline edit | skill route>  (one task per error found)
```

Mark each cycle complete (clean OR fixed) before starting the next.

---

## Phase 0 — Startup Check

Before entering the loop:

### 0.preflight Read project context

Follow the shared instructions before diagnosing logs:

1. If `<working_dir>/memory-bank.md` exists, read its Project facts, Power Platform context, Data model, Connectors, Screens, Native capabilities, and Build history. Do not create a memory bank from `/debug-app`; absence is valid.
2. Read `<working_dir>/power.config.json` when present. Capture `environmentId`, `databaseReferences`, and `connectionReferences`. `power.config.json` is the preferred environment source.
3. Read `<working_dir>/native-app-plan.md` only when the supplied symptom or a classified error concerns a planned screen, Dataverse entity/column, connector, offline behavior, navigation contract, or native capability. Treat the plan as intended design, not proof of live schema/runtime state.
4. Inspect `src/generated/services/`, `src/generated/models/`, and `src/generated/connectorSchemas.ts` only when the affected data path uses them. Never edit generated files.

Append a compact context line to `fixes.md` after Phase 0.1 creates it:

```text
[<HH:MM:SS>] Context — memory-bank=<present|absent> native-plan=<present|absent|not-needed> environment=<environmentId|none> dataverse-tables=<N> connectors=<N>
```

Do not resolve the environment or call Dataverse during ordinary bundle, React, or local JavaScript failures. When a current symptom/error is Dataverse or Power Platform related, perform the read-only Dataverse diagnostic sequence in D2 before handing off.

### 0.0 Discover and select the project-local Metro session

Determine `<working_dir>` from `--working-dir` when present, otherwise use the current app root. Enumerate **all** matching logs, newest first:

```bash
LOG_DIR="<working_dir>/.powernative/metro-logs"
ls -t "$LOG_DIR"/metro-*-pid-*-port-*.log 2>/dev/null
```

For every candidate, parse:

- `pid` and `port` from `metro-<timestamp>-pid-<pid>-port-<port>.log`;
- `startedAt` from the filename timestamp;
- `project` from `power.config.json.appDisplayName`, falling back to the basename of `<working_dir>`;
- `platform` by scanning only the latest 64 KiB for the most recent `iOS ... Bundled` / `iOS Bundling` or `Android ... Bundled` / `Android Bundling` line; use `unknown` when neither appears.

When `port` is numeric, verify the listener with the host shell (`lsof -nP -iTCP:<port> -sTCP:LISTEN -t` on macOS/Linux, `netstat -ano -p tcp` on Windows). A candidate is **valid/live** only when its recorded PID is alive and either owns the recorded port or the port probe is unavailable. Do not persist terminal IDs or depend on terminal output.

Selection rules:

- Apply `portFilter` and `platformFilter` to the valid/live candidates before selection. When no valid session matches, print the filters plus the available valid sessions and stop. If a platform-filtered candidate is `unknown`, do not guess; tell the user to use `--port` or omit `--platform`.
- **One valid session** — select it automatically.
- **Multiple valid sessions** — show one choice per session in this exact shape, then ask which to monitor:
  ```text
  <project> — <platform> — port <port> — pid <pid> — started <startedAt>
  ```
  Use `AskUserQuestion`; identify choices internally by the complete `logPath` + `pid` + `port`, not by port alone. If `metro-cursor.json` points to one of the valid sessions, make that session the default choice but still ask. Never silently choose the newest session when more than one is live.
- **No valid sessions** — apply the failure branches below. Stale or contradictory logs are evidence for the report, never selectable choices.

After selection, set `LOG_PATH`, `pid`, `port`, `project`, `platform`, and `startedAt` from the chosen candidate. This selection is sticky for the current monitor run.

Branch as follows:

| Status | Meaning | Action |
|---|---|---|
| Exactly one valid log exists, PID is alive, and either port is unknown or the port probe is unavailable | Select it. Capture `project`, `platform`, `startedAt`, `port`, `pid`, and `logPath`, then continue. |
| Exactly one valid log exists and PID still owns the logged port | Select it. Capture `project`, `platform`, `startedAt`, `port`, `pid`, and `logPath`, then continue. |
| Multiple valid logs exist | Show every valid session and ask which one to monitor. Do not select by recency alone. |
| Log exists, PID is gone, and another process owns the logged port | Do NOT diagnose from this log. Tell the user which PID holds the port and ask them to restart `npm run dev`. |
| Log exists but PID/port contradict each other | The device may be talking to the wrong server. Ask the user to stop stale Metro processes and rerun `npm run dev`. |
| No log exists and `metro.config.js` does not directly import `@microsoft/power-apps-native-host/metro-logger`, or `package.json` does not require `@microsoft/power-apps-native-host` `^0.2.26` or newer | This project predates project-local Metro logging. Stop and report both missing contract pieces. Do not enter a restart loop or edit customer-owned config from `/debug-app`; the user must adopt the current template's Metro config and host dependency first. |
| No log exists and the Metro config/dependency contract is current | Tell the user Metro is not running or has not emitted `.powernative` logs. Ask them to run `npm run dev`, open the native app, then rerun `/debug-app`. |

The PID/port check prevents stale-log diagnosis: a log file can outlive its Metro process, so only the socket probe reveals that the log stopped belonging to the app under test. The explicit choice prevents a valid session on one port from being confused with another valid session in the same project.

If no `.powernative` log exists but the host exposes a live Metro terminal, that output may explain what is running, but do not ask for or store its terminal ID and do not enter the continuous monitor loop against it. Ask the user to restart with `npm run dev` so Metro config creates the log.

Record the stable source in `fixes.md`:

```text
[<HH:MM:SS>] Log source — <project> <platform> — <logPath> (pid <pid>, port <port>, started <startedAt>)
```

### 0.1 Ensure state directory

```bash
mkdir -p .powernative/debug-app
touch .powernative/debug-app/fixes.md
touch .powernative/debug-app/unresolved.md
touch .powernative/debug-app/injected-logs.md
touch .powernative/debug-app/health.json
touch .powernative/debug-app/metro-cursor.json
rm -f .powernative/debug-app/symptom-state    # per-session — Phase 0.5 rewrites it if symptom mode is active
```

If `fixes.md` is empty, write a session header:
```
# Debug session — <date>

```

Append the effective invocation settings:

```text
[<HH:MM:SS>] Monitor config — port=<any|port> platform=<any|ios|android> clean-cycles=<targetCleanCycles> timeout=<timeoutSeconds>s no-fix=<true|false>
```

### 0.1.1 Initialize health state

Write `.powernative/debug-app/health.json` without raw log content:

```json
{
  "bundle": { "status": "unknown", "summary": "No evidence yet" },
  "runtime": { "status": "unknown", "summary": "No evidence yet" },
  "authentication": { "status": "unknown", "summary": "No evidence yet" },
  "dataverse": { "status": "unknown", "summary": "No evidence yet" },
  "connector": { "status": "unknown", "summary": "No evidence yet" },
  "offline": { "status": "unknown", "summary": "No evidence yet" },
  "navigation": { "status": "unknown", "summary": "No evidence yet" },
  "nativeCapability": { "status": "unknown", "summary": "No evidence yet" },
  "updatedAt": "<ISO timestamp>"
}
```

Allowed statuses are `healthy`, `degraded`, `failed`, `unknown`, and `not-configured`. Update only the affected domain after each classified signal:

| Signal | Health update |
|---|---|
| Successful native bundle after the latest bundle error | `bundle=healthy` |
| Bundle/transform/import failure | `bundle=failed` |
| Uncaught JS/React error | `runtime=failed`; set `healthy` after the repaired workflow produces clean new output |
| Auth success/failure host diagnostics | `authentication=healthy|failed` |
| Dataverse 2xx/error for the affected operation | `dataverse=healthy|failed` |
| Connector resolution/call success or failure | `connector=healthy|failed` |
| No offline profile | `offline=not-configured`; offline activation/sync warning or failure → `degraded|failed` |
| Confirmed route/navigation error | `navigation=failed`; repaired route confirmation → `healthy` |
| Native wrapper success, permission denial, missing module, or native failure | `nativeCapability=healthy|degraded|failed` |

Absence of evidence remains `unknown`; never convert an unobserved domain to `healthy`.

### 0.1.2 Persistence redaction gate

Before appending diagnostic text to `fixes.md` or `unresolved.md`, or storing a health `summary`, sanitize it:

1. Convert project paths to paths relative to `<working_dir>`. Replace other absolute home-directory paths with `[REDACTED_PATH]`.
2. Replace complete authorization/cookie/secret headers (`Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `x-api-key`, `api-key`, `client-secret`, and token headers) with `[REDACTED_HEADER]`.
3. Replace Bearer values, JWT-like three-segment values, SAS/query secrets (`sig`, `se`, `sp`, `sv`, `code`, `token`, `access_token`, `refresh_token`, `id_token`, `client_secret`), passwords, and API keys with `[REDACTED_SECRET]`.
4. Replace email addresses with `[REDACTED_EMAIL]` and GUIDs/record identifiers with `[REDACTED_ID]` unless the identifier is a non-sensitive local PID/port.
5. Never persist Dataverse/connector response bodies or arbitrary `[TRACE]` object values. Persist only status, source/config table or column names, counts, error codes, and a bounded error message.
6. Scan the sanitized result again. If any sensitive pattern remains, persist `[REDACTION_BLOCKED: diagnostic omitted]` instead.

Run the bundled verifier for every candidate diagnostic before writing:

```bash
printf '%s' "$DIAGNOSTIC_SUMMARY" | node \
   "${PLUGIN_ROOT}/scripts/redact-debug-diagnostic.js" \
  --working-dir "<working_dir>"
```

Persist only the verifier's stdout. Build `DIAGNOSTIC_SUMMARY` from minimal fields first; do not pass a full Metro window or response body and rely on redaction to make it safe.

Store `logPath` in `metro-cursor.json` relative to `<working_dir>` and resolve it against `<working_dir>` when reading. This gate is required even though `.powernative` logs are already sanitized.

### 0.2 Verify Metro bundled and the app is running

Read a bounded baseline window and return a real byte cursor:

```bash
node - "$LOG_PATH" 262144 <<'NODE'
const fs = require('node:fs');
const [file, maxText] = process.argv.slice(2);
const maxBytes = Number(maxText);
const size = fs.statSync(file).size;
const start = Math.max(0, size - maxBytes);
const fd = fs.openSync(file, 'r');
const buffer = Buffer.alloc(size - start);
const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
fs.closeSync(fd);
process.stdout.write(JSON.stringify({
   cursor: start,
   nextCursor: start + bytesRead,
   truncated: start > 0,
   output: buffer.subarray(0, bytesRead).toString('utf8')
}, null, 2));
NODE
```

Parse `output`, `cursor`, `nextCursor`, and `truncated`; use the `pid`, `port`, and `logPath` resolved in Phase 0.0. Scan `output`:

- Most recent error-class line is `SyntaxError`, `Unable to resolve module`, `transform failed`, or `error: Bundling failed` → bundle is broken. Treat as a Step B "Import / Bundle" critical error and route through Step D immediately. Do NOT enter the steady-state loop until the bundle is healthy.
- Output contains `Bundling complete` / `iOS Bundled` / `Android Bundled` with no later error-class line → Metro is healthy. Proceed.
- Output contains a Metro banner (`Metro waiting on`, `Logs for your project`, or `› Metro:`) but no native `Bundled` / `bundling` lines yet → Metro is up but no native client has connected. Tell the user:
  > **Metro is running but no app is connected yet.** Open the app on a device or simulator, then re-run `/debug-app`.
  Stop here.
- Output is empty despite `status.running: true` → Metro has not emitted enough state yet. Tell the user to wait for the native URL, then re-run `/debug-app`; do not guess readiness.

If `truncated: true`, the baseline covers only the latest 256 KiB. Record that older history was omitted; do not claim the full session history was inspected.

Before initializing the cursor, pass **all** classifiable entries in this initial
window through Step B, including JS runtime errors, React warnings, network/API
failures, native errors, and host diagnostics. Do not advance past a prior error
just because it is not a bundle error. This preserves the promise that users can
"play around, then debug" after a symptom already occurred.

### 0.2.1 Supersession — never re-fix an error the log already shows resolved

The baseline window is **history, not current state**. It can contain errors that
were already fixed, that the user resolved themselves, or that were transient.
Fixing those is worse than doing nothing: it edits working code to chase a
symptom that no longer exists, and the "fix" is unverifiable because the error
cannot reproduce.

So every error found in the **baseline window only** (not in later polls) is
treated as *unconfirmed* until checked for supersession. Scan forward from the
error line to the end of the window:

| Error class | Superseded when a later line shows |
|---|---|
| Import / Bundle | `Bundling complete`, `iOS Bundled`, or `Android Bundled` |
| Network / API | a 2xx for the same route/resource that previously failed |
| JS runtime / React | a later app reload or successful bundle, and the error does not reappear after it |
| Host diagnostic (`[AuthProvider]`, `[bridge]`, …) | a later success from the same subsystem (e.g. a token acquired after `acquireTokenSilent failed`) |

Then:

- **Superseded** → do NOT fix. Record it and move on:
  ```
  [<HH:MM:SS>] Observed (already resolved, not fixed) — <error summary> — superseded by <evidence line>
  ```
- **Not superseded** → the error is live. Fix it normally through Step D.
- **Ambiguous** (no clear supersession evidence either way) → do NOT edit code yet. Ask the user whether they still see it, or wait for it to reappear in the next poll. An error that recurs after the cursor advances is confirmed live.

This applies to the baseline window only. Anything appearing in a later
`tail --cursor` poll is by definition new output and needs no supersession check.

**Symptom mode overrides this.** If the user supplied a symptom, that is
first-hand evidence the problem is current, so a matching baseline error is
treated as live even when a later line would otherwise look like supersession.

### 0.3 Capture baseline

Use the output from Phase 0.2. Note the most recently bundled native platform (iOS / Android) and any recent runtime log lines. Append to `fixes.md`:
```
[<HH:MM:SS>] Baseline — last Metro activity: <1-line summary of most recent lines>
```

### 0.4 Initialize the durable byte cursor

Write `.powernative/debug-app/metro-cursor.json` using structured JSON:

```json
{
   "logPath": ".powernative/metro-logs/metro-<timestamp>-pid-12345-port-8081.log",
   "pid": 12345,
   "port": 8081,
   "project": "My Mobile App",
   "platform": "ios",
   "startedAt": "2026-08-27T12:41:32.050Z",
   "monitorStartedAt": "<ISO timestamp>",
   "monitorConfig": {
      "port": null,
      "platform": null,
      "targetCleanCycles": 3,
      "timeoutSeconds": 300,
      "noFix": false
   },
   "cursor": 12345,
   "updatedAt": "<ISO timestamp>"
}
```

Set project-relative `logPath`, plus `pid`, `port`, `project`, `platform`, and `startedAt` from Phase 0.0. Set `monitorStartedAt` and `monitorConfig` from the current invocation, and set `cursor` to `nextCursor` from Phase 0.2. Resolve `logPath` against `<working_dir>` before file access. A new invocation always replaces the prior monitoring configuration and start time. On later invocations:

- Same `logPath`, `pid`, and `port`, with the process still owning the port → reuse the saved cursor so old errors are not processed again.
- Multiple valid sessions → ask which session to monitor. Default to the saved session when it remains valid.
- A different session is explicitly selected, or the saved session is no longer valid → discard the old cursor and initialize from the selected session's latest log window.
- `rotationLost: true` from Step A → accept the returned reset cursor and record the file shrink/replacement in `fixes.md`.

---

## Phase 0.5 — Symptom-driven setup (only when `$ARGUMENTS` is a symptom string)

Skip this entire phase if no symptom was provided. The standard log-polling loop alone is good at *visible* errors but blind to *silent* ones: an empty list because the connector wasn't added, a blank screen because `useFocusEffect` wasn't wired, blank rows because column names don't match the model. Phase 0.5 closes that gap.

**`--no-fix` behavior:** Parse the symptom and ask the user to reproduce it, but do not inject `[INJECTED-TRACE]` logs or edit any file. Read only new Metro output. If the symptom is silent and produces no classifiable output, record it as `pending` with `watch-only: traces not injected`, then enter the standard loop.

### 0.5.1 Parse the symptom

Extract three signals from the user's text:

| Signal | How to derive |
|---|---|
| **Affected screen** | Match keywords against route filenames in `app/` (e.g., `"todos"` → `app/(tabs)/todos.tsx`, `app/todos/index.tsx`, `app/(tabs)/index.tsx`). Use `Glob` to enumerate `app/**/*.tsx`; pick the closest substring match. If multiple, ask once. |
| **Affected entity / service** | Same keyword against `src/generated/services/*Service.ts` and `src/generated/models/*Model.ts` (e.g., `"todos"` → `TodosService`, `Todo` model). Use `Glob`. |
| **Symptom class** | Map the text to one of: `empty-list`, `blank-screen`, `wrong-data`, `unresponsive-control`, `stale-data`, `wrong-navigation`, `crash`, `pdf-viewer`, `pdf-report`, `pen-input`, `geolocation`, `dataverse-upload`. Default for "PDF won't open / preview PDF fails": `pdf-viewer`. Default for "report PDF not generated / print report fails": `pdf-report`. Default for "signature / pen / ink fails": `pen-input`. Default for "location not tracking / GPS not updating / background location stopped / breadcrumb gaps / route not consistent": `geolocation`. Default for "signature/report saved but missing", or "location rows not reaching Dataverse": `dataverse-upload`. Default for "not appearing / not showing / nothing here / missing": `empty-list`. Default for "doesn't load / freezes / spinner forever": `blank-screen`. |

Append to `fixes.md`:
```
[<HH:MM:SS>] Symptom — class=<class> screen=<path> entity=<service>
```

If no screen/entity match: keep `screen=unknown` / `entity=unknown` and proceed — Phase 0.5 still injects diagnostic logs and reads the terminal from whatever data path is most likely based on the symptom text.

### 0.5.2 Ask the user to navigate to the affected screen

The dev-player has no automation API for navigation. Ask the user:
> "Please open the `<screen>` screen on the device/simulator, then reply `ready`."

Wait for the user to confirm before proceeding.

### 0.5.3 Inject diagnostic console.log statements and read terminal

Inject targeted `console.log` statements at the boundaries of the suspected data path so the Metro terminal reveals what's happening.

**Injection sites — choose the minimum set that covers the symptom class:**

| Symptom class | Inject at |
|---|---|
| `empty-list` | (a) entry point of the data-fetching hook, logging `[TRACE items]` the raw response length; (b) the screen component, logging `[TRACE render]` the `items` array length before the list renders |
| `blank-screen` | Entry point of the screen component, logging `[TRACE mount]` a timestamp and any auth/data props passed in |
| `wrong-data` / `stale-data` | The hook that calls the generated service (NOT inside `src/generated/`), logging `[TRACE service-response]` the raw return value |
| `unresponsive-control` | The event handler (`onPress`, `onSubmit`, etc.) logging `[TRACE handler-called]` before any async work |
| `crash` | Skip injection — jump to the monitor loop (Step A), crash stacks appear in the terminal |

**Console.log injection pattern — all injected lines MUST use this exact format:**

```ts
console.log('[TRACE <tag>]', <value>); // [INJECTED-TRACE]
```

- `<tag>` — short unique label for this site (e.g., `items`, `render`, `service-response`)
- `// [INJECTED-TRACE]` trailing comment on the SAME LINE — this is the cleanup grep key
- Log the smallest useful value; use `JSON.stringify(value)` for objects
- **Never inject inside `src/generated/`** — inject in the hook/screen that calls into it

Record every injection in `.powernative/debug-app/injected-logs.md`:
```
[<HH:MM:SS>] Injected [INJECTED-TRACE] at <file>:<line> — tag=<tag>
```

Then tell the user:
> "I've added diagnostic console.log statements. Fast Refresh should apply them automatically. Navigate to `<screen>` and trigger the symptom (for example, scroll the list or tap the button). If the app does not refresh, reload it from the native dev-client menu. Reply `done` when finished."

Wait for the user to reply, then run the Step A `tail --cursor` procedure, persist `nextCursor`, and filter the returned `output` for `[TRACE` lines.

### 0.5.4 Walk the data path from terminal output

Use the `[TRACE` lines to walk the chain:

1. **Screen TSX** (`app/<route>.tsx`)
   - Find the `useListData(...)` / `use*Data(...)` call.
   - Check service-call options — a stray `top: 0`, an over-strict `filter`, a `search: query` bound to a never-cleared input, or `orderBy` on a missing column can each silently return zero rows.
   - Check any client-side `.filter(...)` after the data lands.

2. **Data hook** (`src/hooks/useListData.ts` or sibling)
   - **Critical:** the template hook has TWO mock-fallback paths:
     - **Error path**: service returns `{ error }` → hook substitutes mock AND may call `setError`. **Silent** if the screen ignores `error`.
     - **Empty-result path**: service returns `{ data: [] }` (no error) → hook silently substitutes mock. Always invisible without a `[TRACE]` log.
   - Detect: `Grep` for `MOCK_` imports in the screen file. If present, mock data is wired in.
   - Confirm `useFocusEffect` is used (not `useEffect`) — `useEffect` won't re-run on back-navigate.

3. **Generated service** (`src/generated/services/<Name>Service.ts`)
   - If a TODO stub or file missing → route to `/add-connector` or `/add-dataverse`. Do NOT edit `src/generated/`.
   - If it exists and the `[TRACE service-response]` log shows an error field → read that error; 401/403 = auth issue; 404 = wrong resource name.

4. **Generated model** (`src/generated/models/<Name>Model.ts`)
   - Confirm field names match what the screen references. `item.title` vs `cr3e9_title` produces blank rows.

5. **`power.config.json`**
   - Confirm the `datasources` array contains the suspected entity / connector. If absent, `npx power-apps add-data-source` was never run for it.

6. **Auth state** (`src/playerConfig.ts`, `app.config.js`, `auth.config.json`, `useAuth()` hook)
   - 401 from the service wrapped as `{ error }` — the `[TRACE service-response]` log surfaces the error string.
   - **OAuth deeplink handoff**: verify `app.config.js` → `expo.scheme` matches `src/playerConfig.ts` → `connectorOAuthRedirectUri`, AND the same redirect URI is in `auth.config.json` and the Entra ID registration. If the app registration is missing, route the user to the Power Apps Wrap page via `/set-app-registration-native`.

**Classify the `[TRACE` output:**

| Output | Meaning | Next step |
|---|---|---|
| `[TRACE items] 0` or `[]` — no error field | Service returned empty — check filter/query or data not seeded | Fix the query; if no records exist, seed sample data |
| `[TRACE items] undefined` | Hook never received a response — likely service stub or missing datasource | Route to `/add-connector` or `/add-dataverse` |
| `[TRACE service-response]` shows error string | Service threw — read the error; 401/403 = auth; 404 = wrong resource | Fix auth config or re-run `add-data-source` |
| `[TRACE render]` N > 0 but list looks empty | Field name mismatch between model and screen | Fix screen field references to match the model |
| `[TRACE handler-called]` never appears | `onPress` not wired or component not mounted | Read TSX, fix the event binding |
| No `[TRACE` lines at all | Metro may have cached the old bundle | Ask the user to stop Metro, rerun `npm run dev -- --clear`, then reload the native app |

Record the outcome in `.powernative/debug-app/symptom-state` (single line: `resolved`, `flagged`, or `pending`).

- **Fix is clear and local** → apply via Step D3 + D4 (type-check + reload + re-poll). After the fix, ask the user to interact with the screen again and read the terminal. If the `[TRACE items]` line shows N > 0, write `resolved`.
- **Fix routes to another skill** → tell the user, log to `unresolved.md`. Write `flagged`.
- **No obvious cause** → log a structured note to `unresolved.md`. Write `pending` and enter the monitor loop.

### 0.5.5 Clean up injected console.log statements

After the root cause is identified and a fix is applied (or Phase 0.5 concludes), remove ALL injected logs:

```bash
grep -rn 'INJECTED-TRACE' app/ src/hooks/ src/services/
```

For each matching file, edit out the `console.log(...); // [INJECTED-TRACE]` lines. Verify with:
```bash
grep -rn 'INJECTED-TRACE' app/ src/hooks/ src/services/  # must return zero results
```

Clear the tracking file:
```bash
echo '' > .powernative/debug-app/injected-logs.md
```

Run `npm run type-check` once after cleanup.

> **Hard rule:** Never leave `[INJECTED-TRACE]` lines in code. Clean up before marking the session done, even if the symptom is `pending` or `flagged`.

### 0.5.6 Re-enter the standard monitor loop

After Phase 0.5 completes, fall through to the monitor loop (Step A). The "`targetCleanCycles` consecutive clean cycles" exit condition is **suspended** until the symptom is either marked resolved or recorded as `NEEDS ATTENTION` in `unresolved.md`. After that, the loop exits per the standard rule.

---

## Monitor Loop

Repeat until **`targetCleanCycles` consecutive clean cycles**, `timeoutSeconds` elapses, the user types `stop`, OR the escalation rule trips.

Before every collection cycle and immediately after any fix verification, compare the current time with `monitorStartedAt`. When elapsed time is greater than or equal to `timeoutSeconds`:

1. Clean up all `[INJECTED-TRACE]` lines before exit.
2. Append the elapsed time, cycle count, clean count, active session identity, and unresolved issue count to `fixes.md`.
3. Exit without stopping Metro:
   ```text
   ⚠ Monitoring timeout reached after <duration>.
     Session: <project> — <platform> — port <port> — pid <pid>
     Clean checks: <clean>/<targetCleanCycles>
   Details: .powernative/debug-app/fixes.md
   ```

### Step A — Collect logs

Read `.powernative/debug-app/metro-cursor.json` and rediscover all live `.powernative` sessions using Phase 0.0's validation logic.

- If the saved `logPath` + `pid` + `port` is still valid, keep monitoring it even when a newer valid session has appeared. Do not interrupt the current run or jump ports.
- If the saved session is no longer valid and exactly one valid session remains, select that session and return to Phase 0.2 for a new baseline.
- If the saved session is no longer valid and multiple valid sessions remain, show the session choices and ask which one to monitor, then return to Phase 0.2.
- If no valid session remains, stop with the applicable Phase 0.0 failure instead of reading a stale log.

Otherwise read newly appended bytes from the pinned session:

```bash
node - "$LOG_PATH" <saved-cursor> 262144 <<'NODE'
const fs = require('node:fs');
const [file, cursorText, maxText] = process.argv.slice(2);
const cursor = Number(cursorText);
const maxBytes = Number(maxText);
const size = fs.statSync(file).size;
const start = Number.isInteger(cursor) && cursor <= size ? cursor : 0;
const fd = fs.openSync(file, 'r');
const buffer = Buffer.alloc(Math.min(maxBytes, Math.max(0, size - start)));
const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
fs.closeSync(fd);
process.stdout.write(JSON.stringify({
   cursor: start,
   nextCursor: start + bytesRead,
   rotationLost: start !== cursor,
   truncated: start + bytesRead < size,
   output: buffer.subarray(0, bytesRead).toString('utf8')
}, null, 2));
NODE
```

Use only the returned `output` for this cycle. Immediately persist the current `logPath`, `pid`, `port`, `nextCursor`, and a new `updatedAt` to `metro-cursor.json`, even when `output` is empty or contains an error; this prevents duplicate processing after interruption and handles file replacement safely.

Count a clean cycle only after observing a full 5-second interval with empty or non-error new output. If the log file changes, the PID/port check becomes contradictory, or the cursor resets because the file shrank/rotated, never count that cycle as clean.

If `truncated: true`, never count the result as clean. Process any nonempty output, then issue at most three additional tail calls from the returned cursor in the same cycle. If `rotationLost: true`, record an explicit rotation warning in `fixes.md` and require a fresh full observation interval before incrementing the clean counter. If data remains truncated after four chunks, record a backlog warning and continue next cycle rather than consuming unbounded context.

In the new output, surface as classifiable signal and update the matching `health.json` domain:
- Runtime ` ERROR ` / ` WARN ` / ` LOG ` prefixes
- Host diagnostic lines with prefixes like `[PAHost]`, `[bridge]`, `[AuthProvider]`, `[AuthContext]`, `[useConnectionRefs]`, `[useConnectionSetup]`, `[addAadAppToConnectionAcl]`, `[PAHost][ErrorBoundary]`
- Stack frames (`at <fn> (<file>:<line>:<col>)`)
- Bundle-class errors (`Unable to resolve module`, `SyntaxError`, `transform failed`) — re-classify as Step B "Import / Bundle" Critical and route through Step D
- HTTP method + status from Metro's request log (e.g., `"GET /index.bundle?platform=ios&dev=true ..." 500 -`) — non-200 on `.bundle` is a bundle/transform failure; non-2xx on connector / Dataverse hosts feeds Step B "Network / API"
- Lines containing `Bundling complete` / `iOS Bundled` / `Android Bundled` are informational — log to `fixes.md` at debug volume but do NOT classify as an issue
- `[TRACE` prefixed lines from injected trace statements — classify under the symptom walk (Phase 0.5.4), not as errors

Interpretation rule for host diagnostic lines:
- Treat as classifiable signal only when lines match emitted host strings such as:
   - `[AuthProvider] MSAL init failed:`
   - `[AuthProvider] Intune enrollment failed:`
   - `[AuthContext] acquireTokenSilent failed for scopes:`
   - `[AuthProvider] Intune unenroll failed:`
   - `[bridge] unhandled plugin call`
   - `[bridge] fetch THREW for`
   - `[bridge] HTTP <status> for`
   - `[addAadAppToConnectionAcl] failed HTTP <status> for connection`
   - `[addAadAppToConnectionAcl] error:`
   - `[useConnectionRefs] could not verify connection ACLs; treating existing connections as setup-required`
   - `[useConnectionRefs] Failed to load connections:`
   - `[useConnectionSetup] could not grant connection ACL: missing Power Apps token or user OID`
   - `[PAHost] getConnectorToken: acquireToken threw for apiId="...":`
   - `[PAHost] getConnectorToken: acquireToken returned null for apiId="..."`
   - `[PAHost] getDataverseToken: acquireToken threw for orgUrl="...":`
   - `[PAHost] getDataverseToken: acquireToken returned null for orgUrl="..."`
   - `[PAHost][ErrorBoundary] Unhandled JS error:`
   - `[PAHost][ErrorBoundary] Error stack:`
   - `[PAHost][ErrorBoundary] Component stack:`
- Treat as informational when lines are lifecycle/status-only, such as bridge setup/ready, token acquisition start/success, bridge registration, and connection-setup screen visibility.

### Step B — Classify each new log entry

Apply the 8-category table. Treat each unique stack trace / error message as one issue.

| Priority | Pattern | Category |
|---|---|---|
| Critical | Uncaught exception, unhandled promise rejection, app crash | JS Runtime |
| Critical | `Unable to resolve module`, `Cannot find module` | Import / Bundle |
| Critical | `SyntaxError`, `Unexpected token`, `transform failed` (multi-line block from Metro terminal, primary mode only) | Import / Bundle |
| Critical | `Cannot read properties of undefined`, `is not a function` | JS Runtime |
| High | `NATIVE_MODULE_MISSING` from `pdfViewer` or `penInput` wrapper | Native |
| High | `NATIVE_MODULE_MISSING`, `PERMISSION_DENIED`, or `TRACKING_FAILED` from `geolocation` wrapper | Native |
| High | `INVALID_URL` from `pdfViewer`, or logs mentioning `content://`, `blob:`, or `http://` PDF viewer input | JS Runtime |
| High | `VIEWER_FAILED` or `CAPTURE_FAILED` from PDF/pen wrapper | Native |
| High | `ERROR` level runtime log | JS Runtime |
| High | HTTP 4xx / 5xx surfaced in logs | Network / API |
| High | Native module or bridge error | Native |
| Medium | React `Warning:` component error | React |
| Low | `WARN` level log that is not known noise | General |

**Parsing the multi-line bundle/transform block (primary mode):** Metro prints these as a banner (e.g., `error: Bundling failed`, `iOS Bundling failed`) followed by an indented block. Unlike runtime stacks, the file:line is on the **first non-banner line of the block**, formatted as `<absolute or relative path>:<line>:<col>`. There are usually **no** `at <fn>` stack frames. Example to recognize:
```
iOS Bundling failed 412ms
SyntaxError: /Users/.../app/(tabs)/todos.tsx: Unexpected token (47:12)
  45 |   return (
  46 |     <YStack>
> 47 |       <Text>{title</Text>
     |             ^
  48 |     </YStack>
  49 |   );
```
Take `app/(tabs)/todos.tsx:47:12` as the fix site. The recipes in D3.1 below operate on this format.

**Ignore known-noisy lines:**
- `Require cycle:` warnings from Metro
- `VirtualizedList: You have a large list…` without an associated crash
- Expo SDK informational banners (`Starting Metro…`, `Connecting to…`)
- React Navigation development warnings about non-serializable params (unless tied to a crash)
- `USER_CANCELLED` from pen input when the screen leaves state unchanged and does not show an error
- Host lifecycle/info lines with no failure indicator, for example `[bridge] setupNativeHost: bridge ready`, `[PAHost] bridge registered`, `[PAHost] render: waiting for connection resolution (spinner)`

### Step C — If NO issues found

Increment the consecutive-clean-cycle counter.

**Before exiting at `targetCleanCycles`, check the symptom guard.** Read `.powernative/debug-app/symptom-state` and pick the matching exit path below. (If no symptom-driven mode was used this session, Phase 0.1 cleared the file at startup, so the "file missing" branch fires.)

Before every clean, flagged, pending, timeout, iteration-cap, or escalation exit, print this sanitized health table from `health.json`:

```text
Health
Bundle             <status>  <summary>
Runtime            <status>  <summary>
Authentication     <status>  <summary>
Dataverse          <status>  <summary>
Connector          <status>  <summary>
Offline            <status>  <summary>
Navigation         <status>  <summary>
Native capability  <status>  <summary>
```

Keep `unknown` when no evidence was observed and `not-configured` only when configuration absence was positively detected. Apply the persistence redaction gate to every summary. A clean log interval does not make all unknown domains healthy.

**`resolved`** OR file missing (no symptom mode this session):

```
✓ App is running cleanly — no errors detected across <targetCleanCycles> consecutive log checks.
  Symptom verification: <PASS | n/a — no symptom provided>.
   Session summary written to .powernative/debug-app/fixes.md.

  To resume monitoring, run /debug-app again.
```

**`flagged`** (Phase 0.5 found a real problem that needs another skill):

```
⚠ Logs are clean BUT the symptom isn't fixed — it requires another skill.
  Symptom: <class> on <screen>
  Next step: <skill route recorded in unresolved.md by Phase 0.5> (e.g., run /add-connector)
   Details: .powernative/debug-app/unresolved.md

  Re-run /debug-app "<symptom>" after taking that step to verify the fix.
```

Do NOT print the green ✓ — the app is technically log-clean but the user-visible problem persists, and the user needs to act before re-running.

**`pending`** (still active after `targetCleanCycles` clean log cycles):

Append to `unresolved.md` with the Phase 0.5 chain findings, then print:

> "⚠ Symptom `<class>` on `<screen>` still active after `<targetCleanCycles>` clean log cycles. The runtime is quiet but the user-visible problem persists — likely a swallowed data-path error. See `.powernative/debug-app/unresolved.md` for the chain walk. Suggested next step: <derived from the walk>."

---

Exit the loop. Do NOT auto-resume.

**Iteration cap (applies in both modes):** independent of the clean-cycle counter and timeout, the loop exits after **50 total cycles**. Track `cycle: <N>` at the top of `fixes.md` and increment per cycle. On cap-hit, exit with:

> "⚠ Loop reached the iteration cap (50 cycles). Symptom may be intermittent OR a fix is regressing on every reload. See `.powernative/debug-app/fixes.md` for the per-cycle log. Suggested next step: review the last 3 fixes for circular regressions, or re-run with a more specific symptom."

If counter is < 3 AND the cap hasn't tripped, return to Step A on the next monitoring beat. Do not run shell `sleep` or a host-specific wait command; ordinary tool execution provides the cadence and the cursor prevents duplicate reads.

### Step D — If issues ARE found

Reset the consecutive-clean counter to 0. For each issue, work through the sequence below **one at a time** before moving to the next.

#### D0. Watch-only branch (`--no-fix`)

When `noFix=true`, do not continue to D1–D4 for mutation:

1. Record the category, exact error, top user-code frame when available, and the fix recipe or handoff that would have been used.
2. Append:
   ```text
   [<HH:MM:SS>] Observed (no-fix) — <category> — <file:line|no user frame> — <summary>
     Would do: <inline fix recipe | skill handoff | manual native action>
   ```
3. Do not edit project source/configuration, inject traces, type-check, reload, install, regenerate, switch accounts, or invoke another skill. Updating `.powernative/debug-app/` cursor, audit, and health files is allowed.
4. Continue to the next issue, then return to Step A. New output is still monitored until the clean target, timeout, stop, or iteration cap is reached.

#### D1. Gather context

Use the current Step A `output` block. Note whether the log shows:
- A crash with a full stack trace (app is crashing)
- A React error boundary message (component threw)
- A network error or HTTP status (API/connector failure)
- Empty response with no error (silent failure — consider injecting a `[INJECTED-TRACE]` console.log; see Phase 0.5.3 for the pattern)

For JS Runtime / React errors, the stack trace in the terminal IS the context. Read the topmost user-code frame to locate the file.

For crashes or blank screens with no terminal output: ask the user:
> "Do you see anything on screen — error boundary, blank white, or loading spinner? Please copy any visible error text."

#### D2. Root-cause analysis

Read the relevant source file(s). Identify:
- The exact file and line causing the error. For runtime errors (JS Runtime, React, Network/API), pick the topmost user-code frame from the stack trace (skip `node_modules/` and `src/generated/`). For bundle / transform errors (Import / Bundle category, primary mode), use the file:line on the first non-banner line of the Metro error block — see Step B's parsing note.
- Whether the fix touches the data layer, UI layer, routing, or schema.
- Whether the fix could regress other screens.

**Dataverse / Power Platform diagnostic sequence (before handoff):**

1. Read [skills/add-dataverse/references/dataverse-reference.md](../add-dataverse/references/dataverse-reference.md). Use `memory-bank.md` and the relevant `native-app-plan.md` sections when present.
2. Read `power.config.json`; take `environmentId` from it before any other source. Inspect the relevant generated service/model and `connectorSchemas.ts`.
3. Resolve the environment read-only:
   ```bash
   node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "<environmentId-or-url>"
   ```
   If resolution fails, run `npx power-apps auth-status --json`. Never switch accounts, log out, or open login from `/debug-app` without user confirmation.
4. When environment resolution succeeds and live evidence is required, use only read-only `GET` requests through:
   ```bash
   node "${PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET <apiPath> \
     --tenant-id '<resolved-tenant-id>'
   ```
   Start with `WhoAmI` when authentication/tenant identity is in question. Use bounded metadata/entity reads to confirm table and column names. Do not create, update, delete, publish, seed, flood, or intentionally invalidate credentials from `/debug-app`.
5. App runtime data fixes must continue to use generated `<Table>Service` calls. Never replace them with direct `fetch`/`axios` Dataverse calls.
6. If OData syntax, lookup behavior, choice/virtual/file/image fields, authentication, throttling, or error shape remains uncertain, query Microsoft Learn with the exact error/token before forming a fix.

Only after this sequence proves that a table/column/service/schema artifact is missing or incompatible should D3 route to `/add-dataverse`.

**Expo / Expo Router / React Native diagnostic sequence:**

1. Read the cited app file plus `package.json`, `app.json`/`app.config.js`, and route layout only as relevant.
2. Prefer installed package types/readmes for the exact version.
3. If behavior remains uncertain, use a targeted `WebFetch` against official `https://docs.expo.dev/` documentation (Expo Router pages for routing; SDK pages for native modules). Do not query Microsoft Learn for Expo/React Native behavior.

#### D3. Apply the fix

**For Import / Bundle category errors, jump to D3.1 first** — those have specific recipes that pre-empt the generic routing table below. For everything else (JS Runtime, Network/API, React, etc.), use the routing table:

| Error location / category | Action |
|---|---|
| `app/` screen file, `_layout.tsx`, route segment | Inline edit via `Edit` tool |
| `src/components/` | Inline edit via `Edit` tool |
| `src/hooks/`, `src/services/` | Inline edit via `Edit` tool |
| `src/generated/` | **Do not edit.** Fix the upstream query or schema and run `npm run generate-schemas` |
| Dataverse schema (column/table missing) | Run D2's read-only Dataverse diagnostic sequence first. If live metadata/generated artifacts confirm the schema or service is missing, **hand off** to `/add-dataverse`. Do not mutate Dataverse or edit generated files from `/debug-app`. |
| Auth / MSAL (`AADSTS65001`, `AADSTS50011`) | **Hand-off:** route user to the Power Apps Wrap page via `/set-app-registration-native`. Do not auto-edit registrations. |
| Connection / connector reference missing | **Hand-off:** route user to `/list-connections` or `/add-connector`. |
| Native module, `app.config.js`, `app.plugin.js`, `Podfile`, `build.gradle` | **Inform the user.** Do NOT auto-edit native config — print the error + suggested action and skip to next issue. |
| Unrecognized error pattern | **Best-effort autonomous fix** — see D3.2 below. The skill attempts a single named hypothesis instead of stopping; the existing 2-attempt escalation rule is the safety net. |

PDF/pen/geolocation-specific routing:
- `INVALID_URL` for PDF viewer input is an inline screen/wrapper fix. Allow `https://` and non-empty `file://` inputs with viewer 0.2.9+. Never add support for `content://`, `blob:`, or `http://` in the native viewer path.
- A generated PDF local `file://` URI may be opened by native PDF viewer 0.2.9+.
- `NATIVE_MODULE_MISSING` for PDF viewer or pen input means the native extension is not in the running build. Do not install packages or edit native config from debug; route to `/add-native pdf-viewer` or `/add-native pen-input` to verify wrapper/package state, then tell the user a native rebuild/template update is needed if the package is absent from the app build.
- For `geolocation`, debug the actual failure dimension: can tracking start (`startTracking`, permissions, native module), are rows reaching Dataverse (default `msdyn_locationrecords` exists, native upload/auth errors, no JS upload path), and does behavior match the user expectation (background, restart persistence, breadcrumb/route continuity). Fix visible screen handling inline; if the native module/table is missing, block use and route to the relevant geolocation setup path, not `/add-dataverse`.
- `USER_CANCELLED` from pen input is not a bug unless the screen renders it as an error. Inline fix screens that show cancellation as failure.
- Dataverse artifact writes are local app fixes only when the schema/service already exists. If File/Image columns are missing, route to `/add-dataverse`.

For inline edits, keep the change minimal and surgical. Do not refactor surrounding code, rename symbols, or change component contracts.

Append to `.powernative/debug-app/fixes.md`:
```
[<HH:MM:SS>] <category> — <file>:<line> — <one-line description of fix>
```

#### D3.1 Bundle / transform error fix recipes (Import / Bundle category)

These recipes apply to errors classified as "Import / Bundle" in Step B. They are read from the persisted `.powernative` Metro log. Each recipe is opinionated: take the action listed if its precondition matches, otherwise fall through to the next.

| Error pattern | Precondition | Action |
|---|---|---|
| `SyntaxError: <file>:<line>:<col>` in `app/`, `src/components/`, `src/hooks/`, `src/services/` | The cited line is in editable user code (NOT `src/generated/`, NOT `node_modules/`) | `Read` the file around the cited line (±10 lines), identify the syntactic issue (unclosed JSX tag, missing closing brace/paren, stray comma, missing `from` in import, unterminated string, missing semicolon between statements), apply a single minimal `Edit`. Do NOT reformat surrounding code. |
| `SyntaxError` in `src/generated/` | Cited file is under `src/generated/` | **Do not edit.** Schema regen produced bad output. Hand-off: tell the user to re-run `npm run generate-schemas`; if the error reproduces, route to `/add-connector` or `/add-dataverse` to re-add the affected datasource. |
| `Unable to resolve module <name>` from `<importer>` | `<name>` starts with `.` or `..` (relative import) | `Glob` the importer's directory for files matching `<name>` with any extension (`.ts`, `.tsx`, `.js`, `.jsx`, `.json`). If found with a different extension → fix the import to drop the extension OR match the actual one. If found with a typo (Levenshtein ≤ 2) → fix the typo. If not found at all → the file genuinely doesn't exist; surface to user and ask whether to create it or remove the import. |
| `Unable to resolve module <name>` | `<name>` is a bare package AND not present in `package.json` `dependencies` / `devDependencies` | Follow [`shared/references/javascript-dependency-planning.md`](../../shared/references/javascript-dependency-planning.md) to classify the published package by contents, not its name. If native-bound and absent from the template, report that a template/runtime update is required. If verified pure JavaScript, ask consent for the exact version, install with `npm install --save-exact`, validate, and retry. Do NOT install without consent. |
| `Unable to resolve module <name>` | `<name>` IS in `package.json` but the bundle still fails | Likely cache: ask the user to stop Metro, rerun `npm run dev -- --clear`, then reload. Never kill an unowned process. |
| `transform failed` referencing a babel plugin (e.g., `[BABEL] ... unknown plugin "react-native-reanimated/plugin"`) | Error references `babel.config.js` | **Hand-off.** `babel.config.js` is project config (same constraint that protects `app.config.js`). Print the cited plugin and suggested fix order (e.g., "`react-native-reanimated/plugin` MUST be the LAST plugin in `babel.config.js` `plugins` array"); skip to next issue. |
| `transform failed` without a babel reference | Generic transform failure (often a TS feature Metro's transformer can't handle) | Read the cited file, look for syntax that requires a specific TS lib (e.g., decorators, top-level await). If the issue is a known-bad pattern, surface and ask before fixing. Otherwise hand-off. |
| `predev` script failure (e.g., `npm run generate-schemas` errored before `expo start` ran) | Bundle output shows the failure happened during the `predev` lifecycle hook | This is not a code edit — `power.config.json` or the connector setup is broken. **Hand-off:** route user to `/add-connector` (for Power Platform connectors) or `/add-dataverse` (for Dataverse). Do NOT edit `power.config.json` directly. |
| `[BABEL] ... You're trying to use the @babel/plugin-X plugin twice` | Duplicate babel plugin entries | **Hand-off** for the same reason as above — `babel.config.js` is project config. Surface the duplicate; let the user dedupe. |

After applying any inline edit (rows 1, 3, 4 above), Metro auto-detects the file save and re-bundles. Skip directly to D4 — do NOT manually trigger a reload. The verify step picks up Metro's `Bundling complete` (or the next error block) automatically.

Append to `.powernative/debug-app/fixes.md`:
```
[<HH:MM:SS>] Import/Bundle — <file>:<line> — <recipe applied>
```

#### D3.2 Best-effort fix recipe for uncategorized errors

When an error falls through every row of Step B's classification table AND every row of D3.1's bundle recipes, the skill still attempts a fix instead of stopping. The discipline below keeps best-effort from degrading into wild guessing.

**Step 1 — Locate the cite.** Try in order; stop at the first that yields a file:line in editable user code:

1. **Stack trace top user-frame** — walk the stack from the top, skip frames in `node_modules/`, `src/generated/`, and React/Hermes internals (`react-native/`, `hermes-engine/`, `metro/`). First remaining frame is the cite.
2. **Multi-line bundle block** — see Step B's parsing note (file:line on the first non-banner line).
3. **Verbatim grep across the repo** — `Grep` for the exact error message text (or its most distinctive 4–6 word phrase, with regex special chars escaped) across `app/`, `src/components/`, `src/hooks/`, `src/services/`. A match at a `throw new Error('...')` site IS the cite.
4. **Module + symbol grep** — if the error mentions a function or component name (e.g., `useFoo is not a function`), `Grep` for the symbol; the unique declaration site is the cite.

If no cite can be located by step 4: log a structured note to `.powernative/debug-app/unresolved.md` (verbatim error + which lookup attempts ran), surface to the user, advance to next issue. **Do not guess at a file.** Best-effort still requires a target.

**Step 2 — Enrich understanding (do not skip).**

- If the error contains a Microsoft-stack token (`AADSTS\d+`, `Dataverse`, `Power Platform`, `MSAL`, `Entra`, `Graph API`): first run D2's project/reference/read-only diagnostic sequence, then query `mcp__plugin_mobile-app_microsoft-learn__microsoft_docs_search` with the exact code or token when behavior remains uncertain.
- If the error concerns Expo, Expo Router, an Expo SDK module, or React Native behavior: inspect the installed version and local package documentation, then use targeted `WebFetch` against `https://docs.expo.dev/`. Do not use Microsoft Learn for these errors.
- Read the cited file ±15 lines for surrounding context. Note recent imports, the function signature, and any nearby `try/catch` or `useEffect` deps.
- If the error mentions a third-party module (anything in `node_modules/` from the stack), one targeted `WebFetch` against the module's npm page or GitHub README is acceptable; do NOT do open-ended web searches in the loop.

**Step 3 — Form ONE named hypothesis.** Write it to `.powernative/debug-app/fixes.md` BEFORE editing, in this format:

```
[<HH:MM:SS>] Hypothesis (best-effort) — <file>:<line> — <one-sentence theory>
  Evidence: <what in the error message + cited code led you here>
  Planned change: <what you'll edit, in 1 line>
```

Examples of acceptable hypotheses:
- "`<UserAvatar>` reads `user.profile.image` but `user` can be undefined during the first render — add a null guard"
- "The `useEffect` at line 42 captures a stale `userId` because `userId` isn't in its deps array"
- "`AsyncStorage.getItem` returns null for missing keys, but the caller assumes JSON-parseable string"

NOT acceptable (refuse to apply, escalate instead):
- "Something is wrong with state management" (vague — no specific change implied)
- "Try wrapping in try/catch" (mask, not fix — silently swallows the real bug)
- "Maybe also update X, Y, and Z" (multi-armed — violates one-fix-at-a-time)

**Step 4 — Apply a single minimal edit.** One `Edit` call, smallest possible diff that implements the planned change. Do NOT change unrelated code, rename symbols, or refactor surrounding structure. Re-confirm the file path is in editable user code (NOT under `src/generated/`, `node_modules/`, or any path in the Constraints section's protected list).

**Step 5 — Defer to D4 verify.** The existing verify cycle (type-check + reload + re-poll) decides whether the hypothesis was right. Do NOT preemptively try a second hypothesis "just in case."

**Step 6 — On verify failure, ONE alternative is allowed.** If D4 shows the same error reappearing, you may form ONE alternative hypothesis (this counts as fix attempt #2 against the original error). If THAT also fails, the existing Escalation rule trips and the skill stops on this error — surface to the user, append to `unresolved.md`, advance to the next issue. Do NOT chain a third hypothesis.

**Constraint reminder for best-effort mode (no exceptions):**
- Never edit `src/generated/`, `node_modules/`, `app.config.js`, `app.plugin.js`, `babel.config.js`, `metro.config.js`, `Podfile`, `build.gradle`, `gradle.properties`, `power.config.json`, `auth.config.json`.
- Never run `npm install <pkg>`, `npm uninstall <pkg>`, `npx expo install <pkg>`, or any command that mutates `package.json` / `package-lock.json` without explicit user consent (same gate as D3.1's bare-package recipe).
- Never restart Metro, run `expo prebuild`, or otherwise touch the dev-server lifecycle.
- If the only plausible hypothesis violates one of these constraints, treat the error as out-of-scope: hand-off to the user with a one-line explanation and advance.

#### D4. Verify the fix

After the fix is applied:

1. **Type-check:**
   ```bash
   npm run type-check
   ```
   If TS errors exist, fix them before continuing. Do not advance until type-check exits 0.

2. **Wait for Metro to re-bundle (Import/Bundle fix only):**
   For inline edits applied via D3.1, Metro auto-watches the file and triggers a re-bundle on save. Re-run the Step A cursored tail procedure for a bounded set of checks, watching for one of:
   - `Bundling complete` / `iOS Bundled` / `Android Bundled` → success, proceed to step 4.
   - A new bundle error block (different file:line, or different message) → treat as a NEW issue and return to Step B.
   - Same error repeats → the fix didn't take. Treat as fix attempt #2 against the same error (Escalation rule applies after 2).
   - 30s elapsed with no bundling activity → Metro may be paused/wedged; surface to user, do NOT auto-restart Metro (Constraints).

3. **Reload the app (all other fixes — JS Runtime, Network/API, React, etc.):**
   Fast Refresh should apply most inline edits. If no new bundle/runtime activity appears, instruct the user:
   > "Please reload the app from the native dev-client menu, then trigger the workflow again."

   After the user confirms, run the Step A cursored tail procedure to check only new output.

4. **Confirm the fix via persisted output.** If the previous error pattern is absent from newly appended log bytes and no new errors appear, the fix held. If any `[INJECTED-TRACE]` lines are relevant, use them to confirm the data path is healthy. After confirming, clean up injected logs (Phase 0.5.5).

5. **Reset clean-cycle counter to 0** and return to Step A.

---

## Escalation

If the same error persists after **2 fix attempts**, stop and report:

```
⚠ Unresolved after 2 attempts: <error summary>
  File:           <path>
  Log:            <exact error line>
  Last fix tried: <one-line description>
  Suggested next step: <manual action>
```

Append the same block to `.powernative/debug-app/unresolved.md`. Clean up any `[INJECTED-TRACE]` logs before exiting (Phase 0.5.5 procedure).

Do NOT attempt a third automated fix for the same error. Wait for user guidance.

---

## Constraints

- **Never fix native config files** (`app.config.js`, `app.plugin.js`, `Podfile`, `build.gradle`, `gradle.properties`) — report the error to the user with the exact line and a suggested manual action.
- **Never modify `src/generated/`** — these files are auto-generated. Fix the upstream query / service / schema instead, then run `npm run generate-schemas`.
- **Dataverse diagnosis is read-only** — `/debug-app` may resolve the configured environment and issue bounded Dataverse `GET` requests through the bundled scripts. It must never perform metadata/data writes, publish, seed records, intentionally trigger throttling, invalidate tokens, switch CLI accounts, or replace generated services with direct HTTP.
- **Do not ask the user about errors mid-cycle** — investigate autonomously using the tools above. Only surface to the user when:
  1. The fix requires a native config change.
  2. The fix requires a tenant admin action (e.g., AAD consent).
  3. You have attempted a fix twice and the same error persists (escalation).
  4. The fix routes to another skill (`/add-dataverse`, `/set-app-registration-native`, `/list-connections`).
- **One fix at a time** — fully resolve one issue (including type-check + reload + log verification) before starting the next.
- **Always clean up injected logs** — any `// [INJECTED-TRACE]` line added during a session MUST be removed before the session ends, even if the symptom is `pending` or `flagged`. Use `grep -rn 'INJECTED-TRACE' app/ src/hooks/ src/services/` to find them.
- **Preserve existing behavior** — fixes must be minimal and surgical. Do not refactor, rename, or change component contracts as a side effect of a bug fix.
- **Bounded polling** — do not busy-loop. Every poll advances a persisted byte cursor and each cycle processes at most four 256 KiB chunks.
- **Log every action** — before each tool call, print a one-line description of what you're about to do and why, so the user can follow along.

---

## Failure Modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Phase 0 reports `not-started` or `stopped` | No live `.powernative` Metro log exists | Run `npm run dev`, open the native app, then rerun `/debug-app` |
| Phase 0 sees recent failure lines | Expo/Metro exited during startup or runtime | Read the latest log tail, fix the sanitized error, then ask the user to restart `npm run dev` |
| Phase 0 reports "Metro running but no app connected" | Simulator/device hasn't loaded the app yet | Open the app on the simulator/device, then re-run `/debug-app` |
| Loop appears stuck | Fix taking longer than expected (e.g., type-check on large project) | Wait — log lines should still print as the fix runs. Type `stop` to exit. |
| Loop exits with "iteration cap reached" | Symptom is intermittent OR a fix is regressing on every reload | Inspect the last 3 entries in `fixes.md` for circularity; re-run with a more specific symptom or fix manually |
| Same error keeps recurring after fix | Fast Refresh didn't apply the change, or the fix targeted the wrong file | Verify with `git status`; reload from the native dev-client menu; re-run |
| Same error persists after fix AND `git status` shows the change saved AND type-check is clean | Stale Metro transform cache | Ask the user to stop Metro, rerun `npm run dev -- --clear`, reload, then rerun `/debug-app` |
| Escalation triggered immediately | Error pattern is in a category we hand-off (auth, schema, native) | Take the suggested manual action, then re-run `/debug-app` |
| `.powernative/debug-app/fixes.md` not appearing | Phase 0 didn't run / state directory not created | Run `mkdir -p .powernative/debug-app` manually, re-run skill |
| "App is running cleanly" but the user still sees the problem | Symptom-driven mode was not used — log polling alone is blind to silent failures | Re-run as `/debug-app "<describe what you see>"` to trigger Phase 0.5 (console.log injection) |
| Phase 0.5 reports `screen=unknown` | Symptom text didn't match any route filename | Re-run with a more specific symptom (`/debug-app "todos screen empty"` not `"data is broken"`), OR navigate to the broken screen first then re-run |
| No `[TRACE` lines after reload | Metro cached the old bundle | Ask the user to stop Metro, rerun `npm run dev -- --clear`, then reload the app |
| `[INJECTED-TRACE]` lines left in code after session | Cleanup step was skipped | Run `grep -rn 'INJECTED-TRACE' app/ src/hooks/ src/services/` and remove each matching line |

---

## Notes

- **Designed to be re-run** — every invocation is idempotent. `.powernative/debug-app/metro-cursor.json` advances past previously seen bytes and resets safely when a new Metro session or rotated log is detected.
- **Honest about limits** — this is a foreground loop. While it's running, you can't run other skills. By design — the model is "build first, debug second." If you need to pause, type `stop` and resume later.
- **No specialist agents** — upstream's `app-debugger.agent.md` delegates to `screen-builder`, `component-author`, `api-integration`, `dataverse-data-modeler` agents. We don't have all those agents in this plugin, so this skill fixes inline OR routes to skills (`/add-dataverse`, `/set-app-registration-native`, `/list-connections`, `/add-connector`). Behavior is equivalent for the categories we cover.
- **Host diagnostics caveat** — host-prefixed diagnostics (`[PAHost]`, `[bridge]`, `[AuthProvider]`, etc.) are expected in dev-player sessions and should be treated as first-class telemetry. If these lines are absent in non-dev-player builds, that is expected and not itself a bug.
- **Upstream parity table:**

  | Behavior | Upstream | This skill |
  |---|---|---|
   | Log-driven monitor loop | yes | yes — project-local sanitized Metro log is authoritative; host terminal APIs are optional only |
  | 8-category classification | yes | yes |
  | Verification cycle (type-check + reload + re-poll) | yes | yes |
  | Escalation after 2 attempts | yes | yes |
   | Bounded polling | yes | yes — durable byte cursor, bounded chunks |
  | Configurable consecutive-clean exit | fixed at 3 | yes — default 3, configurable with `--cycles`, and gated on symptom resolution |
  | Specialist agent delegation | yes | replaced with skill routing |
   | Working-dir audit log | no | yes (additional — `.powernative/debug-app/fixes.md`, `injected-logs.md`) |
  | MS Learn fallback for unknown errors | no | yes (additional) |
   | Persisted Metro/app log source (bundler errors + Hermes console + HTTP request log) | no | yes — survives host restarts; no MCP fallback |
  | Bundle / transform error fix recipes (D3.1) | no | yes (additional) |
  | Bundle-aware verify (poll Metro for `Bundling complete`) | no | yes (additional) |
  | Best-effort autonomous fix for uncategorized errors (D3.2) | no | yes (additional) |
  | Symptom-driven mode — console.log injection + terminal read + data-path walk | no | yes (additional — catches silent failures invisible to log polling; injects `[INJECTED-TRACE]` logs, reads terminal, cleans up logs after root cause found) |
