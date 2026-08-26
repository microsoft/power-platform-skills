---
name: perf-checker
description: >-
  Statically scans the entire local Power Pages codebase for performance
  anti-patterns — unpaginated Power Pages lists, webpages/web templates used as
  custom data APIs, FetchXML over-fetching / N+1 / advanced query hints / cache
  bypassing, unbounded Web API queries, disabled header/footer output caching,
  sign-in and page tracking, main-thread-blocking JS, CSS @import, frequent Web
  API polling, and oversized assets — then reports them and offers safe
  auto-fixes with per-fix approval.
  Use when the user wants to: "check performance", "perf check", "find
  performance issues", "why is my site slow", "optimize my Power Pages site",
  "find anti-patterns", "review FetchXML performance", "is my site over-fetching
  data", or "audit site performance".
user-invocable: true
argument-hint: "[optional: --review <out-dir>]"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# perf-checker

Statically analyzes the **entire local Power Pages codebase** for known performance anti-patterns, presents them by severity in an HTML report + plain-language summary, and offers **safe auto-fixes with per-fix approval**. Never applies a fix without explicit consent.

This skill reads local source only — it does not call the deployed site. For a live security/vulnerability scan use `/scan-site`.

**Initial request:** $ARGUMENTS

## Prerequisites

- An existing local Power Pages project or PAC CLI site download. `powerpages.config.json`
  and `.powerpages-site/` are useful discovery markers, but they are not required
  when the user supplies an existing site folder. Classic downloads with root-level
  `.portalconfig/`, `website.yml`, and portal content folders are valid inputs.
- Node.js (bundled scripts run under `node`).

No sign-in, PAC CLI, or Azure CLI is required — the analysis is fully offline.

## What it detects

See `references/perf-reference.md` for the authoritative rule catalog (tags,
severities, detection, fixes, thresholds, and Microsoft Learn sources). The scan
must cover all of these categories:

- **List pagination** — Power Pages list definitions with no positive
  `adx_pagesize` / `pagesize`.
- **Webpages used as APIs** — FetchXML/entity-backed web templates or webpage
  content that emit JSON/XML instead of a normal HTML page.
- **FetchXML anti-patterns** — `all-attributes`, no explicit columns, too many
  columns, no paging, oversized `count`/`top`, N+1 queries inside Liquid loops,
  unnecessary `returntotalrecordcount`, leading-wildcard `like` filters, and
  related-table ordering.
- **FetchXML query controls** — advanced query hints (`options`,
  `latematerialize`, `no-lock`, `useraworderby`, filter `hint`) and request-time
  values or explicit settings that bypass server-side query caching.
- **Web API anti-patterns** — `$select=*`, missing `$select`, missing `$top`,
  too many selected columns, oversized `$top`, `$count=true`, `$expand` without
  a nested `$select`, `contains`/`endswith` filters, request-time date filters,
  related-table ordering, request-per-item/N+1 loops, and short-interval polling.
- **Rendering and caching** — disabled Header/Footer output caching,
  render-blocking `<head>` scripts, runtime CSS `@import`, synchronous XHR/jQuery,
  and `document.write`.
- **Tracking and volume** — sign-in/page/file tracking, excessive web-file or
  web-role counts, and oversized static assets.

## Phases

1. **Prerequisites** — locate the project, confirm the site exists, detect review mode
1.5. **Ground in current performance guidance** — optional Microsoft Learn cross-check (capped, offline-safe)
2. **Scan** — run the deterministic analyzer over the codebase
3. **Present findings** — severity table + coverage stats
4. **Offer auto-fixes** — per-finding consent loop for the safely-automatable findings
5. **Verify** — re-run the analyzer to confirm fixes resolved their findings
6. **Report & next action** — render the HTML report, summarize, and route follow-ups

## Task Tracking

Create tasks in three groups. Mark each `in_progress` when starting, `completed` when done.

