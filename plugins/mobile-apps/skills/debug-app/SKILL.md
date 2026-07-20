---
name: debug-app
description: Use when the user has finished building a mobile app, started its project-local Metro session, and wants the running app monitored for runtime errors AND silent failures (empty lists, blank screens, swallowed network errors) and fixed autonomously. Accepts a free-text symptom (e.g., `/debug-app "todos not appearing on home screen"`) to drive persisted-log diagnostics — injects temporary console.log statements at data-path boundaries, reads the sanitized `.expo/metro-session/metro.log`, and cleans up logs after the root cause is fixed. Otherwise polls that log with a durable byte cursor, classifies errors using an 8-category table, fixes inline or routes to the right skill, verifies each fix from new log output, and exits after 3 consecutive clean polls. Foreground loop — blocks the conversation while running. Run only after the app is loaded.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, WebFetch, mcp__plugin_mobile-app_microsoft-learn__microsoft_docs_search
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

# Debug App — Monitor & Fix

Monitor the running app through the bundled `scripts/metro-session.js` process manager, detect runtime and bundle errors in its project-local sanitized log, and fix them autonomously by editing the affected files (or routing to the right skill when the fix belongs in a domain like Dataverse schema or auth registration). For silent failures, inject temporary `console.log` statements at data-path boundaries, read only newly appended log bytes, then clean the traces after the root cause is fixed. Modeled on the upstream `app-debugger.agent.md` pattern — foreground loop, bounded polling, exit on 3 consecutive clean polls.

> **Dev-client limitation:** the standalone dev client sends app/runtime logs, React errors, host diagnostics, and Metro bundler output through the Metro process. The wrapper captures and redacts that stream into `.expo/metro-session/metro.log`; there is no separate device log source. Host diagnostics include strings such as `[AuthProvider] MSAL init failed:`, `[bridge] fetch THREW for`, `[bridge] HTTP <status> for`, `[addAadAppToConnectionAcl] failed HTTP <status> for connection`, `[useConnectionRefs] could not verify connection ACLs; treating existing connections as setup-required`, and `[PAHost][ErrorBoundary] Unhandled JS error:`.

## Subcommands (parsed from `$ARGUMENTS`)

