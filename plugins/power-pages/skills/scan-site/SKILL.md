---
name: scan-site
description: >-
  Runs a Power Pages security scan on a deployed site, retrieves the latest scan
  report, and produces an HTML summary. Scans the site's public surface for
  vulnerabilities. Use when the user wants to scan, check, test, or assess the
  security of a published Power Pages site, or asks "how safe is my live site".
user-invocable: true
argument-hint: "[optional: --data-only <out-dir>]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Scan Site

Run a security scan on a deployed Power Pages site, fetch the latest results, and surface them in a uniform HTML report.

The scan checks the site's public pages for vulnerabilities across multiple security categories. It runs server-side and may take several minutes to complete.

This skill talks to the Power Platform service that owns the site — it does not analyze local code. The site must be running **Power Pages Core version 1.0.2403.84 or later** for scan features to be available. Pair it with `/scan-code` for source-level analysis.

## Gotchas

- **Website record id vs portal id.** `.powerpages-site/website.yml` stores the website record id, not the portal id. Every script takes `--portalId`. Resolve once via `website.js --websiteId` in Phase 1.
- **Never resolve by name.** Site names can duplicate inside an environment; only the website record id is safe for resolution.
- **A `null` from the resolver means** the site is not deployed, or the authenticated profile is pointing at a different environment than the one that owns the site.
- **Scans are long-running.** The scan runs server-side for a substantial period. The skill polls for completion but should warn the user about the wait.
- **Only one scan per site at a time.** `Z003` (handled as HTTP 204 or HTTP 400 with code `Z003` in `start-deep-scan.js`) surfaces when a start is attempted while a scan is already running. The script exits with code 0 and `{ "status": "already-running" }` — treat it as a normal outcome, not an error.
- **Rate limits apply.** There are daily and weekly caps on scans per site. When exceeded, wait and retry later.
- **A fresh site with no completed scan has no report.** Run a scan first.

**Initial request:** $ARGUMENTS

## Workflow

1. **Phase 1: Prerequisites** — Locate the project, confirm sign-in, identify the site
2. **Phase 2: Plan the scan** — Choose to run a new scan or view the latest results, and confirm in plain language
3. **Phase 3: Run the scan** — Start the scan and wait for it
4. **Phase 4: Fetch results** — Get the latest report
5. **Phase 5: Build the report** — Normalize findings and write the HTML report
6. **Phase 6: Present and next steps** — Show the report, record usage, suggest follow-ups

## Task Tracking

Create tasks in three batches. Mark each `in_progress` when you start and `completed` when you are done.

**Batch 1 — create at the start of Phase 1:**

| Task subject | activeForm |
|--------------|------------|
| Check prerequisites | Checking prerequisites |

Only this one task. Do not create any other tasks until Phase 1 completes and the site is resolved.

**Batch 2 — create after Phase 1 completes** (site resolved):

| Task subject | activeForm |
|--------------|------------|
| Plan the scan | Planning the scan |

**Batch 3 — create after Phase 2 completes** (user confirmed scan type). Only create tasks for phases that will actually run:

| Task subject | activeForm | When to create |
|--------------|------------|----------------|
| Run the scan | Running the scan | Only if the user chose to run a new scan. Do NOT create if the user chose "Just show me the latest results". |
| Fetch results | Fetching results | Always |
| Build the report | Building the report | Always |
| Present findings | Presenting findings | Always |

---

## Phase 1: Prerequisites

### 1.1 Locate the project and detect data-only mode

Use `Glob` to find `**/powerpages.config.json`. Read it to extract the site name. If `$ARGUMENTS` contains `--data-only <out-dir>`, remember that directory — the skill will skip rendering and write only the JSON data file there.

### 1.2 Resolve site identifiers

Two distinct GUIDs identify a Power Pages site, and the rest of the skill needs both:

