---
name: manage-code-scan
description: >-
  Scans a Power Pages code site project for security issues in source code and dependencies.
  Runs static analysis with opengrep and dependency scanning with trivy, then produces an
  HTML report grouping findings by severity. Use when the user wants to review code for
  security problems, check for vulnerable packages, run a code scan, or check the safety
  of their site source — even if they do not use the words "static analysis" or "SAST".
user-invocable: true
argument-hint: "[optional: --data-only <out-dir>]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Manage Code Scan

Run security analysis on a Power Pages code site's source files and installed packages, then summarize the results in an HTML report.

The skill uses two open-source command-line tools:

- **opengrep** — pattern-based code analysis that flags risky code patterns (hard-coded secrets, unsafe HTML rendering, weak crypto, missing input checks).
- **trivy** — scans the project's installed packages for known vulnerabilities, detects hard-coded secrets in source files, and flags license compliance issues.

This skill **detects** whether the tools are installed and **stops with install instructions** when they are missing. It never installs anything itself.

**Initial request:** $ARGUMENTS

## Workflow

1. **Phase 1: Prerequisites** — Confirm the project, check that opengrep and trivy are available
2. **Phase 2: Plan the scan** — Choose what to scan and confirm with the user in plain language
3. **Phase 3: Run code analysis** — Run opengrep, capture findings
4. **Phase 4: Run additional checks** — Run the selected additional scanners (packages, secrets, licenses — whichever the user chose)
5. **Phase 5: Summarize results** — Build a unified findings list and the HTML report
6. **Phase 6: Present and next steps** — Show the report, record usage, suggest fixes

## Task Tracking

Create tasks in two batches. Mark each `in_progress` when you start and `completed` when you are done.

**Batch 1 — create at the start of Phase 1:**

| Task subject | activeForm |
|--------------|------------|
| Check prerequisites | Checking prerequisites |

Only this one task. Do not create any other tasks until Phase 1 completes and tool availability is known.

**Batch 2 — create after Phase 1 completes** (once tool availability is known):

| Task subject | activeForm |
|--------------|------------|
| Plan the scan | Planning the scan |

**Batch 3 — create at the end of Phase 2**, after the user confirms scope. Only create tasks for phases that will actually run:

| Task subject | activeForm | When to create |
|--------------|------------|----------------|
| Run code analysis | Running code analysis | Only if code patterns are selected and the tool is available |
| *(dynamic — see below)* | *(dynamic)* | Only if the user chose any of: packages, secrets, licenses and the tool is available |
| Summarize results | Summarizing results | Always |
| Present and next steps | Presenting findings | Always |

The Phase 4 task subject and activeForm must match what the user selected — for example: `"Check packages"`, `"Check packages and secrets"`, or `"Check packages, secrets, and licenses"`. Do **not** create this task at all if the user opted out of all three.

---

## Phase 1: Prerequisites

### 1.1 Locate the project

Use `Glob` to find `**/powerpages.config.json`. If none is found, tell the user to run `/create-site` first and stop.

### 1.2 Detect opengrep and trivy

