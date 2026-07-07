---
name: scan-site
description: >-
  Runs a security scan on a deployed Power Pages site, fetches the latest
  scan report, and produces a plain-language summary. Scans the live site's
  public surface for vulnerabilities and surfaces issues by severity. Use
  when the user wants to scan, check, test, audit, or assess a published
  site, find vulnerabilities on production, view the latest scan report,
  see previous scan results, run a security audit, or asks "how safe is
  my live site?", "is my site vulnerable?", "audit my production site" —
  even if they say "find issues" or "check for problems" without mentioning
  "scan" or "security".
user-invocable: true
argument-hint: "[optional: --review <out-dir>]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Scan Site

Run a security scan on a deployed Power Pages site, fetch the latest scan report, and surface findings in a plain-language summary. The scan runs server-side; duration depends on site size — small sites finish in minutes, large sites can take hours.

This skill scans the live deployed site, not local source code.

**Initial request:** $ARGUMENTS

## Gotchas

- **Website record id vs portal id.** `.powerpages-site/website.yml` stores the website record id, not the portal id. Every script takes `--portalId`. Resolve once via `website.js --websiteId` during prerequisites.
- **Never resolve by name.** Site names can duplicate inside an environment; only the website record id is safe.
- **`null` from the resolver** means the site is not deployed, or the authenticated profile points at a different environment.
- **Scans are long-running.** Duration depends on site size — small sites finish in minutes, large sites can take hours. Poll in the background and increase `--timeoutMinutes` for large sites.
- **Only one scan per site at a time.** A start while a scan is running returns `Z003` — `start-deep-scan.js` reports it as `{ "status": "already-running" }` (exit 0).
- **Rate limits may apply.** The service may throttle repeated scans on the same site. When throttled, wait and retry later.
- **No completed scan yet.** A fresh site or a site mid-scan has no completed report — `get-latest-report.js` returns `{ "status": "empty" }`.

## Workflow

1. **Prerequisites** — Locate project, confirm sign-in, identify site
2. **Check scan state** — Detect whether a scan is currently running
3. **Choose an action** — Context-aware recommendation (run new scan / show latest)
4. **Run the scan** — Start and poll for completion
5. **Fetch and summarize** — Get the report, present findings
6. **Walk through follow-ups** — Route issues to the right downstream skill (only if the report contains issues)

## Task Tracking

Create tasks in four groups. Mark each `in_progress` when starting, `completed` when done.

| Group | When to create | Tasks |
|-------|----------------|-------|
| 1 | At start | Check prerequisites |
| 2 | After prerequisites pass | Check scan state · Choose an action (skip in review mode) |
| 3 | After user confirms an action (or in review mode) | Run the scan (skip only if the user chose to view latest results in interactive mode) · Fetch and summarize (always) |
| 4 | After fetch and summarize | Walk through follow-ups (only if the report contains issues AND not in review mode) |

---

## 1. Prerequisites

### 1.1 Locate the project, detect review mode

Use `Glob` to find `**/powerpages.config.json`. If `$ARGUMENTS` contains `--review <out-dir>`, remember the output directory — Step 3 (choose an action) is skipped, Step 4 (run scan) executes automatically (start a fresh scan or attach to a running one), Step 5 writes JSON only, and Step 6 (follow-ups) is skipped.

### 1.2 Resolve site identifiers

Read `.powerpages-site/website.yml` → extract `id` field → that is `<WEBSITE_ID>`.

If missing, the site has not been deployed. Tell the user and recommend `/deploy-site`. Stop. Do **not** resolve by name or URL.

Resolve to portalId:

```bash
node "${PLUGIN_ROOT}/scripts/website.js" --websiteId "<WEBSITE_ID>"
```

Capture `Id` (portalId), `Type`, `Name`, `WebsiteUrl`. If exit code `2` → sign-in required (`pac auth create` or `az login`). If `null` → site not found in this environment. Stop in either case.

---

## 2. Check scan state

```bash
node "${PLUGIN_ROOT}/skills/scan-site/scripts/poll-deep-scan.js" --portalId "<PORTAL_ID>" --once
```

`--once` does a single status check, exits 0, and prints:

- `{ "status": "ongoing" }` → a scan is currently running.
- `{ "status": "idle" }` → no scan running.

Then call `get-latest-report.js` to know whether a completed report exists:

```bash
node "${PLUGIN_ROOT}/skills/scan-site/scripts/get-latest-report.js" --portalId "<PORTAL_ID>"
```

`{ "status": "ok" }` means a report is available. `{ "status": "empty" }` means no completed scan exists.

---

## 3. Choose an action

Skip in **review mode** — go straight to Step 4 (which always runs in review mode).

MUST use plain language only. Never use words like CSP, CORS, OWASP, hardening, or scan profile.

### Default approach

<!-- gate: scan-site:3.action-choice | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · scan-site:3.action-choice):** Recommend an action based on the site's scan state (running, idle, has report, no report), then ask the user to accept or choose differently. Starting a new scan triggers a multi-minute backend run; using an existing report is free.
>
> **Trigger:** Phase 3 entry (interactive mode only — review mode bypasses to step 4).
> **Why we ask:** Auto-starting a new scan wastes minutes if a recent report already answers the question; auto-using a stale report misses recent findings.
> **Cancel leaves:** Nothing — no scan triggered, no report consumed.

Analyze the site's current state and **recommend the single most relevant action** via `AskUserQuestion`:

- Scan running, no completed report → recommend waiting for the running scan to finish.
- Scan running, report exists → recommend showing the latest results while the new scan continues.
- Idle, no completed report → recommend running a new scan.
- Idle, recent report exists → ask whether to use the existing report or run a fresh scan.

