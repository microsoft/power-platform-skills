# Screen Generation and Launch

### Step 11 — Build screens (parallel return, deterministic writes)

**Build mode is NEVER a user-facing question.** Do not ask about parallel or
sequential execution. Resolve `parallel-return` or `foreground-return` through
the shared host/runtime/plugin-version cache in
[`return-only-agents.md`](return-only-agents.md).

**Quality rule — screen count/time is NOT a mode trigger.** Use the same sealed
one-screen work orders, semantic rules, and validators at every scale.
`parallel-return` dispatches independent builder reasoning concurrently;
`foreground-return` processes those work orders sequentially. Neither mode may
reduce screen count, context, or quality.

#### 11.0 — Host capability cache

Do not spawn a no-op preflight agent and do not use `memory-bank.md` as the mode
cache. Read `.tmp/agent-execution-mode.json` through
`scripts/agent-return-runtime.js`. On a cache miss, the first real sealed screen
work order is the capability check. Only custom-agent routing failure selects
`foreground-return`; child response status never changes host mode.

Resolve `BUILDER_CONCURRENCY` as documented below and print:

> "→ [Step 11/13] Building <N> screens in <W> wave(s) of up to
> <BUILDER_CONCURRENCY> concurrent. Wave 1/<W> starting: <screen names>."

Read the Screen Map, compiled build pack, and per-screen specs in the
foreground. Build and seal one work order per screen. Each work order contains
inline only the assigned screen's:

- exact `screen:<screen-id>` artifact ID and allowlisted absolute target path;
- build-pack entry and compact spec;
- Product Experience fields used by the screen;
- design tokens and required signature components;
- complete typed skeleton/import content;
- exact generated-service signatures used by the screen;
- route and parameter contract;
- fixtures and required states;
- selected archetype shard and code idioms;
- validator findings for a repair attempt;
- attempt number and foreground-generated fingerprint.

Never supply only a plan, pack, service, skeleton, or target-file path and tell
the child to read it. In `parallel-return`, dispatch up to the configured wave
cap as `mobile-app:screen-builder`; in `foreground-return`, process the same
sealed work orders sequentially. Capture each exact JSON response without
writing its TSX target.

**Target resolution (HARD):** use the **File** column from the validated Screen
Map and prefix it with `<working_dir>/`. The path may be nested. Never derive a
flat path from the screen name. If the File value is absent, target-repair the
screen-planner graph work order; do not dispatch a builder or invent a path.

Resolve the wave cap once:

```bash
BUILDER_CONCURRENCY="<--builder-concurrency value, or ${MOBILE_APP_BUILDER_CONCURRENCY:-8}>"
node -e '
  const value = Number(process.argv[1]);
  if (!Number.isInteger(value) || value < 1 || value > 10) process.exit(2);
' "$BUILDER_CONCURRENCY" || {
  echo "Builder concurrency must be an integer from 1 to 10"; exit 2;
}
```

The default is 8 because the builder read set is budgeted below 40 KB. Batch
larger screen sets into waves of `$BUILDER_CONCURRENCY`; never exceed 10.

**Progress streaming — print one line per validated envelope, then a wave
summary.** Iterate results in deterministic work-order order. Format:

```
  ✓ [3/8] HomeScreen — ready
  ✓ [4/8] ListScreen — ready_with_concerns (1 connector stub)
  ✓ [5/8] DetailScreen — ready
─── Wave 1/2 complete (5/8 screens built; 0 blocked, 1 with concerns) ───
```

Use `✓` for `ready`/`ready_with_concerns`, `↻` for `needs_context` or
targeted repair, and `✗` for substantive `blocked`. Always print `[K/N]`.

After the wave's TypeScript gate passes, and only then, print the next wave start line (if any):
> "Wave 2/<W> starting: <names>."

After each wave returns, parse every response with
`scripts/agent-return-envelope.js`. Validate role, schema, sealed fingerprint,
artifact identity, exact allowlisted path, complete content, and the full wave's
unique target paths before any final write.