| Form | Behavior |
|---|---|
| `/debug-app` (no args) | **Default — project-log-driven mode.** Run Phase 0, resolve `.expo/metro-session/state.json`, then enter the monitor loop using `metro-session.js tail`. No host terminal ID is required. |
| `/debug-app "<symptom text>"` | **Symptom-driven mode** (recommended when there's a user-visible problem). Free-text symptom such as `"todos not appearing on home screen"`, `"login button does nothing"`, `"list empty after refresh"`. Run Phase 0 → Phase 0.5 (parse symptom → ask the user to reproduce/navigate → walk the likely data path from terminal traces) → enter monitor loop. Catches silent failures (empty lists, blank screens, swallowed errors) that pure log polling misses. |
| `/debug-app status` | Run `metro-session.js status`, then print current Metro state, last cursor, fixes applied, and unresolved errors. Do NOT enter the loop. |
| `/debug-app stop` | Stop only the foreground debug loop and preserve `.claude/debug-app/` state. It does not stop Metro. To stop Metro explicitly, run `node "${PLUGIN_ROOT}/scripts/metro-session.js" stop --project-root <working_dir>`. |

**Dispatch rule:** if `$ARGUMENTS` is non-empty and is not one of the reserved subcommand tokens (`status`, `stop`, `help`, `--help`, `-h`, `version`, `--version`), treat the entire string (everything after the command name; outer quotes optional) as the symptom and use symptom-driven mode. For `help` / `--help` / `-h`, print the subcommands table above and exit.

**Tip — "play around then debug":** the wrapper persists recent Metro/app output even across chat or editor restarts. If something weird just happened, keep using the app normally, then run `/debug-app` or `/debug-app "<what you saw>"`. The first cycle reads the latest persisted log window; subsequent cycles read only bytes appended after the saved cursor.

## Core Principles

- **Foreground autonomous loop** — Once started, this skill owns the conversation until 3 consecutive clean polls confirm the app is healthy, the user types `stop`, or the escalation rule trips. **Do not run other skills concurrently** — they'll queue behind the loop.
- **Run AFTER the app is loaded** — the project-local Metro session must be running and the simulator/device must have the app open. Phase 0 verifies this; the skill stops cleanly if no app is detected.
- **Native-only runtime target** — The app must be loaded in a native dev client on a device or simulator; `.expo/metro-session/metro.log` is the authoritative log source for that native session.
- **No web or direct Metro probes** — Do not use React Native Web, browser automation, `curl`, `fetch`, `WebFetch`, or any direct request to a Metro/localhost endpoint for runtime diagnosis. Read only the wrapper state/log and source files.
- **No screen-by-screen verification** — Do not crawl routes or validate every screen. In symptom mode, focus only on the user-reported workflow and the terminal/source evidence needed to diagnose it.
- **One fix at a time** — Fully resolve one issue (context → fix → type-check → reload → re-poll) before starting the next. No batching.
- **Working-dir state** — Debug audit state lives in `.claude/debug-app/`: `fixes.md`, `unresolved.md`, `injected-logs.md`, and `metro-cursor.json`. Metro process state/logs live in the already-ignored `.expo/metro-session/`. Both survive chat/editor restarts.
- **Host terminal APIs are optional only** — If the current host already exposes the Metro terminal output, it may be consulted as a low-latency convenience. Never ask the user for a terminal ID, never persist one, and never make a diagnosis from host output without advancing the authoritative project-log cursor too.
- **Reference resolution order** — For unfamiliar errors: in-repo references first ([skills/add-dataverse/references/dataverse-reference.md](${CLAUDE_SKILL_DIR}/../../skills/add-dataverse/references/dataverse-reference.md), etc.), then `mcp__plugin_mobile-app_microsoft-learn__microsoft_docs_search`, then general web search.

## Workflow — Task List First

Before entering the monitor loop, write a task list and keep it up to date:

```
- [ ] Verify project-local Metro session is running (`metro-session.js status`)
- [ ] Capture baseline log state (`metro-session.js tail`, save byte cursor)
- [ ] (Symptom mode only) Phase 0.5: parse symptom → ask user to navigate → inject console.logs → read new log bytes → walk data path → clean up logs
- [ ] Monitoring cycle 1: collect → classify → fix if needed
- [ ] Monitoring cycle 2: collect → classify → fix if needed
- [ ] Monitoring cycle 3: collect → classify → fix if needed
      (add cycles as needed; stop after 3 consecutive clean cycles AND symptom resolved/flagged)
- [ ] Fix: <error summary> → <inline edit | skill route>  (one task per error found)
```

Mark each cycle complete (clean OR fixed) before starting the next.

---

## Phase 0 — Startup Check

Before entering the loop:

### 0.0 Resolve the project-local Metro session

Determine `<working_dir>` from `--working-dir` when present, otherwise use the current app root. Define:

```bash
METRO_SCRIPT="${CLAUDE_SKILL_DIR}/../../scripts/metro-session.js"
node "$METRO_SCRIPT" status --project-root "<working_dir>"
```

Parse the JSON result:

| Status | Action |
|---|---|
| `running: true` | Capture `sessionId`, `statePath`, `logPath`, and continue. |
| `status: starting` | Run `status` once more. If still starting, tell the user Metro is not ready yet and stop cleanly. |
| `status: failed` | Run `tail --lines 120`, surface the sanitized launch error, and stop. |
| `stale`, `stopped`, or `not-started` | Tell the user Metro is not running. Offer to start it with `node "$METRO_SCRIPT" start --project-root "<working_dir>" --wait-ready-ms 8000`; start only after confirmation, then rerun status. |

If no wrapper session exists but the host happens to expose a live Metro terminal, that output may explain what is running, but do not ask for or store its terminal ID and do not enter the continuous monitor loop against it. Portable monitoring requires the wrapper session.

Record the stable source in `fixes.md`:

```text
[<HH:MM:SS>] Log source — <working_dir>/.expo/metro-session/metro.log (session <sessionId>)
```

### 0.1 Ensure state directory

```bash
mkdir -p .claude/debug-app
touch .claude/debug-app/fixes.md
touch .claude/debug-app/unresolved.md
touch .claude/debug-app/injected-logs.md
touch .claude/debug-app/metro-cursor.json
rm -f .claude/debug-app/symptom-state    # per-session — Phase 0.5 rewrites it if symptom mode is active
```

If `fixes.md` is empty, write a session header:
```
# Debug session — <date>

```

### 0.2 Verify Metro bundled and the app is running

Read the latest sanitized log window:

```bash
node "$METRO_SCRIPT" tail --project-root "<working_dir>" --lines 500 --max-bytes 262144
```

Parse `output`, `sessionId`, and `nextCursor`. Scan `output`:

- Most recent error-class line is `SyntaxError`, `Unable to resolve module`, `transform failed`, or `error: Bundling failed` → bundle is broken. Treat as a Step B "Import / Bundle" critical error and route through Step D immediately. Do NOT enter the steady-state loop until the bundle is healthy.
- Output contains `Bundling complete` / `iOS Bundled` / `Android Bundled` with no later error-class line → Metro is healthy. Proceed.
- Output contains a Metro banner (`Metro waiting on`, `Logs for your project`, or `› Metro:`) but no native `Bundled` / `bundling` lines yet → Metro is up but no native client has connected. Tell the user:
  > **Metro is running but no app is connected yet.** Open the app on a device or simulator, then re-run `/debug-app`.
  Stop here.
- Output is empty despite `status.running: true` → Metro has not emitted enough state yet. Tell the user to wait for the native URL, then re-run `/debug-app`; do not guess readiness.

Before initializing the cursor, pass **all** classifiable entries in this initial
window through Step B, including JS runtime errors, React warnings, network/API
failures, native errors, and host diagnostics. Do not advance past a prior error
just because it is not a bundle error. This preserves the promise that users can
"play around, then debug" after a symptom already occurred.

### 0.3 Capture baseline

Use the output from Phase 0.2. Note the most recently bundled native platform (iOS / Android) and any recent runtime log lines. Append to `fixes.md`:
```
[<HH:MM:SS>] Baseline — last Metro activity: <1-line summary of most recent lines>
```

### 0.4 Initialize the durable byte cursor

Write `.claude/debug-app/metro-cursor.json` using structured JSON:

```json
{
   "sessionId": "<sessionId from tail result>",
   "cursor": 12345,
   "generation": 0,
   "updatedAt": "<ISO timestamp>"
}
```

Set `cursor` to `nextCursor` from Phase 0.2. On later invocations:

- Same `sessionId` and `generation` → reuse the saved cursor so old errors are not processed again.
- New `sessionId` → discard the old cursor and initialize from the latest log window.
- Changed `generation`, or `tail.truncated: true` because the log rotated or shrank → accept the returned reset cursor/generation and record the rotation in `fixes.md`.

---

## Phase 0.5 — Symptom-driven setup (only when `$ARGUMENTS` is a symptom string)

Skip this entire phase if no symptom was provided. The standard log-polling loop alone is good at *visible* errors but blind to *silent* ones: an empty list because the connector wasn't added, a blank screen because `useFocusEffect` wasn't wired, blank rows because column names don't match the model. Phase 0.5 closes that gap.

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

Record every injection in `.claude/debug-app/injected-logs.md`:
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
| No `[TRACE` lines at all | Metro may have cached the old bundle | Ask permission to restart through the wrapper: `stop`, then `start --clear --wait-ready-ms 8000`; reload the native app |

Record the outcome in `.claude/debug-app/symptom-state` (single line: `resolved`, `flagged`, or `pending`).

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
echo '' > .claude/debug-app/injected-logs.md
```

Run `npm run type-check` once after cleanup.

> **Hard rule:** Never leave `[INJECTED-TRACE]` lines in code. Clean up before marking the session done, even if the symptom is `pending` or `flagged`.

### 0.5.6 Re-enter the standard monitor loop

After Phase 0.5 completes, fall through to the monitor loop (Step A). The "3 consecutive clean cycles" exit condition is **suspended** until the symptom is either marked resolved or recorded as `NEEDS ATTENTION` in `unresolved.md`. After that, the loop exits per the standard rule.

---

## Monitor Loop

Repeat until **3 consecutive clean cycles**, OR the user types `stop`, OR the escalation rule trips.

### Step A — Collect logs

Read `.claude/debug-app/metro-cursor.json`, confirm its `sessionId` matches `metro-session.js status`, then run:

```bash
node "$METRO_SCRIPT" tail \
   --project-root "<working_dir>" \
   --cursor <saved-cursor> \
   --generation <saved-generation> \
   --wait-ms 5000 \
   --max-bytes 262144
```

Use only the returned `output` for this cycle. Immediately persist `nextCursor`, `nextGeneration`, and the current `sessionId` to `metro-cursor.json`, even when `output` is empty or contains an error; this prevents duplicate processing after interruption and handles same-session log rotation safely.

Count a clean cycle only when the result has `observationComplete: true` and the full `tail --wait-ms 5000` interval contains empty or non-error output. A process/session transition returns `observationComplete: false` and is never a clean cycle.

If `truncated: true`, never count the result as clean. Process any nonempty output, then issue at most three additional tail calls from the returned cursor/generation in the same cycle. If `rotationLost: true`, record an explicit lost-generation warning in `fixes.md` and require a fresh full observation interval before incrementing the clean counter. If data remains truncated after four chunks, record a backlog warning and continue next cycle rather than consuming unbounded context.

In the new output, surface as classifiable signal:
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

**Before exiting at 3 clean cycles, check the symptom guard.** Read `.claude/debug-app/symptom-state` and pick the matching exit path below. (If no symptom-driven mode was used this session, Phase 0.1 cleared the file at startup, so the "file missing" branch fires.)

**`resolved`** OR file missing (no symptom mode this session):

```
✓ App is running cleanly — no errors detected across 3 consecutive log checks.
  Symptom verification: <PASS | n/a — no symptom provided>.
  Session summary written to .claude/debug-app/fixes.md.

  To resume monitoring, run /debug-app again.
```

**`flagged`** (Phase 0.5 found a real problem that needs another skill):

```
⚠ Logs are clean BUT the symptom isn't fixed — it requires another skill.
  Symptom: <class> on <screen>
  Next step: <skill route recorded in unresolved.md by Phase 0.5> (e.g., run /add-connector)
  Details: .claude/debug-app/unresolved.md

  Re-run /debug-app "<symptom>" after taking that step to verify the fix.
```

Do NOT print the green ✓ — the app is technically log-clean but the user-visible problem persists, and the user needs to act before re-running.

**`pending`** (still active after 3 clean log cycles):

Append to `unresolved.md` with the Phase 0.5 chain findings, then print:

> "⚠ Symptom `<class>` on `<screen>` still active after 3 clean log cycles. The runtime is quiet but the user-visible problem persists — likely a swallowed data-path error. See `.claude/debug-app/unresolved.md` for the chain walk. Suggested next step: <derived from the walk>."

---

Exit the loop. Do NOT auto-resume.

**Iteration cap (applies in both modes):** independent of the clean-cycle counter, the loop exits after **50 total cycles** (≈5 min wall clock on a clean loop, longer when fixes are running). Track `cycle: <N>` at the top of `fixes.md` and increment per cycle. On cap-hit, exit with:

> "⚠ Loop reached the iteration cap (50 cycles). Symptom may be intermittent OR a fix is regressing on every reload. See `.claude/debug-app/fixes.md` for the per-cycle log. Suggested next step: review the last 3 fixes for circular regressions, or re-run with a more specific symptom."

If counter is < 3 AND the cap hasn't tripped, return to Step A on the next monitoring beat. Do not run shell `sleep` or a host-specific wait command; ordinary tool execution provides the cadence and the cursor prevents duplicate reads.

### Step D — If issues ARE found

Reset the consecutive-clean counter to 0. For each issue, work through the sequence below **one at a time** before moving to the next.

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

#### D3. Apply the fix

**For Import / Bundle category errors, jump to D3.1 first** — those have specific recipes that pre-empt the generic routing table below. For everything else (JS Runtime, Network/API, React, etc.), use the routing table:

| Error location / category | Action |
|---|---|
| `app/` screen file, `_layout.tsx`, route segment | Inline edit via `Edit` tool |
| `src/components/` | Inline edit via `Edit` tool |
| `src/hooks/`, `src/services/` | Inline edit via `Edit` tool |
| `src/generated/` | **Do not edit.** Fix the upstream query or schema and run `npm run generate-schemas` |
| Dataverse schema (column/table missing) | **Hand-off:** route user to `/add-dataverse`. Do not auto-edit. Read [skills/add-dataverse/references/dataverse-reference.md](${CLAUDE_SKILL_DIR}/../../skills/add-dataverse/references/dataverse-reference.md) before suggesting changes. |
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

Append to `.claude/debug-app/fixes.md`:
```
[<HH:MM:SS>] <category> — <file>:<line> — <one-line description of fix>
```

#### D3.1 Bundle / transform error fix recipes (Import / Bundle category)

These recipes apply to errors classified as "Import / Bundle" in Step B. They are read from the wrapper's persisted Metro output. Each recipe is opinionated: take the action listed if its precondition matches, otherwise fall through to the next.

| Error pattern | Precondition | Action |
|---|---|---|
| `SyntaxError: <file>:<line>:<col>` in `app/`, `src/components/`, `src/hooks/`, `src/services/` | The cited line is in editable user code (NOT `src/generated/`, NOT `node_modules/`) | `Read` the file around the cited line (±10 lines), identify the syntactic issue (unclosed JSX tag, missing closing brace/paren, stray comma, missing `from` in import, unterminated string, missing semicolon between statements), apply a single minimal `Edit`. Do NOT reformat surrounding code. |
| `SyntaxError` in `src/generated/` | Cited file is under `src/generated/` | **Do not edit.** Schema regen produced bad output. Hand-off: tell the user to re-run `npm run generate-schemas`; if the error reproduces, route to `/add-connector` or `/add-dataverse` to re-add the affected datasource. |
| `Unable to resolve module <name>` from `<importer>` | `<name>` starts with `.` or `..` (relative import) | `Glob` the importer's directory for files matching `<name>` with any extension (`.ts`, `.tsx`, `.js`, `.jsx`, `.json`). If found with a different extension → fix the import to drop the extension OR match the actual one. If found with a typo (Levenshtein ≤ 2) → fix the typo. If not found at all → the file genuinely doesn't exist; surface to user and ask whether to create it or remove the import. |
| `Unable to resolve module <name>` | `<name>` is a bare package (no `.` / `/`) AND not present in `package.json` `dependencies` / `devDependencies` | Tell the user before installing: `> "Bundle requires '<name>' which isn't in package.json. Install it as a runtime dependency? (Y/n)"` On confirm, run `npm install <name>` (or `npm install -D <name>` if it's a known dev-only tool like `@types/*`). Do NOT install without consent — package adds are a supply-chain decision. |
| `Unable to resolve module <name>` | `<name>` IS in `package.json` but the bundle still fails | Likely cache: ask permission to restart through `metro-session.js stop`, then `start --clear --wait-ready-ms 8000`. Never kill an unowned process. |
| `transform failed` referencing a babel plugin (e.g., `[BABEL] ... unknown plugin "react-native-reanimated/plugin"`) | Error references `babel.config.js` | **Hand-off.** `babel.config.js` is project config (same constraint that protects `app.config.js`). Print the cited plugin and suggested fix order (e.g., "`react-native-reanimated/plugin` MUST be the LAST plugin in `babel.config.js` `plugins` array"); skip to next issue. |
| `transform failed` without a babel reference | Generic transform failure (often a TS feature Metro's transformer can't handle) | Read the cited file, look for syntax that requires a specific TS lib (e.g., decorators, top-level await). If the issue is a known-bad pattern, surface and ask before fixing. Otherwise hand-off. |
| `predev` script failure (e.g., `npm run generate-schemas` errored before `expo start` ran) | Bundle output shows the failure happened during the `predev` lifecycle hook | This is not a code edit — `power.config.json` or the connector setup is broken. **Hand-off:** route user to `/add-connector` (for Power Platform connectors) or `/add-dataverse` (for Dataverse). Do NOT edit `power.config.json` directly. |
| `[BABEL] ... You're trying to use the @babel/plugin-X plugin twice` | Duplicate babel plugin entries | **Hand-off** for the same reason as above — `babel.config.js` is project config. Surface the duplicate; let the user dedupe. |

After applying any inline edit (rows 1, 3, 4 above), Metro auto-detects the file save and re-bundles. Skip directly to D4 — do NOT manually trigger a reload. The verify step picks up Metro's `Bundling complete` (or the next error block) automatically.

Append to `.claude/debug-app/fixes.md`:
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

If no cite can be located by step 4: log a structured note to `.claude/debug-app/unresolved.md` (verbatim error + which lookup attempts ran), surface to the user, advance to next issue. **Do not guess at a file.** Best-effort still requires a target.

**Step 2 — Enrich understanding (do not skip).**

- If the error contains a Microsoft-stack token (`AADSTS\d+`, `Dataverse`, `Power Platform`, `MSAL`, `Entra`, `Graph API`): query `mcp__plugin_mobile-app_microsoft-learn__microsoft_docs_search` with the exact code or token. A matching doc usually pins the fix exactly.
- Read the cited file ±15 lines for surrounding context. Note recent imports, the function signature, and any nearby `try/catch` or `useEffect` deps.
- If the error mentions a third-party module (anything in `node_modules/` from the stack), one targeted `WebFetch` against the module's npm page or GitHub README is acceptable; do NOT do open-ended web searches in the loop.

**Step 3 — Form ONE named hypothesis.** Write it to `.claude/debug-app/fixes.md` BEFORE editing, in this format:

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

Append the same block to `.claude/debug-app/unresolved.md`. Clean up any `[INJECTED-TRACE]` logs before exiting (Phase 0.5.5 procedure).

Do NOT attempt a third automated fix for the same error. Wait for user guidance.

---

## Constraints

- **Never fix native config files** (`app.config.js`, `app.plugin.js`, `Podfile`, `build.gradle`, `gradle.properties`) — report the error to the user with the exact line and a suggested manual action.
- **Never modify `src/generated/`** — these files are auto-generated. Fix the upstream query / service / schema instead, then run `npm run generate-schemas`.
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
| Phase 0 reports `not-started` or `stopped` | No wrapper-owned Metro process is running | Start with `node "${PLUGIN_ROOT}/scripts/metro-session.js" start --project-root <working_dir> --wait-ready-ms 8000` |
| Phase 0 reports `stale` | The persisted PID no longer exists, usually after restart/crash | Start a new wrapper session; stale state is retained for diagnosis until start replaces it |
| Phase 0 reports `failed` | Expo/Metro exited during startup or runtime | Run `metro-session.js tail --lines 120`, fix the sanitized error, then start again |
| Phase 0 reports "Metro running but no app connected" | Simulator/device hasn't loaded the app yet | Open the app on the simulator/device, then re-run `/debug-app` |
| Loop appears stuck | Fix taking longer than expected (e.g., type-check on large project) | Wait — log lines should still print as the fix runs. Type `stop` to exit. |
| Loop exits with "iteration cap reached" | Symptom is intermittent OR a fix is regressing on every reload | Inspect the last 3 entries in `fixes.md` for circularity; re-run with a more specific symptom or fix manually |
| Same error keeps recurring after fix | Fast Refresh didn't apply the change, or the fix targeted the wrong file | Verify with `git status`; reload from the native dev-client menu; re-run |
| Same error persists after fix AND `git status` shows the change saved AND type-check is clean | Stale Metro transform cache | With user approval, run wrapper `stop`, then `start --clear --wait-ready-ms 8000`; reload and re-run `/debug-app` |
| Escalation triggered immediately | Error pattern is in a category we hand-off (auth, schema, native) | Take the suggested manual action, then re-run `/debug-app` |
| `.claude/debug-app/fixes.md` not appearing | Phase 0 didn't run / state directory not created | Run `mkdir -p .claude/debug-app` manually, re-run skill |
| "App is running cleanly" but the user still sees the problem | Symptom-driven mode was not used — log polling alone is blind to silent failures | Re-run as `/debug-app "<describe what you see>"` to trigger Phase 0.5 (console.log injection) |
| Phase 0.5 reports `screen=unknown` | Symptom text didn't match any route filename | Re-run with a more specific symptom (`/debug-app "todos screen empty"` not `"data is broken"`), OR navigate to the broken screen first then re-run |
| No `[TRACE` lines after reload | Metro cached the old bundle | With user approval, restart through the wrapper using `--clear`, then reload the app |
| `[INJECTED-TRACE]` lines left in code after session | Cleanup step was skipped | Run `grep -rn 'INJECTED-TRACE' app/ src/hooks/ src/services/` and remove each matching line |

---

## Notes

- **Designed to be re-run** — every invocation is idempotent. `.claude/debug-app/metro-cursor.json` advances past previously seen bytes and resets safely when a new Metro session or rotated log is detected.
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
  | Exit on 3 consecutive clean cycles | yes | yes (gated on symptom resolution when symptom-driven mode is in use) |
  | Specialist agent delegation | yes | replaced with skill routing |
  | Working-dir audit log | no | yes (additional — `.claude/debug-app/fixes.md`, `injected-logs.md`) |
  | MS Learn fallback for unknown errors | no | yes (additional) |
   | Persisted Metro/app log source (bundler errors + Hermes console + HTTP request log) | no | yes — survives host restarts; no MCP fallback |
  | Bundle / transform error fix recipes (D3.1) | no | yes (additional) |
  | Bundle-aware verify (poll Metro for `Bundling complete`) | no | yes (additional) |
  | Best-effort autonomous fix for uncategorized errors (D3.2) | no | yes (additional) |
  | Symptom-driven mode — console.log injection + terminal read + data-path walk | no | yes (additional — catches silent failures invisible to log polling; injects `[INJECTED-TRACE]` logs, reads terminal, cleans up logs after root cause found) |