If the site's state does not warrant a specific recommendation, do not force one — ask what the user wants to do.

### Option rules

<!-- not-a-gate: meta-documentation describing how to structure `AskUserQuestion` options in this skill — not a literal call site. The actual prompt ("use existing report / run a fresh scan") fires dynamically in §3 Default approach. See approval-gates.md §6.24a + §6.27. -->

When presenting options via `AskUserQuestion`:
- Keep `label` to 1–5 words. Include `description` on every option.
- For options that trigger a new scan, surface the relevant caveats inside that option's `description` so the user has them at decision time. Do not ask a separate confirmation question after the user picks the option.
- Include `preview` only when the option represents a concrete change (starting a new scan). Do not add `preview` to "show latest" or informational choices.
- Only show options that are actionable given the current state. If a scan is already running, do not offer "Start a new scan".
- Mark "(Recommended)" only when the site's state justifies it.

---

## 4. Run the scan

In **review mode**, always execute this step: if a scan is already running, attach to it and poll; otherwise start a fresh scan and poll. Do not ask — review mode runs end-to-end without user interaction.

In interactive mode, skip if the user chose to view the latest results.

Start the scan:

```bash
node "${PLUGIN_ROOT}/skills/scan-site/scripts/start-deep-scan.js" --portalId "<PORTAL_ID>"
```

If stdout is `{ "status": "already-running" }`, skip ahead to polling — there is already a scan in progress.

Then poll for completion:

```bash
node "${PLUGIN_ROOT}/skills/scan-site/scripts/poll-deep-scan.js" --portalId "<PORTAL_ID>"
```

Run polling with `run_in_background: true` so the user can keep working. The script exits when the scan finishes or the timeout passes (default 20 minutes). If it times out, fetch whatever report is available and note the timeout in the summary.

---

## 5. Fetch and summarize

### 5.1 Fetch and transform the report

```bash
node "${PLUGIN_ROOT}/skills/scan-site/scripts/transform-report.js" --portalId "<PORTAL_ID>"
```

Parse the stdout JSON. The status field can be:

- `ok` — a normal report with `findings` and `details`.
- `empty` — no completed scan exists for this site (e.g., fresh site or scan still running). Record a single `info` finding explaining this and continue.
- `malformed` — the API returned a response missing the `Rules` array. The transform emits a single `warning` finding describing this; surface it to the user and recommend re-running the scan.

See `references/scan-reference.md` for the `Risk` → severity mapping the script applies.

### 5.2 Review mode

In **review mode**, skip the HTML report and write the transform stdout to `<REVIEW_DIR>/scan-site.json`. Then stop. The transform emits `{ status, findings, details }`; the orchestrating skill handles presentation.

### 5.3 Render HTML report

Skip in **review mode**.

Render uses the same shared template as the consolidated security review. Build a single-section review-data payload, then render:

```bash
node "${PLUGIN_ROOT}/scripts/build-review-data.js" \
  --reportName "Site Scan" \
  --inputDir "<TEMP_DIR>" \
  --siteName "<SITE_NAME>" \
  --goalLabel "Live Site Scan" \
  --scopeLabel "<SCOPE_LABEL>" \
  --summary "<SUMMARY_TEXT>" \
  --output "<TEMP_DIR>/data.json"

node "${PLUGIN_ROOT}/scripts/render-review.js" \
  --data "<TEMP_DIR>/data.json" \
  --output "<PROJECT_ROOT>/docs/site-scan-<YYYY-MM-DD-HHMMSS>.html"
```

`<TEMP_DIR>` should contain only `scan-site.json` (the transform output from Step 5.1) — `build-review-data.js` ignores intermediate files. The filename **must** include the local timestamp (e.g., `site-scan-2026-05-14-053805.html`). Delete `<TEMP_DIR>` after the render succeeds. Open the rendered HTML in the browser.

### 5.4 Present summary

Plain-language summary in the chat: total findings, count by severity, and what changed since the last scan if available. Do not lead with technical names.

### 5.5 Record skill usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "ScanSite"`.

---

## 6. Walk through follow-ups

Skip in **review mode**. Skip if the report has no issues.

Group findings by which downstream skill can help:

- Header / cookie issues → `/manage-headers`
- WAF / firewall issues (block bots, rate-limit pages, restrict IPs/countries) → `/manage-firewall`
- Permission issues → `/audit-permissions` to review existing table permissions, and/or `/create-webroles` to set up role-based access
- Login or external identity issues → `/setup-auth`
- Code-level issues (exposed debug pages, information leakage, source visible publicly) → suggest a manual code fix; there is no routed skill for these findings

Suggest only the skills that match findings actually present in the report. If a finding does not map to any skill, surface it as a manual follow-up the user can act on. If no meaningful follow-up exists, end the skill — do not ask just to ask.

---

## Constraints

- **Plain language** — MUST NOT use technical jargon with the user. Use everyday language; explain the technical name only when asked.
- **Read-only** — this skill only runs scans and reads results. It never enables WAF, deletes scans, or changes site configuration.
- **Background long-running calls** — start the scan, then poll via `run_in_background: true` so the user can continue working.
- **Context-aware interactions** — every recommendation MUST reflect the site's current state:
  - Never offer "Start a new scan" while one is already running.
  - Never offer "Show latest results" when no completed report exists.
  - Mark "(Recommended)" only when the state justifies it.
- **Preview is for change review only** — include `preview` only on options that start a new scan. Do not add to navigation or informational choices.

## References

- `references/commands.md` — script flags, response shapes, error catalogue, operating notes. Read § "Common error catalogue" when a script returns a non-zero exit code.
- `references/scan-reference.md` — field-level schema for the deep-scan report, alert risk values, rule statuses, and severity mapping. Read when normalizing findings.