- `ready` proceeds to staged validation.
- `ready_with_concerns` proceeds and contributes to one foreground concern list.
- `needs_context` adds only the exact missing fact to that screen's work order,
  reseals it, and redispatches once.
- `needs_clarification` persists foreground waiting state and asks only the
  returned product question.
- substantive `blocked` follows the existing user-facing stop policy.
- invalid or truncated JSON retries the byte-identical work order once.

Keep valid sibling responses unchanged while repairing one failed response. Do
not regenerate successful sibling screens.

Create a foreground validation plan that runs
`validate-mobile-files.js --file {{artifact:screen:<id>}}` for every staged TSX
artifact. Only after the complete response set has no duplicate target and all
staged validators pass may the common materializer atomically rename files in
deterministic target-path order. Builders never write concurrently.

The exact materialization order is ascending target-path string order by
Unicode code unit (`left < right`), with artifact ID as the tie-breaker. It does
not use locale-aware comparison, response order, completion order, or Screen Map
order. This produces the same write order across hosts and execution modes.

After handling every builder status in the wave, run the **Screen-wave gate** before launching the next wave:

```bash
npx tsc --noEmit
```

If the wave gate fails, capture the full error list once, group failures by root
cause, and repair only affected screen work orders. Include exact findings,
increment the attempt, reseal, and redispatch affected builders concurrently in
`parallel-return` or sequentially in `foreground-return`. Cap repair at two
attempts per screen. Preserve successful siblings and do not launch the next
wave until the current gate is clean.

Common wave-gate repair classes to batch instead of fixing line-by-line:
- Generated service/model names: singular vs plural generated names, stale aliases after Dataverse rename.
- Service option shapes: `orderBy` must match the generated type, usually `string[]`.
- UI prop mismatches: invalid Tamagui shorthand props on components that do not support them.
- React Native style types: percent widths must use a typed percentage or shared `ProgressBar` helper.
- Dataverse create/update payload typing: prefer typed helper wrappers; if generated base types require server-owned fields, isolate any `as any` at the helper boundary, not throughout screen JSX.
- Stale connector TODOs: remove `TODO(connector-not-yet-added)` when the service exists in the Generated Services snapshot.

**After all waves return and the last wave gate is clean**, run one final `npx tsc --noEmit` before Step 12 to catch cross-screen issues that only appear when all screens exist. If it fails, use the same consolidated batch-repair flow.

Then run the canonical route-contract gate from the app root:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
```

This gate is required even when TypeScript passes. It detects duplicate normalized routes, `[id].tsx` plus `[id]/<child>.tsx` file/folder collisions, and sender/destination parameter drift. If it fails, repair the affected route files or re-spawn their screen builders with the consolidated findings, then rerun once. Do not continue to Step 11.4 or start Metro while route findings remain.

**Sticky tsc/build error policy (run-level).** The first time a `tsc` or `npm run build` failure surfaces in this run, ask the user once:

> "tsc found <N> error(s) in <files>. Patch + continue, or stop and let me investigate?"

Record the answer in `memory-bank.md` under `## Policies` as `tsc_error_policy: patch_continue` or `tsc_error_policy: stop_for_review`. **For every subsequent tsc/build error of the same class in the same run** (e.g., another screen failing typecheck after a builder retry, the cross-screen `tsc` after Step 11.4 fixes), apply the recorded policy automatically:

- `patch_continue` → update and reseal only the matching screen work order with
  the error appended, then process it through the active return mode, respecting
  the 2-repair cap. Do not re-prompt the user.
- `stop_for_review` → STOP and surface the new error.

Reset the policy only if the user explicitly says "ask me again" or `/edit-app` is invoked. This avoids the same class of question being asked 3–5 times per run while still letting the user override at any point.

This sticky policy controls **how to handle a failed gate**, not whether the gate is required. Even with `patch_continue`, every required TypeScript gate must end clean before the flow advances.