| Group | When to create | Tasks |
|-------|----------------|-------|
| 1 | At start | Verify prerequisites and locate project |
| 2 | After prerequisites pass | Scan codebase for anti-patterns · Present findings |
| 3 | After findings presented (skip all three in review mode) | Offer auto-fixes (only if any `autoFixAvailable`) · Verify fixes · Render report and route follow-ups |

---

## Phase 1 — Verify Prerequisites and Locate Project

1. **Detect review mode first**: if `$ARGUMENTS` contains `--review <out-dir>`,
   remember `<REVIEW_DIR>`.
2. Resolve `<PROJECT_ROOT>` in this order:
   - If `<REVIEW_DIR>` itself contains recognizable Power Pages source, use it as
     both `<PROJECT_ROOT>` and `<REVIEW_DIR>`. This supports orchestrated reviews
     that pass the downloaded site folder directly.
   - Otherwise use an explicitly supplied project directory, then the current
     working directory. Use `Glob` to locate `**/powerpages.config.json`,
     `**/.powerpages-site`, `**/.portalconfig`, or `**/website.yml` when needed.
3. Treat any of these as recognizable Power Pages source:
   `powerpages.config.json`, `.powerpages-site/`, root-level `.portalconfig/`,
   `website.yml`, or a characteristic portal export layout containing folders such
   as `web-pages/`, `web-templates/`, or `web-files/`. Do **not** reject an
   explicitly supplied existing site folder merely because it lacks
   `powerpages.config.json` and `.powerpages-site/`.
4. If no existing directory with recognizable Power Pages source can be located,
   tell the user and recommend `/create-site`, then **stop**.
5. In review mode Phases 3, 4, and 6-presentation are skipped: Phase 2 runs,
   Step 5.1 writes JSON only, and the skill stops after writing it.

Report: "Found project: `<PROJECT_ROOT>`. Scanning for performance anti-patterns."

## Phase 1.5 — Ground in current performance guidance

> Skip in **review mode**. Cap this step at ~30 seconds. If MCP search / fetch errors out or is unavailable, log a one-line note and continue — this skill must remain runnable offline.

1. Run `microsoft_docs_search` with the query: `Power Pages Site Checker performance FetchXML output caching best practices`.
2. Optionally `microsoft_docs_fetch` `https://learn.microsoft.com/en-us/power-pages/admin/site-checker-performance`.
3. Extract a one-paragraph summary of what Microsoft Learn currently says. Compare it against the rule catalog in `references/perf-reference.md`. If Learn documents a performance pattern not covered by any analyzer rule, surface it to the user in Phase 6 as a **manual** follow-up — do not silently invent findings the analyzer did not produce.

## Phase 2 — Scan the codebase

Run the deterministic analyzer over the whole project:

```bash
node "${PLUGIN_ROOT}/skills/perf-checker/scripts/analyze-perf.js" --projectRoot "<PROJECT_ROOT>"
```

The analyzer prints a single JSON object `{ status, findings, details, severityCounts }` to stdout. Parse it. Each finding has `id`, `tag`, `severity`, `title`, `location`, `details`, `fix`, `autoFixAvailable`, and (when auto-fixable) `fixAction`. See `references/perf-reference.md` for the finding envelope and every tag's meaning.

If the only finding is `PERF-NONE`, the codebase is clean — note this and skip Phase 4/5 (still render the report in Phase 6 so the user has a record).

## Phase 3 — Present findings

