# Prototype Runtime Supervisor

The creation workflow starts two independent tracks at Step 1.

## Track A - deterministic runtime

1. Materialize the bundled template only when the target is empty.
2. Install from committed locks through `install-dependencies.js`.
3. Atomically write `brand/tokens.ts`, `src/generated/buildProgress.ts`, and
   `app/building.tsx`; temporarily route `/` to `/building`.
4. Start the project-local Expo CLI detached and persist its PID/log under
   `.mobile-build/`.
5. Keep Metro alive while Track B plans and writes. Metro failure records a
   concern and degrades to text-only; it never aborts Track B.

Every watched file is written to a sibling temporary file and renamed. Progress
writes are separated by at least 500 ms so Metro sees one coherent refresh.
Screen skeleton state is written before content state.

## Track B - model work

Track B captures the brief, plans data/screens, runs generators, creates shared
components, builds screens, and repairs validation findings. It never starts a
second dev server.

Before `configure-prototype-runtime.js`, run `prepare-runtime` to restore the
template index and configure the prototype entry as `/building`. After the real
initial screen reaches `built`, run `release --route <approved-route>`.

## Commands

```bash
node runtime/supervisor.js start <project> [--port 8081]
node runtime/supervisor.js prepare-runtime <project>
node runtime/supervisor.js plan <project> --plan <native-app-plan.md>
node runtime/supervisor.js screen <project> --id <id> --state <queued|building|written|checked|built|failed>
node runtime/supervisor.js release <project> --route </(app)/home>
node runtime/supervisor.js status <project>
```