## Phase 6: Accessibility Verification

**Goal**: Verify the site meets WCAG 2.2 AA standards using axe-core automated testing and fix any violations

> **Prerequisite:** All pages and components must be fully implemented (Phase 5 complete). The dev server MUST be running.

**Actions**:

### 6.1 Prerequisites

The dev server must be running. Nothing needs installing: the audit uses the plugin's pinned Playwright with the system-installed browser (Edge or Chrome), and verifies the axe-core script against a pinned hash before running it.

### 6.2 Run axe-core Audit on Every Page

Run the audit script via the available shell, sending the dev server URL and every site route as a JSON request on stdin, so neither is parsed by the shell:

```bash
node "${PLUGIN_ROOT}/scripts/axe-audit.js" --input - <<'REQUEST'
{"url": "<DEV_SERVER_URL>", "routes": ["/", "/about", "/services", "/contact"]}
REQUEST
```

Parse the returned JSON array of per-route results. Each result contains `violations` (with `id`, `impact`, `description`, `helpUrl`, and affected `nodes`), `passes` count, and `incomplete` count. A nonzero exit means at least one `critical` or `serious` violation was found, or a route could not be audited - its result has `error` instead of violations, so fix the cause (a broken route, or the dev server down) and audit it again.

Parse the JSON output and record all violations.

### 6.2b Run Rendered Bidirectional Audit

Read `${PLUGIN_ROOT}/references/rendered-bidirectional-verification.md`. If
add-localization returned a successful report, first validate and reuse it:

```bash
node "${PLUGIN_ROOT}/scripts/audit-rendered-bidirectional-readiness.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --reuse-report "<ADD_LOCALIZATION_REPORT_PATH>"
```

This succeeds only when the child report came from a complete `standard` or
`extensive` run that passed, and source, resources, dependencies, build
configuration, and locale availability still match it. A `targeted` repair
report is never reused. Readiness-only metadata does not invalidate it. If reuse
succeeds, do not build a specification or repeat the matrix. If reuse is
stale—such as after accessibility remediation changed relevant source—build
the component/state/viewport specification from the current implementation and
run it:

```bash
node "${PLUGIN_ROOT}/scripts/audit-rendered-bidirectional-readiness.js" \
  --url "<DEV_SERVER_URL>" \
  --projectRoot "<PROJECT_ROOT>" \
  --spec "<TEMP_SPEC_PATH>" \
  --evidence-dir "<PROJECT_ROOT>/docs/bidirectional-evidence/<RUN_ID>" \
  --output "<PROJECT_ROOT>/docs/bidirectional-evidence/<RUN_ID>/report.json"
```

The command prints JSON and exits `1` when blocking rendered findings exist;
parse stdout on that expected path. Exit `2` is a runner/specification failure
and must be fixed before continuing. Delete the temporary specification after
the report is written.

Fix every rendered `error` and rerun the complete affected matrix. Review
findings require screenshot-backed disposition; they are not automatic passes.
The audit must cover computed `lang`/`dir`, component and compound-field
direction, clipping, page overflow, viewport escape, declared non-overlap,
focus order, portals/overlays, unknown/third-party surfaces, and runtime
round-trip preservation when applicable. A visible opaque external surface is
blocking unless it is replaced or intentionally unavailable for the affected
locale.

Use the rendered-verification reference's grouped execution model:
`maxConcurrency: 3` by default, `reload` state isolation unless a deterministic
reset exists, `resettable` only with explicit reset actions, and `isolated`
for global or destructive state. Independent route/viewport/locale groups may
run concurrently; locale-transition sequences remain serial.

> **GATE: Do NOT proceed to Phase 7 while the create-site report contains an
> error affecting an available locale or the available site experience, or an
> untriaged review finding.** Every review item must have evidence and a
> proposed resolution, judgment-based pass, or usable-limitation disposition
> for maker review. An add-localization blocker may continue only when its
> affected locale is verifiably unavailable at every activation boundary; keep
> that child report as pending evidence and audit the remaining available
> experience with a real locale plus pseudo-opposite direction. A screenshot
> documents what rendered; it does not override a deterministic failure.

For each review finding, record whether it was resolved, accepted as a
judgment-based pass, or proposed as a usable limitation. A usable limitation
must name the affected component/page, user impact, and report or screenshot
evidence. Never offer an error finding for maker override. If the
add-localization child returned `pending-remediation`, verify that every
affected locale remains excluded from selectors, detection, metadata, and
production output before continuing with the available site experience.

### 6.3 Fix Accessibility Violations

For each violation found, identify the source file and apply the fix:

| Violation | Fix |
|-----------|-----|
| Missing `alt` text on images | Add descriptive `alt` attributes to `<img>` tags |
| Insufficient color contrast | Adjust CSS color variables to meet 4.5:1 (normal text) or 3:1 (large text) ratios |
| Missing form labels | Add `<label>` elements or `aria-label` attributes |
| Missing landmark regions | Wrap content in `<main>`, `<nav>`, `<header>`, `<footer>` |
| Skipped heading levels | Correct heading hierarchy (h1 → h2 → h3, no gaps) |
| Missing link text | Add descriptive text or `aria-label` to links |
| Missing or incorrect `lang`/`dir` attributes | Set `lang="<SITE_LOCALE>"` and `dir="<SITE_DIRECTION>"` on the root `<html>` element |
| Inadequate focus indicators | Add visible `outline` styles to interactive elements |

After fixing each group of related violations, commit:

```bash
git add -A
git commit -m "Fix accessibility: <violation description>"
```

### 6.4 Re-verify After Fixes

After all fixes are applied, re-run the audit script (same command as 6.2) to confirm violations are resolved:

1. If new violations appear (e.g., a fix introduced a regression), repeat 6.3–6.4
2. Continue until the script exits with code 0 (every route audited, zero `critical` and `serious` violations)
3. If a fix changed colors, spacing, or layout, run a review round on the affected routes and confirm the scorecard still holds. A review round can change source too, so when it does, re-run the audit on those routes; Phase 6 is done only when the last audit and the last review round both pass without a further fix

Present a summary table to the user:

```
| Page | Route | Violations Found | Violations Fixed | Status |
|------|-------|-----------------|-----------------|--------|
| Home | / | 3 | 3 | Pass |
| About | /about | 1 | 1 | Pass |
| Contact | /contact | 2 | 2 | Pass |
| **Total** | | **6** | **6** | **All passing** |
```

> **GATE: Do NOT proceed to Phase 7 until all pages pass axe-core with zero `critical` and `serious` violations.** Minor and moderate violations should also be fixed where possible, but are not blocking.

Record the final axe-core result against the corresponding
`REVIEW_DATA.agentChecks` item. Accessibility remains agent-owned; the maker is
not asked to reproduce the automated audit.

**Output**: Accessibility-verified site with zero critical/serious axe-core violations

## Completion quality checks

- Chosen Google Fonts verified loaded by the font check.
- Complete glyph coverage and correct shaping for `SITE_LOCALE`.
- Design tokens are defined once in the theme and consumed consistently.
- All requested pages and features are implemented, all routes work and navigation is complete.
- The root document uses the approved `SITE_LOCALE` and `SITE_DIRECTION`.
- Retain the critique disposition, per-page/component Git checkpoints and maker approval.

---