> Skip in **review mode** (go straight to Step 5.1's JSON write).

Present all findings grouped by severity, highest first:

| # | Severity | Tag | Issue | Location | Auto-fix? |
|---|----------|-----|-------|----------|-----------|
| 1 | high | PERF-FETCHXML-ALLATTR | FetchXML retrieves all attributes | `...:2` | No |
| 2 | warning | PERF-HEADER-OUTPUTCACHE | Header output caching disabled | `...sitesetting.yml` | Yes |

Then show the coverage stats from `details.entries` (FetchXML/Liquid, list,
Web API/script and CSS files scanned; web-file/web-role counts; total findings).
Keep the language plain; explain a tag only when asked.

## Phase 4 — Offer auto-fixes

> Skip in **review mode**. Skip entirely if no finding has `autoFixAvailable: true`.

Only the site-setting and tracking findings are safely automatable (`PERF-HEADER-OUTPUTCACHE`, `PERF-FOOTER-OUTPUTCACHE`, `PERF-SIGNIN-TRACKING`, `PERF-WEBPAGE-TRACKING`, `PERF-WEBFILE-TRACKING`). List pagination, webpage-as-API, FetchXML, Web API, query-hint, cache-bypass, and asset findings require human judgment — present those as manual fixes only.

For each finding with `autoFixAvailable: true`, in order:

<!-- gate: perf-checker:4.auto-fix | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · perf-checker:4.auto-fix):** Per-finding consent before applying any auto-fix. **Loops once per `autoFixAvailable` finding** — each gets its own Yes / No / Skip-all `AskUserQuestion` naming the finding's tag and the exact change. **Never batch fixes** — three fixable findings = three separate prompts (unless the user picks "Skip all", which short-circuits the loop). Each fix has its own blast radius (a different site setting or YAML file), so approving one does not approve the next.
>
> **Trigger:** Phase 4, once per fixable finding.
> **Why we ask:** Enabling output caching alone can break header/footer rendering unless the web templates also use `{% substitution %}` (see caveat below); toggling tracking edits committed YAML. The user must consent to each concrete change.
> **Cancel leaves:** Nothing — declining a fix leaves that finding untouched and reported as manual.

For the approved finding, apply its `fixAction`:

- **`create-site-setting`** (setting is absent from a per-record `.powerpages-site`
  layout): create it with the shared helper —
  ```bash
  node "${PLUGIN_ROOT}/scripts/create-site-setting.js" --projectRoot "<PROJECT_ROOT>" --name "<fixAction.name>" --value "<fixAction.value>" --type boolean --description "<short why>"
  ```
  If it reports the setting already exists, treat it as already handled and switch to the `set-site-setting` path.
- **`set-site-setting`** (setting exists but is wrong): use `Edit` on the finding's `location` file to flip the `value:` line (`false` → `true`, or tracking `true` → `false`). Do **not** call `create-site-setting.js` — it refuses to overwrite.
- **`set-yaml-field`**: use `Edit` at the finding's precise `location` to set
  `<fixAction.field>: <fixAction.value>` (e.g., `adx_enabletracking: false`).
  For a classic aggregate `sitesetting.yml`, `fixAction.recordName` identifies the
  setting record and the location points at its exact `adx_value` line. Do not
  replace another record's matching boolean.

> **Output-cache caveat (always surface this):** enabling `Header/Footer/OutputCache/Enabled` is **not** sufficient on its own — the Header, Footer, and Languages-Dropdown web templates must also use the `{% substitution %}` Liquid tag, or those regions stop rendering. After applying an output-cache fix, tell the user to update those templates and verify the site still renders.

Mark each finding **Fixed**, **Skipped**, or **Manual required** as you go.

## Phase 5 — Verify fixes

> Skip in **review mode**. Skip if no auto-fix was applied.

Re-run the analyzer to confirm the applied fixes resolved their findings:

```bash
node "${PLUGIN_ROOT}/skills/perf-checker/scripts/analyze-perf.js" --projectRoot "<PROJECT_ROOT>"
```

Confirm each fixed finding's tag/location is gone (or downgraded from `warning` to `info` for the absent→present caching case). If a fix did not take, report it and offer to retry or hand it to the user. Use this re-scanned result set as the basis for the Phase 6 report so it reflects the post-fix state.

## Phase 6 — Report & next action

### 6.1 Review mode short-circuit

Handled at Step 5.1 below — review mode never reaches the HTML render or the follow-up walk-through.

### Step 5.1 — Write the review JSON

Write the analyzer's `{ status, findings, details }` object (the Phase 5 re-scan result if a re-scan ran, otherwise the Phase 2 result) to a JSON file:

- **Review mode**: write to `<REVIEW_DIR>/perf-checker.json`, then **stop**. The orchestrating skill (e.g., `security-review`) handles presentation.
- **Interactive mode**: write to `<TEMP_DIR>/perf-checker.json` where `<TEMP_DIR>` is a scratch directory containing only this file.

