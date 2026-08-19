---
name: visual-qa
description: Use after a Power Apps mobile app is running in a native Expo dev client to verify and repair its rendered visual experience against native-app-plan.md. Always use for premium/bespoke designs, screenshot/Figma/reference matching, Home composition or media changes, navigation reskins, clipping/overlap complaints, or release-readiness visual checks. Captures native screenshots, measures Product Experience testIDs, compares reference hierarchy without brittle pixel equality, fixes focused source issues, and writes a visual-QA report. Do not use for terminal/runtime error diagnosis alone; use /debug-app for that.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: opus
---

**Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** — read first.

# Visual QA

Verify the real native app, not an HTML approximation. Use Expo MCP automation
when available. A native screenshot supplied by the user is the fallback when a
platform/device cannot be automated.

## Inputs

- `--working-dir <path>` — project root; defaults to cwd.
- `--plan <path>` — defaults to `native-app-plan.md`.
- `--routes <comma-separated routes>` — affected routes; otherwise Home + every
  tab root + every screen with Reference materialization.
- `--platform <ios|android|both>` — defaults to plan target platforms.
- `--screenshots <path[,path...]>` — native capture fallback.
- `--report-only` — record findings without editing source.
- `--full` — force the premium/reference capture matrix.

## Boundaries

- Keep `/debug-app` terminal/log-focused. Visual QA owns rendered composition,
  geometry, media, hierarchy, navigation silhouette, clipping, and overlap.
- Use a native dev client only. Do not use React Native Web, browser screenshots,
  static preview HTML, or direct Metro HTTP requests as runtime evidence.
- Do not claim pixel parity. Native fonts/chrome/rasterization vary. Compare
  normalized geometry, hierarchy, motifs, and perceptual result.
- Fix one visual contract failure at a time. Preserve data and workflow behavior.
- Never mark missing platform/viewport coverage as pass.

## Artifacts

Write under `<working_dir>/.visual-qa/`:

- `manifest.json` — contract, capture matrix, measurements, results, timestamps.
- `report.md` — concise human-readable findings and fixes.
- `captures/` — screenshot paths returned by Expo MCP or copied validated native
  screenshots. Do not overwrite prior sessions; use an ISO timestamp directory.

## Phase 0 — Contract and Static Preflight

1. Read `native-app-plan.md` sections: Product Experience, Design Direction,
   Design, Screens, Generated Services, Approvals.
2. Read `design-intake.md` when reference fidelity is not `none`.
3. Read `brand/design-system.md`, `brand/tokens.ts`, and affected TSX/signature
   components.
