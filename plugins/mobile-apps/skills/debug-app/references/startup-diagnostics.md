# Startup and setup diagnostics

Use before runtime monitoring when the user reports an install/startup/QR-opening
problem, `npm run dev` fails before a live log exists, or Metro is live but the
native client cannot connect. Do not run this phase for every healthy runtime
debug session. It diagnoses the selected app, not the entire machine.

## Scope and entry

Use the absolute `workingDir` already selected by `/debug-app`; inherit it in
creation handoffs and reject conflicting roots. A project manifest is sufficient
for startup inspection: missing `node_modules`, Metro config, generated files, or
initialized Power Apps configuration are findings, not reasons to refuse diagnosis.
Do not search neighboring projects or reconstruct an app from scratch.

If an active agent observes a manual `npm run dev` failure outside this skill,
offer **Diagnose startup** / **Stop here** before invoking the potentially
costly workflow. A direct `/debug-app` request already asks for diagnosis and
does not need that entry prompt again. A failure in an unshared terminal cannot
wake an idle agent. Successful creation keeps its optional runtime-debug offer.

`status`, `stop`, help, and version keep their existing early returns.
`--no-fix` may inspect/classify, but cannot install, edit, start/stop/restart Metro,
open an app, or invoke mutating handoffs. Diagnostic state is optional and follows
the existing redaction gate; `status` writes no state.

This phase's explicit repair/restart approval overrides shared prompt defaults:
silence, cancellation, dismissal, a recommendation, or consent to create the app
is not consent to restore dependencies or restart a process. Reuse a current
approval only for its exact operation. Never launch an indefinite watcher.

## S1. Inspect without executing app/package code

Capture the original symptom, command, failing stage, and any previous attempted
repair from the user or calling skill. Available terminal output is useful here
because `predev` can fail before the logger starts. Never require a terminal ID.
If no output is available, ask for a small relevant error excerpt; do not request
the full npm log, `.npmrc`, auth config, or environment-variable dump.

Run the bundled local-only inspector from the selected root:

```bash
node "${PLUGIN_ROOT}/scripts/inspect-startup.js" --working-dir "<working_dir>"
```

It reads JSON metadata and resolves host configuration entry points without
importing them. It performs no network calls, writes, installs, or lifecycle work.
For a specific failed import, inspect that exact package subpath as well:

```bash
node "${PLUGIN_ROOT}/scripts/inspect-startup.js" \
  --working-dir "<working_dir>" --entry-point "<failed-package-or-subpath>"
```

Inspect only relevant findings:

- Actual Node version versus the app's engine/version-manager declarations and
  relevant locked/installed package `engines.node`. This is compatibility
  diagnosis, not a latest-version check. Missing or complex requirements remain
  unverified until checked; never infer compatibility from the installed plugin.
  If Node cannot run the inspector, use the already-observed version/error and
  read the metadata through file tools instead.
- Manifest, effective lockfile, and direct installed versions. `direct-declarations-match`
  is a bounded check, **not proof the full lockfile is valid**; npm remains the
  authority for dependency-graph validation. Inspect mismatches, missing packages,
  other package-manager locks, optional/platform exclusions, workspaces, local/git
  dependencies, and intentionally omitted dev dependencies before proposing a repair.
- `entryPoints`: `unresolved` versus `outside-project-install` versus `resolved`.
  An ancestor/global package must not count as this app's installation.
  Node resolution of config entry points is useful for startup; a React Native
  conditional export may resolve differently in Metro. Do not declare a package
  defective from one Node resolver failure.
- Read the relevant `scripts` in the manifest: distinguish install failure,
  schema-map generation, type-check, Metro startup, native bundle, and device
  opening. Do not execute app config simply to inspect its text.

Existing sanitized logs from a stopped process are historical clues only.
Correlate them with the current reported attempt; do not weaken the runtime
PID/port or supersession checks. Do not tail a dead session as if it were live.