Run the prerequisite check script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/check-tools.js"
```

The script prints a JSON object describing which tools are present. Handle the result based on availability:

- **Both available** → continue to Phase 2 with all options.
- **Only opengrep available** → tell the user trivy is missing (show install instructions from `references/tool-install.md`), then continue but restrict Phase 2 to code-pattern checks only. Skip the scope question — go straight to the depth question.
- **Only trivy available** → tell the user opengrep is missing (show install instructions from `references/tool-install.md`), then continue but restrict Phase 2 to packages, secrets, and licenses only. Skip both questions — use default severity and proceed to confirmation.
- **Neither available** → show install instructions for both tools from `references/tool-install.md` and **stop**.

### 1.3 Detect data-only mode

If `$ARGUMENTS` contains `--data-only <out-dir>`, remember the output directory. In data-only mode the skill writes the findings JSON to that directory and skips the HTML rendering and browser-open steps. This lets the `security-review` skill aggregate findings into one consolidated report.

---

## Phase 2: Plan the scan

Use `AskUserQuestion` with **plain language only** — never use words like SAST, CVE, dependency, opengrep, trivy, or lockfile.

**IMPORTANT:** Each question below is a **separate** `AskUserQuestion` call. Do NOT combine them into one multi-step form. Wait for the user's answer to one question before deciding whether to ask the next.

The questions in this phase adapt to which tools are available (determined in Phase 1):

### When both tools are available

**Step 1 — ask scope:** Use the structured `questions` array. Each option MUST include `description` and `preview`. The `preview` renders as a card panel the user reads while choosing. Keep `label` to **1-5 words only** — long labels wrap and look broken. Put "(Recommended)" in `description`, never in `label`.

```json
{
  "questions": [{
    "question": "What do you want to check?",
    "header": "Scope",
    "multiSelect": false,
    "options": [
      {
        "label": "Everything",
        "description": "Runs all checks — code, packages, secrets, and licenses. (Recommended)",
        "preview": "Runs two tools back to back:\n\n1. Code pattern scan — checks your source files against hundreds of known risky patterns (unsafe rendering, weak crypto, missing input checks). You will be asked to pick a depth (basic or advanced).\n\n2. Package, secret, and license scan — checks every installed library for known vulnerabilities, scans source files for hard-coded passwords or API keys, and flags packages with restrictive licenses.\n\nTypically finishes in under a minute for small projects; larger ones may take a few minutes."
      },
      {
        "label": "Code patterns only",
        "description": "Scans source files for risky code. Skips packages, secrets, and licenses.",
        "preview": "Runs the code pattern scanner against your source files using a ruleset of hundreds of known risky patterns — unsafe rendering, weak crypto, missing input checks, and more.\n\nYou will be asked to pick a depth next (basic or advanced). The basic scan uses the OWASP Top Ten ruleset covering the most common web security issues.\n\nDoes not check installed libraries, hard-coded secrets, or licenses."
      },
      {
        "label": "Packages, secrets, licenses",
        "description": "Checks libraries, secrets, and licenses. Skips code patterns.",
        "preview": "Runs three checks in one pass:\n\n• Package vulnerabilities — compares every installed library against a database of known security issues, updated daily.\n• Hard-coded secrets — scans source files for passwords, API keys, or tokens that should not be in code.\n• License compliance — flags packages with restrictive licenses (e.g., GPL) that may conflict with your project.\n\nUsually finishes in seconds. Does not look at code patterns."
      },
      {
        "label": "Let me pick",
        "description": "Choose exactly which checks to run.",
        "preview": "Pick from four individual checks:\n\n• Code patterns — risky code like unsafe rendering or weak crypto (uses opengrep with OWASP rulesets)\n• Package vulnerabilities — known issues in installed libraries\n• Hard-coded secrets — passwords, tokens, or keys left in source files\n• License compliance — packages with restrictive licenses\n\nYou can combine any of these."
      }
    ]
  }]
}
```

If the user picks **Let me pick**, make a **separate** `AskUserQuestion` call (same structured format with short labels, `description`, and `preview` on each option) for the individual check types.

**Step 2 — ask depth** (a separate `AskUserQuestion` call, ONLY if code patterns are included in the scope answer above):

```json
{
  "questions": [{
    "question": "How wide should the code check be?",
    "header": "Depth",
    "multiSelect": false,
    "options": [
      {
        "label": "Basic",
        "description": "OWASP Top Ten coverage. Good balance. (Recommended)",
        "preview": "Uses the OWASP Top Ten ruleset — covers the ten most exploited web vulnerability categories (injection, broken access control, security misconfiguration, etc.).\n\nGood balance of speed and coverage. Flags medium severity and above from package checks.\n\nBest choice for most projects."
      },
      {
        "label": "Advanced",
        "description": "Full security audit ruleset. Slowest.",
        "preview": "Uses the full security audit ruleset — the most comprehensive set of patterns, including low-severity and informational findings.\n\nFlags everything from package checks, including low-severity issues and license warnings. May take several minutes on larger projects.\n\nBest when preparing for a release or a security review."
      }
    ]
  }]
}
```

If the user's scope answer does **not** include code patterns, **skip this question entirely** — do not ask it. Default the trivy severity to `MEDIUM,HIGH,CRITICAL`.

### When only the code-pattern tool is available

Skip the scope question — code patterns are the only option. Ask only the depth question (same structured format as Step 2 above).

### When only the package/secret/license tool is available

Skip both questions — there is nothing to choose. Default to all three scanners (`vuln,secret,license`) with basic-level severity (`MEDIUM,HIGH,CRITICAL`). Go straight to the confirmation step.

### Confirmation (always)

Show the user a one-line plan and ask: "Ready to run the check?" with options `Yes, run it` / `Change something`.

**Map the answers to:**

- Code patterns yes/no → run opengrep (only if available)
- Package vulnerabilities yes/no → include `vuln` in trivy `--scanners` (only if available)
- Hard-coded secrets yes/no → include `secret` in trivy `--scanners` (only if available)
- License compliance yes/no → include `license` in trivy `--scanners` (only if available)
- If none of the trivy scanners are selected, skip trivy entirely
- Depth (when asked) → opengrep ruleset (`p/owasp-top-ten` for basic, `p/security-audit` for advanced) and trivy severity floor (`MEDIUM,HIGH,CRITICAL` for basic; `LOW,MEDIUM,HIGH,CRITICAL` for advanced)

Show the user a one-line plan and ask `AskUserQuestion`: "Ready to run the check?" with options `Yes, run it` / `Change something`.

---

## Phase 3: Run code analysis

Skip this phase if the user opted out of code analysis.

Code scans can take several minutes on larger projects. Run the script in the background and monitor its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/run-opengrep.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --ruleset "<chosen_ruleset>" \
  --output "<TEMP_DIR>/opengrep.json"
```

