# Phase 9 of 10 — Implementation

**Steps:** 11–11.4. **Previous:** [8 — Screen shell](phase-08-screens.md). **Next:** [10 — Launch](phase-10-run.md).
[Phase index](../SKILL.md#load-only-the-active-phase). Advance only after this phase's exit condition passes.

### Step 11 — Build screens (parallel)

**Telemetry checkpoint: `build_and_validate_screens`**

Use real `mobile-app:screen-builder` dispatches, never a no-op probe or fake preflight screen.
Build mode is not a user question. The root availability rule applies to the current dispatch:
if the host cannot route it, foreground reads the same builder contract and implements that
screen with identical quality checks. Screen count/time pressure is never an availability failure
or reason to replace the workflow with a weaker inline shortcut.

Build only approved Screen Map routes; record/status/role variants and local overlays do not
become extra builder targets. Necessary graph additions return to Gate 4a before building them.
Foreground owns all fan-out; children never spawn more agents. Cap concurrent builders at 5,
using a single parallel batch per wave. Build all planned app-specific screens, including assigned
starter routes that need replacement; leave unrelated template Login/OAuth/runtime screens alone.

Each prompt:

```text
working_dir: <absolute working_dir>
screen_name: <Screen Map name>
route: <approved route>
target_file: <working_dir>/<exact File column>
plan_path: <working_dir>/native-app-plan.md
skeleton_exists: <actual true|false>
screen_spec: <this screen's approved compact spec, when available inline>
service_signatures: <only actual generated methods/types this screen consumes>
token_context: <relevant brand/token roles and negatives>
journey_context: <relevant Primary journeys row and action/outcome/recovery>
Scope: assigned screen only; shared/layout changes return NEEDS_CONTEXT to foreground.
Read your compact screen spec, shared conventions, actual Generated Services snapshot, relevant
brand direction/negatives and existing target. Samples are API/import references, not layouts.
Preserve resolved imports/hooks unless actual types require a focused correction.
Implement approved workflow, visible states, cancellation and truthful outcomes; no fake services.
No nested agents or user questions. Return literal DONE / DONE_WITH_CONCERNS: /
NEEDS_CONTEXT: / BLOCKED: first line, then result and changed-file paths.
```

These optional compact fields are prompt context, not new sidecars or competing plan authority.
When supplied, the builder reads only unresolved relevant plan/reference sections rather than
reloading the full plan or service tree; signatures still come from actual Step 10.7 output.

Reject missing File columns/path escapes before dispatch; do not flatten folder structure.
Apply the root status handler to every result and verify artifacts, not just the status string.
Print actual `[K/N] screen — status` progress and a wave summary after results arrive.
Do not invent percentage/timing updates while a blocking host call is running.

`NEEDS_CONTEXT` gets at most two clarified retries per screen. A `BLOCKED` stops advancement;
foreground can resolve it or capture a revised reduced scope, then reapprove affected plan/routes.
Never silently continue with a placeholder screen. Concerns are consolidated once per wave and
recorded, but missing approved services/native features remain blockers.

## Screen-wave and route gates

After **each** wave:

```bash
npx tsc --noEmit
```

Capture errors once, classify service/model names, service option shape, UI props, typed percent
values, create/update payloads or stale imports; batch-repair. Redispatch screen-owned corrections
to affected builders and keep shared fixes in foreground. At most two retries per screen.
Do not launch wave N+1 until wave N passes.

After all waves, typecheck the complete app and run:

```bash
node "${PLUGIN_ROOT}/scripts/check-routes.js"
```

TypeScript cannot replace route checking. Repair duplicate normalized routes, dynamic file/folder
collisions and sender/destination parameter drift; rerun once and block if findings remain.

If the user has chosen a run-level `tsc_error_policy` in the bank, honor `patch_continue` or
`stop_for_review` for repeated error classes. Ask through the foreground interface when that
choice is needed; never treat a canceled question as consent. Reset only on user request or edit-app.
The policy changes repair handling, never the requirement for a clean gate.

### Step 11.4 — Stylistic fix sweep (parallel)

**Telemetry checkpoint: `validate_screen_design_quality`**

Scope: exact generated/changed screen files and referenced changed local UI components, not
generated services, node_modules, samples or unrelated routes. Review layout/provider inset
ownership separately; these pattern scanners may exclude layouts and configuration. Run:

```bash
node "${PLUGIN_ROOT}/hooks/validate-screen-quality.js" --report --strict <exact-screen-and-component-files>
node "${PLUGIN_ROOT}/hooks/validate-color-contrast.js" --report --strict <exact-screen-and-component-files>
```

Read coverage, errors, skipped reasons and JSON issues; a missing/empty scan is not a pass.
Merge issues by file/rule; use current content, not stale line numbers.
These source-pattern heuristics do not measure every rendered contrast pair or certify visual quality.
Batch deterministic fixes per file (contrast/token pairs, labels/roles, targets, safe-area edges,
font scaling); preserve the canonical Tamagui vs raw React Native accessibility props.
For judgment calls (structure, brand intent, redundant status cues), review rather than churn.
Recheck touched files; cap at two retries per file/validator.
These are explicit validators, never global plugin write hooks.

Run `npx tsc --noEmit` after repairs. Record remaining nonblocking visual judgments as
`DONE_WITH_CONCERNS`; never downgrade a required compile/route/mobile-validator failure.
Run mandatory `validate-mobile-files.js` on every exact changed file before success.
For changed typography, retain the canonical final-config `assertNativeFontDefaults` and
complete role props from Step 9b. Its presence is not an executed test: distinguish helper
regressions/type checks from observing this app's assertion at load. Unsupported/unobserved
font configurations remain typography-unverified, and native font availability needs device evidence.

## Minimum product UX review

Before advancing, review each primary journey and top-level entry against the existing
[screen contract](${PLUGIN_ROOT}/shared/references/screen-planning/spec-contract.md#domain-rules-and-first-use-review).
Use the actual source/handler/route evidence, not only an approved sketch:

- Confirm independent states, actor permissions, transition preconditions, affected records
  and observable outcomes agree with the approved rules.
- Verify useful first entry, initial scope/filter, filter-empty recovery, exact-record
  scan/deep-link entry and preserved return context. Never route a tab to a fixed sample ID.
- Check the primary operation is wired with visible pending/error/retry behavior and honest
  persistence. Compilation and the presence of handlers alone do not establish task completion.

Repair implementation mismatches before launch. Missing outcome-changing rules return to the
foreground's owning approval gate; cosmetic choices remain advisory. Record what was inspected
and any unexecuted behavior honestly. Source review or an HTML simulation is not native/device
verification, and must not be reported as one.

## Full-screen presentation handoff

After clean gates, follow [native presentation handoff](${PLUGIN_ROOT}/shared/references/native-visual-review.md).
Use `/preview-screens --mode implementation` for complete affected screens and the primary
journey, not only a component gallery. It reads built TSX/config/local components and writes
`preview.html`; do not substitute `_design_preview.html` or improve the HTML to hide source drift.
Record/check its source provenance and inspect typography, media resolution, repeated-item
alignment, header/Back, tabs/footer and primary action placement at matching usable viewports.
The accepted design is the minimum baseline, not a promise tied to a particular model.

Honor explicit preview opt-out and `visual_companion` (which controls opening). Unavailable
rendered evidence or component-only scope must remain `DONE_WITH_CONCERNS` / unverified, not a
visual pass. Keep static, rendered-approximation and native-device results separate. Continue
to launch only after structural gates pass and remaining concerns are surfaced; never imply
native verification from HTML or idle Metro output.
