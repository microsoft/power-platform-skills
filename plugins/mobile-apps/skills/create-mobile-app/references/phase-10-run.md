# Phase 10 of 10 — Launch

**Steps:** 12–13. **Previous:** [9 — Implementation](phase-09-build.md). **Next:** Complete; iterate with `/edit-app`, deploy only when explicitly requested.
[Phase index](../SKILL.md#load-only-the-active-phase). Report completion only after this phase's exit condition passes.

### Step 12 — Start dev server (Metro writes project-local logs)

**Telemetry checkpoint: `launch_metro_dev_server`**

**Print before starting:**
> "→ [Step 12/13] Launching Metro so you can scan the QR; logs will be written under .powernative/."

Launch the template's canonical `npm run dev` command. Keep `dev` as `expo start`;
its `predev` lifecycle supplies the combined final schema/TypeScript gate:
`npm run generate-schemas && npm run type-check`. Do not run a separate final schema/type
command immediately before this lifecycle and duplicate its work. Earlier scoped scaffold,
generated-services, navigation/skeleton and screen-wave gates remain required.

The synced template declares `@microsoft/power-apps-native-host` as `^0.4.0`; leave it unchanged.
Its `createPowerAppsMetroConfig` factory in `metro.config.js` installs sanitized project-local
logging internally. No app-side logger wrapper or process manager is needed.

- Logs live under `<working_dir>/.powernative/metro-logs/` as
  `metro-<timestamp>-pid-<pid>-port-<port>.log`: ANSI-free Metro output and HTTP bundle failures,
  with sensitive lines removed before persistence.
- `.powernative/` is gitignored. Never persist raw terminal output or copy runtime logs into
  `memory-bank.md` or source control.
- Expo can select a different free port. Discover the actual native Metro URL and port from
  this launch and its current log, never assume 8081 or reuse a stale session.
- Hot-reload works on file edits; screen tweaks do not need a Metro restart.

**Launch command:**

```bash
cd "<working_dir>"
npm run dev
```

`npm run dev` runs `predev` first; npm does not launch `expo start` when either gate fails.
Capture the full failing gate output once, batch-fix by root cause, then rerun `npm run dev`.
On a failed gate, do not start Metro through another command or bypass `predev`.
Continue only when the combined gate passes after all repairs and Expo prints its Metro URL.
This does not compile native binaries or deploy to the tenant.

Use the host's actual persistent async/background terminal mode for this long-running server,
with detach if supported/required so it survives the agent turn. Use available flags, not invented
`run_in_background` parameters. A terminal handle may be an optional convenience for reading
this launch's output, but do not persist or depend on the terminal ID for resumed work or diagnosis.
`/debug-app` discovers sanitized project-local logs, regardless of who started Metro.

Read the initial terminal output and locate the generated log directly:

```bash
ls -t "<working_dir>/.powernative/metro-logs"/metro-*-pid-*-port-*.log 2>/dev/null | head -1
```

| State | Action |
|---|---|
| A current log exists and Expo printed a native Metro URL | Continue with QR handling; report the discovered port. |
| No log exists yet or startup is progressing | Allow one bounded further read for Expo's `Waiting on ...` line and check the log directory once more. If still absent, surface the terminal output and record a block without guessing a URL. |
| Only a stale log exists, or the launch exits without readiness | Do not diagnose from that log or claim Metro is running. Surface the failure; ask the user to stop stale Metro processes and rerun `npm run dev` when applicable. |

Never claim running from the launch call alone. Do not probe localhost/Metro HTTP, request
bundle URLs, or open web runtime targets to verify readiness.

**When Expo prints the native Metro URL:** generate and present a QR PNG so the user
always receives a scannable code even when Metro runs in a background terminal or the host
does not expose terminal rendering. Do not rely on Expo's terminal-rendered QR as the only presentation path.

1. Define `METRO_QR="<working_dir>/.expo/metro-qr.png"` and run
   `npx --yes qrcode -o "$METRO_QR" "<metro-url>"`.
   If the project's npm config requires auth and the fetch fails with `E401`, retry once with
   `npm_config_registry=https://registry.npmjs.org/ npm_config_always_auth=false` prefixed.
2. Verify the PNG with a host-neutral Node check:
   `node -e "const fs=require('node:fs'); process.exit(fs.existsSync(process.argv[1]) ? 0 : 1)" "$METRO_QR"`.
   If it fails, print the qrcode error and continue without the image; do not claim it was generated.
3. **Chat-first render (best effort):** base64-encode the file with
   `node -e "process.stdout.write(require('node:fs').readFileSync(process.argv[1]).toString('base64'))" "$METRO_QR"`
   and embed it as `![QR](data:image/png;base64,<data>)` when inline image markdown is supported.
4. **Visible fallback:** if inline rendering is unavailable, use the host's file-open tool when
   present. Otherwise use `open "$METRO_QR"` on macOS, `xdg-open "$METRO_QR"` on Linux, or
   `cmd /c start "" "$METRO_QR"` on Windows. If opening fails or the user's visual-companion
   preference disallows opening, print the quoted path. Never interpolate an unquoted project path.
5. Surface only the actual native Metro URL immediately after the image/fallback message:

   > "✓ Metro is running on port `<port>`.
   > 📱 Scan the QR code with your native dev client to load the app. Metro URL: `<metro-url>`
   > 🔄 Edits hot-reload automatically. Debug logs: `<working_dir>/.powernative/metro-logs/`."

Update only the existing stable Metro fields in the memory bank:
- `Metro logs`: `.powernative/metro-logs/`
- `Metro launch command`: `npm run dev`

Do not persist terminal IDs, PIDs, ports, start times, or Metro URLs to the memory bank,
including values extracted from log filenames. Discover the current session from project-local
logs when needed. Leave the persistent server running for local iteration.

After Step 12 starts the long-running server, continue through the optional Step 12.5 debug handoff and print the Step 13 summary.
Production build and tenant push remain a separate, explicit user action via `/deploy`.

### Step 12.5 — Optional debug handoff

Do not perform screen-by-screen runtime verification, route crawling, browser tests,
React Native Web setup, bundle URL requests, or direct Metro/localhost HTTP probes.

After Metro is running and the QR has been presented, offer once:

> "If the app shows an error or a workflow looks wrong after you load it in the native dev client,
> tell me the symptom and I can run `/debug-app "<symptom>"` using the project-local Metro log."

Only invoke `/debug-app` if the user asks for debugging or gives a concrete symptom.
Pass the project working directory and symptom, not terminal context.
Its primary diagnostic source is `.powernative/metro-logs/`.
If the user gives no symptom, proceed directly to Step 13.

### Step 13 — Summary

Report verified app name/project/environment, actual table/capability/connector/screen counts,
combined final gate/route/changed-file validation results and the running Metro/QR status.
Surface unresolved concerns, auth deferral, sample-data and offline-profile status accurately.
Never say the app signed in, synced offline or completed runtime workflows based on a static preview.
Record the validated phase completion and any remaining decisions in the memory bank without
copying ephemeral Metro details. Never expose the Application Insights connection string.

If the requirements mentioned app telemetry or Application Insights, carry that request into
the post-creation `/setup-app-insights` handoff below. Do not configure Application Insights
during creation; invoke the setup skill only after creation and the user's explicit handoff choice.

Print a compact status block using only verified values:

```text
✅ Native code app created
App name      : <displayName>
Project       : <working_dir>
Environment   : <env name> (<env id>)
Data model    : <N tables — M reuse, K extend, L create>
Native caps   : <list>
Connectors    : <list>
Screens       : <N total — M from template, K built>
App Insights  : <enabled for selected customer-owned resource | disabled>
Checks        : <combined final gate, routes, changed-file validation>
Auth / data   : <auth deferral, sample-data and offline-profile status>
Dev server    : Metro running on port <port>
QR            : <verified presentation or generation/opening failure>
Debug logs    : .powernative/metro-logs/
```

List any prerequisite warnings or unresolved concerns in one line each under the block.
Then present exactly these six options, without explanatory paragraphs or a recommendation:

```text
What now?

1. Preview screens in browser  (/preview-screens)
2. Deploy to tenant            (/deploy)
3. Edit the app                (/edit-app)
4. Add more capabilities       (/add-dataverse, /add-connector, /add-native)
5. Configure auth later        (/set-app-registration-native)
6. Set up Application Insights (/setup-app-insights)

Which option? (or "none — I'll keep iterating locally")
```

Wait for a choice; no automatic production build, tenant push, or alternative launch commands.
If no further choice is given, return with Metro running and the bank/checkpoints up to date.