The filename **must** be `perf-checker.json` — that is the key `build-review-data.js` maps to the Performance section.

### Step 5.2 — Render the HTML report

Skip in **review mode**. Reuse the shared report pipeline (same template as the security review and site scan):

```bash
node "${PLUGIN_ROOT}/scripts/build-review-data.js" \
  --reportName "Performance Check" \
  --inputDir "<TEMP_DIR>" \
  --siteName "<SITE_NAME>" \
  --goalLabel "Performance" \
  --scopeLabel "Local codebase" \
  --summary "<SUMMARY_TEXT>" \
  --output "<TEMP_DIR>/data.json"

node "${PLUGIN_ROOT}/scripts/render-review.js" \
  --data "<TEMP_DIR>/data.json" \
  --output "<PROJECT_ROOT>/docs/perf-check-<YYYY-MM-DD-HHMMSS>.html"
```

`<SITE_NAME>` comes from `powerpages.config.json` (`siteName`) or the site's `website.yml`; fall back to the folder name. The filename **must** include the local timestamp (e.g., `perf-check-2026-05-14-053805.html`). Delete `<TEMP_DIR>` after the render succeeds and open the report in the browser.

### Step 5.3 — Summarize and route follow-ups

<!-- gate: perf-checker:6.next-action | category=plan | cancel-leaves=nothing -->
> 🚦 **Gate (plan · perf-checker:6.next-action):** After the report, recommend the single most useful next step and let the user accept or choose differently via `AskUserQuestion` — walk through the manual (non-auto-fixable) findings one at a time, re-scan, or finish. Reviewing findings and re-scanning are read-only; nothing is changed without a later Phase 4 consent.
>
> **Trigger:** Phase 6, after the report is rendered (interactive mode only).
> **Why we ask:** The manual list, webpage-as-API, FetchXML, Web API, query-hint,
> cache-bypass, and asset fixes need edits the user must drive; auto-walking every
> finding would be noisy if they only wanted the report.
> **Cancel leaves:** Nothing — the report is already written; declining ends the skill cleanly.

Give a plain-language summary: total findings, count by severity, and how many
were auto-fixed. For manual findings (list pagination, webpage-as-API patterns,
FetchXML/Web API anti-patterns, query hints, cache bypassing, volume counts, and
large assets), offer to walk through them one at a time with the concrete edit
each needs. If nothing meaningful remains, end the skill — do not ask just to ask.

### Record Skill Usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "PerfChecker"`.

## Constraints

- **Read-only until consent.** The analyzer never mutates anything. The only writes are the HTML report, the scratch JSON, and auto-fixes the user explicitly approves in Phase 4.
- **High-signal findings.** Heuristics (Web API N+1, missing-but-defaultable caching) are intentionally conservative to avoid false positives. When a finding is a heuristic, say so.
- **Plain language.** Explain a tag only when asked; lead with the impact, not the internal name.
- **Offline-safe.** Phase 1.5 is best-effort; the skill must complete with no network access.

## References

- `references/perf-reference.md` — authoritative rule catalog: tags, severities, detection logic, fixes, auto-fix actions, thresholds, manual-only checks, key nuances, and Microsoft Learn sources. Read when explaining a finding or deciding whether a fix is safe.

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Verify prerequisites and locate project | Verifying prerequisites | Locate an explicit/current code-site or PAC-download folder, confirm recognizable Power Pages source, detect review mode |
| Scan codebase for anti-patterns | Scanning codebase | Run analyze-perf.js over the project, parse findings JSON |
| Present findings | Presenting findings | Show severity table and coverage stats |
| Offer auto-fixes | Applying auto-fixes | Per-finding consent loop; apply site-setting/tracking fixes, surface substitution caveat |
| Verify fixes | Verifying fixes | Re-run analyzer, confirm fixed findings are gone |
| Render report and route follow-ups | Rendering report | Build review JSON, render HTML, summarize, route manual follow-ups |
