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

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Scan Code

Scan a Power Pages site project's source files and dependencies for security issues. Runs opengrep (static analysis) and trivy (dependency/secret/license scanning), then surfaces findings.

**Initial request:** $ARGUMENTS

## Gotchas

- **Both tools must be installed.** Run `check-tools.js` to verify. If either is missing, offer an agent-driven review fallback (see Step 1.2).
- **Opengrep exits 1 when findings exist.** This is normal behavior, not an error — the script handles it.
- **Large output.** Both tools can produce large JSON for big projects. The scripts normalize the output into a flat findings list.
- **Trivy severity flag only affects vulnerability findings.** Secrets and license findings are always returned regardless of the `--severity` flag.
- **Secrets are never shown in full — anywhere.** Whenever **you** read source directly (the agent-driven review) or present a finding, use your judgment to recognize any credential — API keys, tokens, passwords, connection strings, private keys, or any other secret shape (there is no fixed list). Never output its raw value **anywhere** — your context, the session, chat, logs, a summary, the report, or any other output — not even partially; where a value would otherwise be shown, replace it with a mask (e.g. `********`).

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

Use `Glob` to find `**/powerpages.config.json`. If `$ARGUMENTS` contains `--review <out-dir>`, remember the output directory — Step 2 is skipped (run all checks at Advanced depth), and Step 4 writes JSON only.

### 1.2 Check tool availability

```bash
node "${PLUGIN_ROOT}/skills/scan-code/scripts/check-tools.js"
```

If either tool is missing, tell the user which tool is missing. Then offer an agent-driven review as a fallback:

**In review mode (non-interactive), do not offer the agent-driven review.** It needs an interactive opt-in, and the orchestrator expects a JSON file. Write `{ "status": "skipped", "reason": "<which tool> is not installed" }` to `<REVIEW_DIR>/scan-code.json` and stop.

<!-- gate: scan-code:1.agent-review-fallback | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · scan-code:1.agent-review-fallback):** When a scanning tool is missing, offer the agent-driven review as a fallback before doing any work. It reads the source with `Glob`/`Read`/`Grep` and has high token consumption, so the user must opt in.
>
> **Trigger:** Step 1.2, only when `check-tools.js` reports a missing tool (interactive mode only — review mode never reaches here because it stops when tools are missing).
> **Why we ask:** Auto-starting the agent-driven review burns a large amount of tokens without consent; the user may prefer to install the tool and re-run instead.
> **Cancel leaves:** Nothing — no files read, no scan run.

**Framing — all user-facing text (the warning, any `AskUserQuestion` option labels, and the summary): MUST NOT call this a "manual review".** It is agent-driven — describe it as *you reviewing the code yourself*, e.g., "I can look through your code directly and flag issues."

Warn the user that this review reads many files and uses a large amount of tokens, then detect the git context:
- **Feature branch** (not `main`, `master`, or equivalent): offer to review only the changes in the current branch (`git diff <main-branch>...HEAD`).
- **Main/master branch or no git repo**: offer to review the entire project source.

If the user accepts, use `Glob` + `Read` + `Grep` to review the relevant files for common security patterns (hard-coded secrets, unsafe API usage, missing input validation, exposed endpoints, etc.) and present findings. **Never surface a secret value anywhere** — never output a credential's raw value in any output (your context, the session, chat, logs, etc.), not even partially; where a value would otherwise be shown, replace it with a mask (e.g. `********`). Do not attempt to install the tools.

---

## 2. Choose scope

Skip in **review mode** — run both tools at Advanced depth.

### Scope selection

Ask the following in order. Each is a **separate** `AskUserQuestion` call — do NOT combine. If the user's initial request already answers a question, skip it and move to the next.

<!-- gate: scan-code:2.scope-choice | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · scan-code:2.scope-choice):** Choose what to scan — code, packages, or both — before running any tool. Determines which scanners run.
>
> **Trigger:** Phase 2 entry (interactive mode only — review mode scans everything at Advanced depth without asking). Skipped if the initial request already names the scope.
> **Why we ask:** Auto-scanning everything can run tools the user did not want (e.g., a slow code pass when they only asked about packages); the wrong scope produces a report that misses what they cared about.
> **Cancel leaves:** Nothing — no scanner has run.

**Question 1 — What to check?**

| Label | Description |
|-------|-------------|
| Everything | Check both code and packages. (Recommended) |
| Code only | Check source files for security problems. |
| Packages only | Check installed packages for known issues. |

<!-- gate: scan-code:2.depth-choice | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · scan-code:2.depth-choice):** Choose how thorough the code check is. Only asked when code checking is included.
>
> **Trigger:** Phase 2, after the scope choice includes code (interactive mode only). Skipped if the initial request already names the depth or code checking was excluded.
> **Why we ask:** The thorough option runs a deeper rule set that takes longer; auto-picking it can slow a large project unexpectedly, while auto-picking the quick option can silently skip weaknesses the user expected to catch.
> **Cancel leaves:** Nothing — no scanner has run.

**Question 2 — Only if code checking is included: How thorough?**