- **websiteId** — the Dataverse website record id. Stored in `.powerpages-site/website.yml` as `id`. The user-facing identifier.
- **portalId** — the admin-API id used in `/websites/{id}/...` URL paths. Returned as the `Id` field on the admin-API response.

The consumer scripts in this skill only accept `--portalId`, so resolve both values once here and reuse them for the rest of the run.

**Step 1 — read the local websiteId.** Read `.powerpages-site/website.yml`. Extract the `id` field — that is `<WEBSITE_ID>`.

If `.powerpages-site/website.yml` is missing, the site has not been deployed yet. Tell the user (in plain language) that the site needs to be deployed once before it can be scanned, and recommend they run `/deploy-site`. Then stop. Do **not** try to identify the site by name or URL — different sites can share the same name and the URL is not a reliable identifier.

**Step 2 — resolve to portalId.** Call the shared lookup with the Dataverse `<WEBSITE_ID>` from Step 1:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/website.js" --websiteId "<WEBSITE_ID>"
```

The script returns the full website record. Read the `Id` field — that is `<PORTAL_ID>`. Also capture the `Type`, `WebsiteUrl`, and `Name` fields (used for trial-site warnings, summaries, and the report header).

**Sign-in failures show up here.** If the call exits with code `2`, the user is not signed in. Tell them (plainly) which CLI to fix and stop:

- Power Platform CLI: `pac auth create`
- Azure CLI: `az login`

If the call returns `null` (no match), tell the user the local `id` does not exist in this environment and stop. Do **not** attempt to log in or create the site for them.

If the matched site is a trial or developer site, mention that some scan features may be limited; continue anyway.

### 1.3 Check current scan state

Before asking the user what they want, check whether a scan is currently running. This changes Phase 2's available options:

- **If a scan is ongoing** — the user cannot start a new scan. They can fetch an older report or wait.
- **If idle** — all options are available.

Summarize the state to the user in one sentence before continuing.

---

## Phase 2: Plan the scan

**IMPORTANT:** Each question below is a **separate** `AskUserQuestion` call. Do NOT combine them into one multi-step form. Wait for the user's answer to one question before deciding whether to ask the next.

Call `AskUserQuestion` using the structured `questions` array. Keep `label` to **1-5 words** — long labels wrap and look broken. Put "(Recommended)" in `description`, never in `label`. Every option MUST include `description` and `preview`.

```json
{
  "questions": [{
    "question": "Which check do you want to run?",
    "header": "Scan type",
    "multiSelect": false,
    "options": [
      {
        "label": "Deep check",
        "description": "Full scan of your live site. (Recommended)",
        "preview": "Runs a thorough scan of your site's public pages, checking for vulnerabilities across multiple security categories. Takes several minutes to complete — you will get an email when it finishes.\n\nProduces a detailed report with individual findings."
      },
      {
        "label": "Latest results",
        "description": "Show the last scan report without running a new one.",
        "preview": "Fetches the most recent completed scan report from the service. No new scan is started.\n\nUseful when you already ran a scan and want to review the results again."
      }
    ]
  }]
}
```

If the user picks "Just show me the latest results", skip Phase 3 and go straight to Phase 4.

Show a one-line plan in plain language and confirm: `Yes, start the check` / `Change something`.

---

## Phase 3: Run the scan

All scripts in this phase take `--portalId` (the admin-API id from Phase 1.2). They never look up the site themselves — Phase 1.2 already did the resolution.

Let the user know the scan may take several minutes and remind them they can keep working — the skill will check progress in the background.

Start the scan:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-site/scripts/start-deep-scan.js" \
  --portalId "<PORTAL_ID>"
```

Then poll for completion with the same portalId from Phase 1.2:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-site/scripts/poll-deep-scan.js" \
  --portalId "<PORTAL_ID>" \
  --timeoutMinutes 20