The script returns a normalized JSON list. Each entry has `severity`, `title`, `location`, `details`, and a remediation suggestion. Read the output file when the script completes.

If opengrep exits non-zero, treat it as a single `info` finding with the captured stderr message — do not abort the whole scan.

---

## Phase 4: Run package, secret, and license check

Skip this phase if the user opted out of package analysis.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/run-trivy.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --severity "<chosen_severity>" \
  --output "<TEMP_DIR>/trivy.json"
```

By default the script scans for dependency vulnerabilities, hard-coded secrets, and license compliance issues. Each finding includes a `category` field (`vulnerability`, `secret`, or `license`) so they can be grouped in the report. To narrow the scan, pass `--scanners` with a comma-separated subset (e.g., `--scanners vuln,secret`).

Read the file when the script completes. If no lockfiles or source files produce findings, the script returns an empty list — record an `info` finding noting that nothing was found.

---

## Phase 5: Summarize results

### 5.1 Combine findings

Read the JSON outputs from Phase 3 and Phase 4. Build a single findings list using these severity buckets, mapping the underlying tool's labels:

| Bucket | Maps from |
|--------|-----------|
| `critical` | opengrep `ERROR`, trivy `CRITICAL` (any category) |
| `warning` | opengrep `WARNING`, trivy `HIGH` (any category) |
| `info` | opengrep `INFO`, trivy `MEDIUM`, `LOW`, `UNKNOWN` |
| `pass` | (only used when a phase was opted out — record one entry per skipped phase) |

For each finding, write a one-sentence `reasoning` explaining the risk in plain language and a `fix` describing what to change. Use the agent's own knowledge of the rule or advisory — do not just copy the tool's raw text.

### 5.2 Write data file

Write the merged data to `<TEMP_DIR>/code-scan-data.json` with these keys:

- `REPORT_TITLE` — `"Code & Package Scan"`
- `REPORT_DESC` — short description naming the project and the scan width
- `SITE_NAME` — site name from `powerpages.config.json` or the folder name
- `SUMMARY` — 2–3 sentences describing what was scanned and the headline result
- `FINDINGS_DATA` — array of finding objects: `{ id, severity, title, tag?, location?, details?, reasoning, fix }`
- `DETAILS_DATA` — `{ label: 'Tools used', kind: 'kv', entries: [{ key: 'opengrep', value: '<version>' }, { key: 'trivy', value: '<version>' }, { key: 'Ruleset', value: '<ruleset>' }, { key: 'Trivy scanners', value: '<vuln,secret,license>' }, { key: 'Severity floor', value: '<severity>' }] }`

If running in **data-only mode**, write the data file to `<DATA_ONLY_DIR>/manage-code-scan.json` and stop here. Do **not** render or open the HTML.

### 5.3 Render HTML report

Pick an output path under `<PROJECT_ROOT>/docs/`:

- Default: `code-scan.html`
- If that file already exists, append a date suffix (e.g., `code-scan-2026-04-29.html`)

Render the report:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-scan-report.js" \
  --output "<OUTPUT_PATH>" \
  --data "<TEMP_DIR>/code-scan-data.json"
```

Delete the temporary data file when the script succeeds.

---

## Phase 6: Present and next steps

### 6.1 Open in browser

Open the generated HTML in the user's default browser.

### 6.2 Record skill usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "ManageCodeScan"`.

### 6.3 Summarize and offer follow-ups

Show a short summary in plain language: total checks run, number of critical / warning / info findings, where the report is saved.

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Do you want help fixing anything? | Yes, walk me through the critical items; Not now, I will read the report first |

If the user wants help, group the critical findings, explain the first one in plain language, and propose an edit to fix it. Do not auto-apply fixes — confirm each change.

---

## Constraints

- **Read-only by default** — fix proposals require explicit user confirmation before any edit.
- **Do not install tools** — if opengrep or trivy is missing, stop and point the user to `references/tool-install.md`.
- **Plain language with users** — never lead with words like SAST, CVE, regex, AST, or transitive dependency. Explain the concept when the user asks.
- **Background long-running tools** — opengrep and trivy may take minutes on real projects; run them via `Bash` with `run_in_background: true` and read the output once they finish.
- **Never log access tokens or secrets** — both opengrep and trivy can flag suspected secrets; quote the file and line number, never the secret value itself.

## References

- `references/commands.md` — flags, exit codes, and JSON output shape for the scan scripts
- `references/tool-install.md` — official install instructions for opengrep and trivy