### Step 11.4 — Stylistic fix sweep (parallel)

Run one controlled stylistic debt sweep after all screen-builder waves and TypeScript gates are clean, before preview or dev-server launch. This keeps screen-builder retries focused on critical compile/data/route issues, then fixes visual and accessibility quality across the full screen set in batches.

**Print before starting:**
> "→ [Step 11.4/13] Running stylistic validators in batch + auto-fixing contrast / accessibility / token issues across all screens (~2-3 min)"

**Scope:** generated screen files only: every file from the Screen Map plus any `app/(app)/**/*.tsx` screen written by Step 10.8/Step 11. Exclude layout files unless the reported issue is clearly inside generated screen chrome for that route group. Do not scan `src/generated/`, `brand/`, `node_modules/`, `.expo/`, or sample files.

**Available validators in v0:**

```bash
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-quality.js" --report <screen-files-or-app-dir>
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report <screen-files-or-app-dir>
```

`validate-screen-quality` includes accessibility-label/role, safe-area, touch-target, raw-hex, token, empty-state, shadow, and status-visual checks. If future stylistic hooks exist (for example `validate-accessibility-labels.js`), include them here only if they support `--report` and emit the same JSON issue shape.

For each available stylistic validator:

1. Run in `--report` mode against all generated screens. Report mode is non-blocking; it emits JSON issues with `file`, `line`, `rule`, `match`, `fix`, and `autoFixable`.
2. Merge issues by file and rule. Keep exact line numbers for user/debug output, but do not rely on stale line numbers after the first edit in a file.
3. Split findings into deterministic auto-fixes and judgement calls:
  - **Auto-fixable:** weak foreground tokens, white-on-yellow/orange status pairs, missing icon-only `aria-label`, missing tappable `role`, tiny icon button `hitSlop`, obvious raw hex/token substitutions, top-only safe area with bottom UI, `allowFontScaling={false}`. Apply these web-standard accessibility props to Tamagui 2 components; raw React Native components retain their React Native accessibility props.
  - **Needs review:** complex safe-area restructuring, dominant red detail headers, redundant status cue design, ambiguous brand colors, empty-state restructuring that requires moving JSX across large blocks.
4. Build one file-level edit batch per affected file. Apply independent files in
  deterministic target-path order. Do not run one edit per issue when multiple
  issues are in the same file; that reintroduces slow per-write loops and
  line-number drift.
5. Re-run the same validator in `--report` mode for the touched files. Cap retries at 2 per file per validator.

These validators are invoked explicitly by this mobile workflow. They are not registered as plugin-wide hooks because that would run them during unrelated Canvas Apps and other plugin operations.

After all validators report no auto-fixable issues, run:

```bash
npx tsc --noEmit
```

If `tsc` fails, use the existing TypeScript batch-repair policy. If stylistic issues remain after 2 retries or are judgement calls, do not keep looping. Record them in `memory-bank.md` and surface them as:

Record one foreground concern: `Step 11.4 left <N> stylistic issue(s) for
review: <file:line rule summary>`.

Then continue only if TypeScript is clean. Step 11.4 may leave concerns, but it may not leave the app in a broken TypeScript state.

Record the validated screen checkpoint:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-pipeline-state.js" \
  --project-root "<working_dir>" --record --step "11.4" \
  --artifact-tree "routes=app" \
  --artifact-tree "source=src"
