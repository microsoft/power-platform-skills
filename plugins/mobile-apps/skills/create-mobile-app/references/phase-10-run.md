# Phase 10 of 10 — Launch

**Steps:** 12–13. **Previous:** [9 — Implementation](phase-09-build.md). **Next:** Complete; iterate with `/edit-app`, deploy only when explicitly requested.
[Phase index](../SKILL.md#load-only-the-active-phase). Report completion only after this phase's exit condition passes.

### Step 12 — Start dev server (background)

**Telemetry checkpoint: `launch_metro_dev_server`**

From `<working_dir>`, run synchronously and check both exits:

```bash
npm run generate-schemas
npx tsc --noEmit
```

The final gate must be clean after all repairs. Batch-fix failures and rerun; do not start Metro
from broken schema/types. This does not compile native binaries or deploy to the tenant.

Start `npx expo start` in the host's actual persistent async/background terminal mode, with detach
if supported/required by that host. Capture the returned shell/terminal ID as `METRO_TERMINAL_ID`.
Use the actual available flags, not invented `run_in_background` parameters.
Do not use `npm run dev` here: its predev schema generation would repeat the final gate's work.

Read the captured terminal output and verify Metro is alive/ready (`Metro waiting on` / `› Metro:`).
Allow a bounded second read if startup is still progressing; surface startup errors and record a
block if it exits or readiness cannot be verified. Never claim running from the launch call alone.
Do not probe localhost/Metro HTTP or open web runtime targets to verify it.

Extract the actual native dev-client URL from the terminal, not a guessed host/port.
Present the terminal QR and URL. If the host can display images and a QR generator is available,
create project-local `.expo/metro-qr.png`, verify it exists, and show/open it; otherwise retain the
actual terminal QR as the fallback. Do not claim an image was generated or install tooling silently.
Honor browser/visual-companion preferences when opening any image.

Persist actual terminal ID, start time, launch command and native URL in memory bank for
`/edit-app` or requested diagnosis. Leave the persistent server running for local iteration.

### Step 12.5 — Optional debug handoff

Offer: after loading in the native dev client, provide a concrete symptom for `/debug-app`.
Invoke it only on a user request/symptom and pass the captured Metro terminal context.
No screen-by-screen runtime crawl, React Native Web setup, bundle URL requests or HTTP probes.

### Step 13 — Summary

Report verified app name/project/environment, actual table/capability/connector/screen counts,
TypeScript/route/validation results and the running terminal/QR. Surface unresolved concerns,
auth deferral, sample-data and offline-profile status accurately.
Never say the app signed in, synced offline or completed runtime workflows based on a static preview.

Offer `/preview-screens`, `/deploy`, `/edit-app`, `/add-*`, and `/set-app-registration-native`
when applicable. Wait for a choice; no automatic production build or tenant push.
If no further choice is given, finish with Metro running and the bank/checkpoints up to date.
