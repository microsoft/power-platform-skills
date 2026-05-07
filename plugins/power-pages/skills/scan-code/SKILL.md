---
name: scan-code
description: >-
  Scans a Power Pages site project for security issues in source code and
  dependencies. Runs static analysis and dependency scanning, then surfaces
  findings by category (code patterns, vulnerable packages, secrets, license
  issues). Use when the user wants to review code for security problems,
  check for vulnerable packages, find hard-coded secrets, run a code scan,
  or asks "is my code safe?", "check my dependencies", "find security
  issues in my source" — even if they say "audit my code" without
  mentioning specific tools.
user-invocable: true
argument-hint: "[optional: --review <out-dir>]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Scan Code

Scan a Power Pages site project's source files and dependencies for security issues. Runs opengrep (static analysis) and trivy (dependency/secret/license scanning), then surfaces findings.

**Initial request:** $ARGUMENTS

## Gotchas

- **Both tools must be installed.** Run `check-tools.js` to verify. If either is missing, offer a manual review fallback (see Step 1.2).
- **Opengrep exits 1 when findings exist.** This is normal behavior, not an error — the script handles it.
- **Large output.** Both tools can produce large JSON for big projects. The scripts normalize the output into a flat findings list.
- **Trivy severity flag only affects vulnerability findings.** Secrets and license findings are always returned regardless of the `--severity` flag.

## Workflow

1. **Prerequisites** — Locate project, check tool availability
2. **Choose scope** — What to scan and at what depth
3. **Run scans** — Execute tools, capture results
4. **Summarize** — Present findings, record usage, offer follow-ups

## Task Tracking

Create tasks in three groups. Mark each `in_progress` when starting, `completed` when done.

| Group | When to create | Tasks |
|-------|----------------|-------|
| 1 | At start | Check prerequisites |
| 2 | After prerequisites pass | Choose scope (skip in review mode) |
| 3 | After scope is decided (or in review mode) | Run scans · Summarize (always) |

---

## 1. Prerequisites

### 1.1 Locate the project, detect review mode

Use `Glob` to find `**/powerpages.config.json`. If `$ARGUMENTS` contains `--review <out-dir>`, remember the output directory — Step 2 is skipped (run all checks at default depth), and Step 4 writes JSON only.

### 1.2 Check tool availability

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-code/scripts/check-tools.js"
```

If either tool is missing, tell the user which tool is missing. Then offer a manual review as a fallback:

Warn the user that manual review has high token consumption, then detect the git context:
- **Feature branch** (not `main`, `master`, `develop`, or equivalent): offer to review only the changes in the current branch (`git diff main...HEAD`).
- **Main/master branch or no git repo**: offer to review the entire project source.

If the user accepts the manual review, use `Glob` + `Read` + `Grep` to scan the relevant files for common security patterns (hardcoded secrets, unsafe API usage, missing input validation, exposed endpoints, etc.) and present findings. Do not attempt to install the tools.

---

## 2. Choose scope

Skip in **review mode** — run both tools at Basic depth.

### Scan depth (opengrep)

| Depth | Rulesets | When to use |
|-------|---------|-------------|
| Basic | `p/default,p/owasp-top-ten` | Default. Fast iteration during development. |
| Advanced | `p/default,p/owasp-top-ten,p/cwe-top-25` | Deeper analysis before release. |

Recommend Basic unless the user asks for a thorough or advanced scan.

### Custom rulesets (Bring Your Own Rules)

Both tools accept custom rules:
- **Opengrep**: pass additional rulesets via `--rulesets` (comma-separated). Accepts registry packs and local file paths. Custom rulesets are appended to the depth's default set.
- **Trivy**: pass custom policy paths via `--policyPaths` (comma-separated). Accepts local directories or files.

If the user provides custom rulesets, append them to the selected depth — do not replace the defaults.

### Default approach

Recommend a full scan (both opengrep and trivy) at Basic depth unless the user asks for something different. The user can narrow the scope, change depth, or add custom rules.

### Option rules

When presenting options via `AskUserQuestion`:
- Keep `label` to 1–5 words. Include `description` on every option.
- Only show options that are actionable.

---

## 3. Run scans

Run the selected tools. Both scripts output normalized JSON to stdout.

### Static analysis (opengrep)

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-code/scripts/run-opengrep.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --rulesets "<comma-separated-rulesets>"
```

Pass the rulesets for the chosen depth (Basic or Advanced). Append any user-provided custom rulesets. Run with `run_in_background: true` for large projects.

### Dependency / secret / license scanning (trivy)

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-code/scripts/run-trivy.js" \
  --projectRoot "<PROJECT_ROOT>"
```

If the user provided custom trivy policies, add `--policyPaths <comma-separated-paths>`. Run with `run_in_background: true` for large projects.

Parse each tool's stdout JSON. The `findings` array in each result contains normalized objects with `id`, `severity`, `title`, `location`, `tag`, `details`, and optionally `fix` and `category`.

---

## 4. Summarize

### 4.1 Review mode

In **review mode**, write `<REVIEW_DIR>/scan-code.json` with:

- `REPORT_TITLE` — `"Code & Dependency Scan"`
- `REPORT_DESC` — short description naming the site
- `SITE_NAME` — site display name
- `SUMMARY` — 2–3 sentences in plain language
- `FINDINGS_DATA` — merged findings from both tools. Use the severity values from the tool output directly.
- `DETAILS_DATA` — `{ label: 'Scan details', kind: 'kv', entries: [{ key: 'Opengrep version', value: '<version>' }, { key: 'Trivy version', value: '<version>' }, { key: 'Files scanned', value: '<count>' }] }`

Then stop — the orchestrating skill handles presentation.

### 4.2 Render HTML report

Skip in **review mode**.

Write the merged data JSON to the system temp directory, render via the shared script, then delete the temp file:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-scan-report.js" \
  --data "<system-temp>/code-scan-data.json" \
  --output "<PROJECT_ROOT>/docs/code-scan.html"
```

Delete `<system-temp>/code-scan-data.json` after the render succeeds. Open the rendered HTML in the browser.

### 4.3 Present summary

Skip in **review mode**.

Plain-language summary: total findings, count by category (code patterns, vulnerable packages, secrets, licenses), and what the user should look at first.

For each finding, write a `reasoning` line that explains the issue to a non-technical reader. Use the agent's own knowledge of the rule or advisory — do not just copy the tool's raw text.

### 4.4 Record skill usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "ScanCode"`.

### 4.5 Offer follow-ups

If findings map to other skills, suggest them:
- Header / cookie issues → `/manage-headers`
- WAF / firewall issues → `/manage-firewall`
- Permission issues → `/audit-permissions` to review existing permissions, and/or `/create-webroles` to set up role-based access
- Login or external identity issues → `/setup-auth`
- Code-level issues (exposed debug pages, information leakage) → suggest a manual code fix

If no meaningful follow-up exists, end the skill.

---

## Constraints

- **Plain language** — MUST NOT use technical jargon with the user. Explain findings using everyday language.
- **Background long-running calls** — run both tools via `run_in_background: true` for large projects.
- **Tool output is the source of truth** — use the severity values from the tool output directly. Do not remap or invent severity buckets.
- **Context-aware interactions** — recommendations MUST reflect the site's actual scan results. Do not present generic advice.
- **Recommendations MUST NOT break the site** — when suggesting fixes for code findings, verify that the fix does not introduce regressions.
- **NEVER recommend broadening security** — if a finding suggests tightening (e.g., removing a hard-coded secret), do not suggest keeping it for convenience.

## References

- `references/commands.md` — script flags and response shapes. Read when constructing script invocations.