```

#### Static preview boundary

Do not offer or invoke `/preview-screens` during the create flow. The Gate 3
`_plan_preview.html` containing the three representative experience screens is
the only HTML preview. After `tsc` passes, proceed directly to Step 12.

---

### Step 12 — Start dev server (background)

**Print before starting:**
> "→ [Step 12/13] Launching Metro dev server in the background so you can scan the QR."

This skill **launches** Metro in an async/background terminal so:

1. The QR code prints in the terminal — the user can scan with their dev client immediately.
2. Hot-reload works on file edits — no restart needed for screen tweaks.
3. **The agent owns the terminal** — when the user says "the screen is blank" / "data isn't showing" / "it crashed", the agent can read Metro's `console.log`, BUNDLE errors, and red-box stack traces directly via `BashOutput` (or its equivalent terminal-output tool) without asking the user to copy-paste.

**Launch commands:**

```bash
cd <working_dir>
npm run generate-schemas    # refresh schema map for any data sources added since last run (idempotent)
npx tsc --noEmit            # final gate — dev server starts only from a clean TypeScript state
```

Run the schema regen and final `tsc` synchronously and check both exits. If either fails, do not launch Metro. Capture the full output once, batch-fix by root cause, rerun the final gate, and continue only when clean. Then launch Metro async:

```bash
# Async / background — DO NOT block on this. Capture the terminal id.
npx expo start
```

Use `npx expo start` here instead of `npm run dev` because the orchestrator has already run `npm run generate-schemas` for the final gate. The template keeps `predev: npm run generate-schemas` as a safety net for humans running `npm run dev` manually, but the orchestrated path should not regenerate schemas twice.

When invoking the Bash tool: set `run_in_background: true` (or the equivalent async flag in your tool surface). Capture the returned terminal/shell id as `$METRO_TERMINAL_ID`.

**After launch, wait ≤8s for the "Metro waiting on" line, then:**

1. Read the terminal output once (`BashOutput` with the captured id).
2. **Extract the native Metro URL** from the terminal output:
   - Locate the line beginning `› Metro:` — it has the form `exp+<scheme>://expo-development-client/?url=<encoded-http-url>`. Capture the full Metro URL.
3. **Generate QR code PNG and present it to the user** (chat-first, deterministic fallback):
  - Run `npx --yes qrcode -o <working_dir>/.expo/metro-qr.png "<metro-url>"` to generate the PNG. If the project's npm config requires auth and the fetch fails with `E401`, retry once with `npm_config_registry=https://registry.npmjs.org/ npm_config_always_auth=false` prefixed.
  - Verify the PNG was created: `test -f <working_dir>/.expo/metro-qr.png` (exit code 0 = success). If it fails, print the qrcode error and continue to step 4.
  - **Chat-first render (best effort):** read and base64-encode the file (`base64 <working_dir>/.expo/metro-qr.png`) and embed in markdown as a data URI (`![QR](data:image/png;base64,<data>)`) so hosts that support inline image markdown show the QR directly in chat.
  - **Guaranteed visible fallback:** if inline chat image rendering is unavailable in the host UI, open the PNG directly in the default system image viewer/browser (`open <working_dir>/.expo/metro-qr.png` on macOS, `xdg-open ...` on Linux, `start "" ...` on Windows). This fallback is required whenever chat image rendering is unavailable.
  - Surface only the native Metro URL immediately after the image/fallback message.
4. **Optional: ASCII terminal QR for power users.** Extract and print the terminal's ASCII QR banner as a secondary/backup option:
   - Locate the first line composed of unicode block glyphs (`▀ ▄ █`) — that is the top of the QR.
  - Print every line from that line through the `› Metro:` line.
   - Cap at 30 lines as a safety net. Print as-is inside a fenced code block so terminal renderers preserve glyph alignment.
  - If the ASCII QR banner is not yet in the output, re-read `BashOutput` once more after another 4s before giving up. If still absent, skip the ASCII QR — PNG delivery from step 3 is the primary path.
5. Follow with:

   > "✓ Metro is running in background terminal `<id>`.
  > 📱 Scan the QR code shown above (or opened from `<working_dir>/.expo/metro-qr.png`) with your native dev client to load the app. Metro URL: `<metro-url>`
  > 🔄 Edits hot-reload automatically."

**Persist the terminal id to memory bank** so resumed sessions and downstream skills (`/preview-screens`, `/edit-app`, `/add-*`) can find it:

```markdown
## Project facts
...
- Metro terminal id: <id> (started <ISO date>)
- Metro launch cmd: cd <working_dir> && npx expo start
```

This skill stops after Step 12 so the user can iterate locally. Production build + tenant push is a separate, explicit user action via the `/deploy` skill.

### Step 12.5 — Optional debug handoff

Do not perform screen-by-screen runtime verification. Do not crawl routes, open browser targets, use React Native Web, or call Metro HTTP endpoints directly.

After Metro is running and the QR has been presented, offer a single optional debug handoff:

> "If the app shows an error or a workflow looks wrong after you load it in the native dev client, tell me the symptom and I can run `/debug-app "<symptom>"` using the Metro terminal logs."

Only invoke `/debug-app` if the user asks for debugging or gives a concrete symptom. `/debug-app` must use the captured Metro terminal output as its diagnostic source; it must not probe `localhost`, request a bundle URL, or run any React Native Web setup. If the user gives no symptom, proceed directly to Step 13.

When the user is ready to deploy:

```
/deploy            # runs npm run build + npx power-apps push
```

### Step 13 — Summary

Print a compact status block, then present exactly 5 options with no explanation. Do not add prose, tips, or "you might want to" text — keep it concise.

First run the deterministic timing summary:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" --summary
```

Report `dataverseMetadataNetworkMs`, `localDeterministicProcessingMs`,
`modelArchitectMs`, `screenPlannerMs`, `outerPlannerWallMs`, and
`userApprovalWaitingMs` as separate values. The outer planner wall contains
nested work and is not added to architect/screen durations. Scaffold and
mutation timing stays outside this planning artifact; show its own captured
step duration when available, otherwise `not recorded`. Never label fixture
processing as network/model time or include user approval waiting in an
agent-performance claim.

```
✅ Native code app created
─────────────────────────────────────────────
App name      : <displayName>
Project       : <working_dir>
Environment   : <env name> (<env id>)
Data model    : <N tables — M reuse, K extend, L create>
Native caps   : <list>
Connectors    : <list>
Screens       : <N total — M from template, K from return-only work orders>
Planning      : metadata <N ms> | local <N ms> | architect <N ms> | screens <N ms>
Approval wait : <N ms> (excluded from agent performance)
Execution     : scaffold <N ms or not recorded> | mutation <N ms or not recorded>
Dev server    : npx expo start — running in background terminal <id>
                (scan QR there when you want to run locally)
─────────────────────────────────────────────
```

If Step 1 emitted warnings, list them in one line each under the block (no decoration).

Then present exactly these 5 options:

```
What now?

1. Preview screens in browser  (/preview-screens)
2. Deploy to tenant            (/deploy)
3. Edit the app                (/edit-app)
4. Add more capabilities       (/add-dataverse, /add-connector, /add-native)
5. Configure auth later        (/set-app-registration-native)

Which option? (or "none — I'll keep iterating locally")
```

**Hard rules for this step:**

- Do NOT add explanatory paragraphs after the options.
- Do NOT recommend an option ("most users want #2").
- Do NOT list alternative `npm` commands — the dev server is already running and is the only local iteration process the user needs to know about.
- Wait for the user's choice before doing anything else. If they pick none, stop.

## Notes

- This skill is the only entry point for new project creation. Do not invoke `/add-*` skills directly during a fresh-project flow — they don't know how to read the plan and would re-prompt the user.
- The planner agent owns the approval gates. This skill never enters plan mode itself — that would create a duplicate gate.
- For mid-project changes after Step 13, the user should run individual `/add-*` skills, or `/edit-app` for plan-backed app iteration.

## Reference

- [shared/shared-instructions-core.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions-core.md)
- [shared/references/screen-templates.md](${CLAUDE_SKILL_DIR}/../../shared/references/screen-templates.md)
- [agents/native-app-planner.md](${CLAUDE_SKILL_DIR}/../../agents/native-app-planner.md)