4. Run:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-contract.js" --project-root "<working_dir>"
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-composition.js" --project-root "<working_dir>" --report "<working_dir>/app"
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report "<working_dir>/app"
npx tsc --noEmit
```

A Product Experience, TypeScript, or composition failure blocks runtime capture.
Repair first unless `--report-only`, where it is recorded as a blocker.

## Phase 1 — Scope and Capture Matrix

Parse visual ambition and reference fidelity.

### Standard native smoke

Use for `template`/`tailored` with `none`/`directional` fidelity:

- Current connected native viewport: Home.
- Every tab root once.
- Every affected route supplied with `--routes`.
- Both iOS and Android when both are connected; otherwise record missing platform.

### Full visual QA

Use when `--full`, ambition is `premium`/`bespoke`, fidelity is
`high`/`strict-structural`, or the request mentions premium/reference/full
redesign:

- Home at small iPhone target (about 375x667).
- Home at current iPhone target (about 393x852).
- Home at standard Android target (about 360x800).
- Every tab root at one available target.
- Every screen materializing a required reference motif.
- One large-system-text capture of Home and the most form/list-dense route.

Expo automation may expose only the currently connected device. Capture what is
available, then request only the missing native captures from the user. A full
pass requires the full matrix; partial coverage returns `DONE_WITH_CONCERNS`.

## Phase 2 — Detect the Native App

1. Call `mcp__expo__collect_app_logs` once.
2. If logs show a bundle/runtime error, stop visual review and route to
   `/debug-app "<error>"` or fix the local bundle issue first.
3. If no app is connected, state that Metro is running/unavailable based on the
   evidence and ask once for the user to open the native app. Retry once.
4. If Expo MCP is unavailable, validate `--screenshots`. Without MCP or native
   screenshots, return `BLOCKED: no native visual evidence`.

## Phase 3 — Navigate and Capture

For each scoped screen:

1. Navigate from the current screen using `mcp__expo__automation_find_view` and
   `mcp__expo__automation_tap`, following Navigation Contracts. Prefer tab labels
   and visible planned actions. Do not invent routes or use browser deep links.
2. Find these views when applicable:
   - `experience-signature`
   - `experience-headline`
   - `experience-media`
   - `experience-primary-action`
   - `experience-next-section`
   - `experience-metric-1` through `experience-metric-4`
   - `experience-motif-<slug>`
3. Call `mcp__expo__automation_take_screenshot` and preserve the returned capture
   path/metadata in the session manifest.
4. Call `mcp__expo__collect_app_logs`; a new error makes that screen fail and
   routes to `/debug-app` or a focused source fix before visual review continues.

If automated navigation cannot reach one route, ask the user to navigate there
and reply once, then capture. Do not skip it silently.

## Phase 4 — Deterministic Geometry Checks

Use rendered view bounds and screenshot dimensions.

For Home:

- Signature exists once and is non-zero.
- Expected signature height is
  `max(minimumHeight, viewportHeight * viewportShare)`.
- Pass when measured height is within max(16dp, 6%) of expected and never below
  minimum height.
- Headline exists, is visible, does not overlap media/action, and respects source
  validation for minimum type size.
- Required media exists, is non-zero, and shows content or the approved fallback.
- Metric view count does not exceed Supporting metrics maximum.
- Primary action exists once in its approved placement.
- When next-section visibility is `yes`, the top of `experience-next-section` is
  inside the viewport and below the signature start.
- A forbidden duplicate tab action is absent.

For every captured screen:

- No view clips under status/navigation/home-indicator areas.
- No incoherent overlap or off-screen interactive control.
- Long text wraps/truncates intentionally; no text escapes its container.
- Loading/error/empty/populated signature/media states preserve outer geometry.
- Touch controls remain at least 44dp, or the stricter approved context size.
- Screenshot is not blank, all-white/all-black, or a red error overlay.

Record actual and expected measurements in `manifest.json`.

## Phase 5 — Visual and Reference Review

Review screenshots using the approved personality and composition, not taste in
isolation:

- First-viewport region order and dominance.
- Actual product/place/object/media prominence and crop.
- Display/body hierarchy, wrapping, and card/panel heading scale.
- Surface, border, radius, spacing, and color-role relationships.
- Navigation silhouette and cross-tab variation.
- Required motifs and forbidden drift.
- Action ownership and one-handed reach.
- Status clarity without turning operational records into app-error screens.
- Dynamic Type and small-viewport resilience.

For `high`/`strict-structural`, compare each Design Intake requirement with a
screenshot observation. Use deterministic geometry plus visual review. Exact pixel RMSE is not the primary metric.

## Phase 6 — Focused Fix Loop

Skip edits in `--report-only` mode. Otherwise, for each failure:

1. Map the failed testID/view to its screen or shared signature component.
2. Name one falsifiable source hypothesis and the expected screenshot change.
3. Edit only the owning TSX/component/token rule. Do not rewrite data/services.
4. Run `npx tsc --noEmit`, changed-file validation, and the focused composition
   validator.
5. Let Metro hot reload, return to the same screen, and recapture the same
   viewport.
6. Pass only when both the deterministic measurement and visual observation are
   corrected.

Cap at three attempts per finding. After three, mark `NEEDS ATTENTION` and
continue collecting independent evidence; do not weaken the contract.

## Phase 7 — Report and Return

Write `report.md`:

```markdown
# Visual QA Report

- App / session / platforms / viewports
- Product archetype / personality / ambition / Home composition
- Reference fidelity / design intake

## Results
| Screen | Platform / viewport | Geometry | Visual | Reference | Result |

## Measurements
| Contract field | Expected | Actual | Result |

## Fixes
- <file + concise change + recapture evidence>

## Missing Coverage
- <platform/viewport/reason>

## Remaining Findings
- <severity + screen + evidence + next action>
```

Return the literal first line:

- `DONE` — all required captures and checks pass.
- `DONE_WITH_CONCERNS: <missing coverage or non-blocking findings>` — partial
  matrix or explicitly accepted residual risk.
- `BLOCKED: <reason>` — no native evidence, static contract failure in
  report-only mode, or required screen cannot be captured.

Then include report and capture paths. Update `mobile-app-status.json` visual-QA
fields and append the result to `memory-bank.md` Design history.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-plan-status.js" \
   --project-root "<working_dir>" \
   --from-plan "<plan_path>" \
   --visual-qa-state "<pass|concerns|blocked>" \
   --visual-qa-report "<working_dir>/.visual-qa/<session>/report.md" \
   --visual-qa-coverage "<platform/viewport summary>"
```