```

The polling script prints progress lines every minute and exits when the scan finishes or the timeout passes. If it times out, fetch whatever partial result is available in Phase 4 and note the timeout in the report.

---

## Phase 4: Fetch results

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-site/scripts/get-latest-report.js" \
  --portalId "<PORTAL_ID>" \
  --output "<TEMP_DIR>/latest.json"
```

If `get-latest-report.js` reports that no completed scan exists yet (HTTP 204), record an `info` finding explaining this and proceed without a report body.

---

## Phase 5: Build the report

### 5.1 Normalize findings

Each scan result describes individual checks. Map them into the unified report structure:

| Normalized severity | Unified severity |
|---------------------|------------------|
| `Critical` / `High` | `critical` |
| `Medium`            | `warning` |
| `Low` / `Informational` | `info` |
| `Pass` / `OK`       | `pass` |

For every finding, write a `reasoning` line in plain language that explains the risk to a non-technical reader (e.g., "Anyone visiting your site can reach a sign-in helper page that is normally only used by the service. Showing that page can leak version details that attackers use to plan an attack."). Include a `fix` line with the change to make.

### 5.2 Write data file

Write `<TEMP_DIR>/site-scan-data.json` with:

- `REPORT_TITLE` — `"Live Site Scan"`
- `REPORT_DESC` — short description naming the site and the scan type
- `SITE_NAME` — site display name
- `SUMMARY` — 2–3 sentences: "We checked X pages and Y endpoints. We found N important issues, M smaller ones, and Z things that look healthy."
- `FINDINGS_DATA` — array of finding objects (`id, severity, title, tag?, location?, details?, reasoning, fix?`). Use the page URL or endpoint as `location` when available.
- `DETAILS_DATA` — `{ label: 'Scan details', kind: 'kv', entries: [{ key: 'Scan type', value: 'Deep' }, { key: 'Started', value: '<iso-date>' }, { key: 'Pages checked', value: '<n>' }] }`

In **data-only mode**, write the file to `<DATA_ONLY_DIR>/scan-site.json` and stop here — do not render or open HTML.

### 5.3 Render HTML

Pick `<PROJECT_ROOT>/docs/site-scan.html`, falling back to a date-suffixed name if it exists. Render via the shared script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-scan-report.js" \
  --output "<OUTPUT_PATH>" \
  --data "<TEMP_DIR>/site-scan-data.json"
```

Delete the temp data file when the render succeeds.

---

## Phase 6: Present and next steps

### 6.1 Open in browser

Open the rendered HTML.

### 6.2 Record skill usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "ScanSite"`.

### 6.3 Summarize and offer follow-ups

Summarize in plain language: count of important / smaller issues and the report path.

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| What would you like to do next? | Walk me through fixing the important items; Stop here, I will read the report |

If the user wants help fixing items, group critical findings, explain the first one in plain language, and propose actions. For findings that map to other skills, suggest:

- Header / cookie issues → `/manage-headers`
- Permission issues → `/audit-permissions`
- Login or external identity issues → `/setup-auth`

---

## Constraints

- **Plain language with users** — never lead with words like CSP, CORS, OWASP, hardening, or scan profile. Explain when asked.
- **Background long-running calls** — start the scan, then poll in the background while the user can continue working.
- **Read-only** — this skill only runs scans and reads results. It never enables WAF, deletes scans, or changes site configuration.
- **Trial sites** — some scan features may be limited on trial or developer sites. Do not block the workflow; add an `info` finding instead.
- **Scan results** — when the scan finishes, the service sends an email notification. The scan summary is available in the Security workspace and can be downloaded as a PDF. Report summaries are supported in English (US) only.

## Progress tracking table

Keep this table in your final response, filling each status as phases complete:

| Phase | Status |
|---|---|
| 1. Check prerequisites | ☐ |
| 2. Plan the scan | ☐ |
| 3. Run the scan | ☐ |
| 4. Fetch results | ☐ |
| 5. Build the report | ☐ |
| 6. Present and next steps | ☐ |

## References

- `references/commands.md` — flags, response, and error catalogue for the scan scripts