Minimize and redact every persisted diagnostic using
`scripts/redact-debug-diagnostic.js`. Do not persist raw installation output,
registry URLs/credentials, tokens, complete QR URLs, or unrelated home paths.
Store only the stage, category, bounded error code, package names/versions,
checks, approved operation, and verification outcome.

## S2. Classify before proposing a repair

| Category | Evidence and action |
|---|---|
| Broken installation | A declared/locked dependency is missing, corrupted, or installed at a different version; inspect scope and lock consistency, then offer same-lock restoration. A missing export in the correctly installed package is not automatically a broken install. |
| Node/dependency compatibility | Active Node fails the project's relevant engine requirement, or the locked package lacks the used API. Explain the supported requirement and suggest the user's existing Node manager. Do not install/switch Node or change package versions automatically. |
| Install access/network failure | Registry authentication, certificate, proxy, DNS, permissions, or disk-space evidence. Surface the specific prerequisite; do not change registry/security settings, reveal credentials, or repeatedly reinstall. |
| Metro/pre-start failure | Identify the actual failed script/import/configuration. A type-check error is not necessarily a connector problem; a missing logger can be setup/configuration rather than an app runtime failure. Fix app-owned source only within the normal debug boundaries, otherwise return the scoped handoff. |
| Device connectivity / QR opening | Metro is live but the native client cannot reach/open it. Verify the selected PID/port and latest native URL/QR belong to the same session; ask which player/platform and the visible device error. Check user-confirmed LAN/VPN/firewall reachability without disabling protections or switching to a tunnel automatically. Never reinstall solely because a device has not connected. |
| Native compatibility | JavaScript is installed but the running native player/build lacks a required module or supported API. Same-lock restoration cannot add native code to the binary; explain the required supported player/template path. No prebuild/native rebuild from this phase. |
| App defect / potential package defect | First exclude installation, runtime compatibility, configuration, and caller misuse. Use D2's ownership gate before calling a Microsoft package defective. A package stack frame, export-resolution failure, or two failed attempts alone is insufficient proof. |

Do not route ordinary setup failures directly to `/report-issue`.
For a confirmed Microsoft package defect, preserve host/MSAL source: no
`node_modules` edits, patch-package, aliases, vendoring, forks, postinstall
rewrites, or replacement dependency URLs. Hand sanitized evidence to
`/report-issue`; do not automatically submit it.

## S3. Restore the locked installation only with approval

Dependency **upgrades belong to a separate upgrade workflow**, not `/debug-app`.
If a different version is needed, report `upgrade-required` with evidence and
stop that repair path. Suggest an available upgrade skill only when it actually
exists and is ready; otherwise state that no upgrade workflow is available.
Do not silently invoke `/check-updates` as a repair or implement its work here.

For a broken npm install, require the expected npm lockfile, matching manifest
declarations, a compatible active Node/npm toolchain, and no unresolved
manager/workspace/local-dependency ambiguity. Resolve a known runtime mismatch
before offering installation repair; a different Node version is not permission
to regenerate the lock.
If the lock is missing, malformed, inconsistent, or unsupported, return
`blocked` and ask for the intended manifest/lock state. Do not delete/regenerate
the lock or turn to `npm install`, `@latest`, `npm update`, `npm audit fix`,
`expo install --fix`, or guessed peer-dependency bypass flags.

Before mutation, show:

- Why restoring the **same locked versions** addresses the observed failure.
- The exact selected project and command, and that npm replaces its installed
  dependency tree. This is not an upgrade and does not change intended versions.
- Existing lifecycle-script requirements and package-manager flags. Respect
  known project installation flags; do not dump registry/auth configuration.
- Any overlapping edits and whether Metro needs to be stopped first. User-owned
  Metro must be stopped by the user unless a precise, current PID and explicit
  stop approval are supplied. Never kill by process name or reuse a stale PID.

Ask **Restore locked dependencies** / **Inspect only** / **Cancel**. On explicit
approval, record hashes of the manifest and effective lock, then run from that root:

```bash
cd "<working_dir>" || exit 1
npm ci --ignore-scripts --no-audit --no-fund
```

This delegates full lock consistency checking to npm without running dependency
lifecycle scripts. If the app requires install/postinstall setup, identify the
specific required scripts and obtain explicit approval for those before running
them; do not pretend skipping required setup is a complete installation.
Do not execute a script that patches host/MSAL source even with a routine install
approval. If npm rejects the lock/flags or fails, capture the bounded error and
stop; never retry by changing versions or deleting files.

Verify manifest and lock hashes are unchanged, then rerun the local inspection
and the original failed prerequisite. Unexpected changes block completion and
require review; do not silently revert unrelated user work. A clean install
alone is not evidence that startup or the device symptom is fixed.

## S4. Retry startup and verify the original symptom

Offer **Start/restart Metro and verify** / **I'll run it myself** / **Cancel**.
Keep installation approval separate from process control. This is the only
bounded exception to `/debug-app`'s normal no-restart rule; it is not permission
to kill another app's server, clear caches by default, or bypass `predev`.

- Use the canonical `npm run dev` from the same app root so schema and type-check
  hooks still execute. Reuse the approved port options; do not assume 8081.
- If the agent starts it, use a persistent supported background terminal,
  inspect initial output, and verify the new log PID/port identity through
  Phase 0.0. If the host cannot keep a server alive, ask the user to launch it.
- Never use browser runtime tests or direct Metro HTTP probes. Socket/process
  inspection and sanitized local logs remain the allowed evidence.
- Ask the user to retry the original device-opening/QR action. There is no
  device-navigation automation API; do not claim the app opened without evidence.
  Require current native bundle/log evidence and user confirmation for a
  user-visible opening/connectivity symptom.
- Rediscover after restart; do not reuse the dead session's cursor. Preserve
  `--port` / `--platform`; a live unknown-platform session may be used to explain
  startup, but cannot satisfy a platform-filtered runtime selection until known.

At most one locked restore per diagnosis and two evidence-driven startup retries
for the same symptom; include prior caller attempts. Stop on repeated failure,
cancel, or the configured time budget. Do not loop indefinitely waiting for a
device; report verification pending and return control. Runtime monitoring gets
its own normal timeout/cursor only after a live session is selected.

For a caller that only reported a failed startup command, verify that command
and the new live Metro session, return to QR delivery, and label device opening
`not-yet-verified`. Do not block creation waiting for a device that the user has
not attempted to open. A reported QR/opening failure, in contrast, stays pending
until the user retries that action and confirms the result.

## S5. Return an honest outcome

| Outcome | Meaning / next step |
|---|---|
| `verified` | The original failed command/workflow now succeeds with fresh evidence. If this was a manual runtime-debug request and a live app is available, continue the normal Phase 0.2/0.5 monitoring path. |
| `verification-pending` | Local prerequisites or Metro recovered, but the original device symptom is not yet confirmed. Do not report the app fixed or enter a green clean-cycle exit. |
| `blocked` | Missing evidence/approval, incompatible runtime/native support, or failed repair. Return the concrete next step; no package-defect claim without ownership evidence. |
| `cancelled` | Stop without further mutation, process action, or upgrade handoff. Preserve completed work and report its state. |

Return a short structured summary: original symptom/stage, classification,
checks, approved repairs, startup attempts, selected session if any, original
symptom verification, and unresolved next step. In a creation handoff, return
to `/create-mobile-app` instead of starting a long runtime monitor. The parent
can resume QR delivery when startup is verified, while explicitly reporting
device verification pending until the user opens the app.

Optional guidance adoption for older apps is separate from repair: if no
project agent guidance exists, offer it once after diagnosis. Only on approval,
show the small template guidance diff and copy missing instruction files or
propose a merge; preserve all existing customer instruction bytes. Never run
fresh-template preparation on a generated app or use diagnosis as consent to
install the plugin or add a watcher.