| Label | Description |
|-------|-------------|
| Advanced | Covers common risks and deeper code weaknesses. (Recommended) |
| Basic | Covers common risks only. |

Depth mapping (internal, not shown to user): Advanced = `p/default,p/owasp-top-ten,p/cwe-top-25`. Basic = `p/default,p/owasp-top-ten`.

### Custom rules

Both tools accept custom rules. Do not proactively offer — only use when the user provides them.

- **Opengrep**: `--rulesets` accepts comma-separated registry packs and local file paths. Custom rulesets are appended to the depth's defaults, not replacing them.
- **Trivy**: `--secretConfig` for custom secret detection patterns, `--ignoreFile` for suppressing known findings, `--trivyConfig` for license classification and other settings, `--no-licenseFull` to skip source-level license scanning for faster runs.

---

## 3. Run scans

Save each tool's **raw** JSON output to a temporary file. The transform script in Step 4 normalizes them.

### Static analysis (opengrep)

```bash
node "${PLUGIN_ROOT}/skills/scan-code/scripts/run-opengrep.js" --projectRoot "<PROJECT_ROOT>" --rulesets "<comma-separated-rulesets>" > "<TEMP_DIR>/opengrep.json"
```

Pass the rulesets for the chosen depth (Basic or Advanced). Append any user-provided custom rulesets. Run with `run_in_background: true` for large projects.

### Dependency / secret / license scanning (trivy)

```bash
node "${PLUGIN_ROOT}/skills/scan-code/scripts/run-trivy.js" --projectRoot "<PROJECT_ROOT>" > "<TEMP_DIR>/trivy.json"
```

`--licenseFull` is on by default — source code headers and LICENSE files are scanned alongside package metadata. Run with `run_in_background: true` for large projects.

### Normalize

```bash
node "${PLUGIN_ROOT}/skills/scan-code/scripts/transform-scan-code.js" --opengrepFile "<TEMP_DIR>/opengrep.json" --trivyFile "<TEMP_DIR>/trivy.json" --projectRoot "<PROJECT_ROOT>"
```

Pass only the files for tools that actually ran. Stdout has the unified `{ status, findings }` shape.

---

## 4. Summarize

### 4.1 Review mode

In **review mode**, write the `transform-scan-code.js` stdout to `<REVIEW_DIR>/scan-code.json`. Then stop — the orchestrating skill handles presentation.

### 4.2 Render HTML report

Skip in **review mode**.

Render uses the same shared template as the consolidated security review. First write the Step 3 Normalize stdout to `<TEMP_DIR>/scan-code.json`, then build a single-section review-data payload and render:

```bash
node "${PLUGIN_ROOT}/scripts/build-review-data.js" \
  --reportName "Code Scan" \
  --inputDir "<TEMP_DIR>" \
  --siteName "<SITE_NAME>" \
  --goalLabel "Code & Packages scan" \
  --scopeLabel "<SCOPE_LABEL>" \
  --summary "<SUMMARY_TEXT>" \
  --output "<TEMP_DIR>/data.json"

node "${PLUGIN_ROOT}/scripts/render-review.js" \
  --data "<TEMP_DIR>/data.json" \
  --output "<PROJECT_ROOT>/docs/code-scan-<YYYY-MM-DD-HHMMSS>.html"
```

`<TEMP_DIR>` also holds the intermediate `opengrep.json`/`trivy.json` from Step 3 alongside `scan-code.json`; `build-review-data.js` reads only `scan-code.json` and ignores the rest. The filename **must** include the local timestamp (e.g., `code-scan-2026-05-14-053805.html`). Delete `<TEMP_DIR>` after the render succeeds. Open the rendered HTML in the browser.

### 4.3 Present summary

Skip in **review mode**.

Plain-language summary: total findings, count by category (code patterns, vulnerable packages, secrets, licenses), and what the user should look at first.

### 4.4 Record skill usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`
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

- **Plain language** — MUST NOT use technical jargon with the user. Never use words like opengrep, trivy, OWASP, CWE, static analysis, SAST, or ruleset in user-facing text. Use everyday language like "check your code for security problems", "check your packages for known issues", "thorough check", "quick check". Explain the technical name only when the user asks. For the tool-missing fallback, MUST NOT call it a "manual review" — it is agent-driven; describe it as you reviewing the code yourself.
- **Background long-running calls** — run both tools via `run_in_background: true` for large projects.
- **Context-aware interactions** — recommendations MUST reflect the site's actual scan results. Do not present generic advice.
- **Recommendations MUST NOT break the site** — when suggesting fixes for code findings, verify that the fix does not introduce regressions.
- **NEVER recommend broadening security** — if a finding suggests tightening (e.g., removing a hard-coded secret), do not suggest keeping it for convenience.
- **NEVER disclose a secret value** — Never output, log, store, or repeat a raw secret anywhere, not even partially or when a regex/grep matches it. Identify a secret finding by its type, file, and line — not its value. Masking (e.g. `********`) applies only where a secret value would otherwise be shown; you are not required to display it.

## References

- `references/commands.md` — script flags and response shapes. Read when constructing script invocations.
