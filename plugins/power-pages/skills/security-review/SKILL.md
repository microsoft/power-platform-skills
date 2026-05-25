---
name: security-review
description: >-
  Runs a guided, end-to-end security review of a Power Pages site by
  delegating to the focused security skills (live site scan, browser
  headers, web application firewall, authentication, and table
  permissions) and consolidating every finding into one HTML report.
  Use when the user wants a full security review, a release-readiness
  check before publishing, an access-and-config check during
  development, live site monitoring, or asks open-ended questions like
  "review my site security", "is my site safe to ship", "do a security
  check", "monitor my site" — even if they do not name the individual
  checks.
user-invocable: true
argument-hint: "[optional natural-language hint about the goal]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, Skill, Agent
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Review Security

Guide the user through a full security review of their Power Pages site. Runs the matching focused skills and assembles every finding into a single HTML report.

The skill never asks the user technical questions. The conversation stays in plain language.

**Initial request:** $ARGUMENTS

## High-level flow (the six steps)

The conversation always follows the same six steps. Each step maps to a row in the workflow table below.

1. **Ask the goal** — one question, three answers, plain language
2. **Confirm and start** — show a one-line plan, give the user a chance to back out
3. **Scan in progress** — run the matching skills, surface progress
4. **Results summary** — totals across all findings
5. **Findings and remediation** — group findings by section, offer to fix
6. **Next steps and guidance** — concrete recommendations, link the next action

## Workflow

| Step | What happens | Maps to |
|------|--------------|---------|
| 1 — Prerequisites | Prerequisites and working folders | (setup) |
| 2 — Scope | Capture goal | Step 1 |
| 3 — Confirm | Confirm the plan | Step 2 |
| 4 — Skills | Run the matching skills | Step 3 |
| 5 — Report | Build the consolidated report | Steps 4 and 5 |
| 6 — Present | Present and offer follow-ups | Step 6 |
| 7 — Cleanup | Clean up temporary files | (closing) |

## Task Tracking

Create tasks in three groups. Mark each `in_progress` when starting, `completed` when done.

**Group 1 — create at the start of prerequisites:**

| Task subject | activeForm |
|--------------|------------|
| Check prerequisites | Checking prerequisites |

Only this one task. Do not create any other tasks until prerequisites complete.

**Group 2 — create after prerequisites complete:**

| Task subject | activeForm |
|--------------|------------|
| Capture goal | Capturing goal |
| Confirm the plan | Confirming the plan |

**Group 3 — create after the user confirms the plan:**

| Task subject | activeForm |
|--------------|------------|
| Run skills | Running checks |
| Build the report | Building the report |
| Present findings | Presenting findings |
| Clean up | Cleaning up |

---

## 1. Prerequisites

### 1.1 Locate the project

Use `Glob` to find `**/powerpages.config.json`. If none is found, tell the user the site needs to be created first with `/create-site`, then stop.

For the `monitor` and `release` goals (any goal that delegates to `scan-site` or `manage-firewall`), also confirm that `.powerpages-site/website.yml` exists. If it does not, the site has not been deployed yet — tell the user (in plain language) the site needs to be deployed once before a live security review can run, recommend `/deploy-site`, then stop. Do **not** try to identify the site by name or URL — different sites can share the same name.

For the `access-config` goal, the deploy check is not required: authentication, web roles, and table permissions are read from local YAML alone.

### 1.2 Prepare a temporary working folder

Create a fresh working directory: `<SYSTEM_TEMP>/security-review/`. The folder holds JSON data files emitted by each skill in **review mode**. The folder is removed in the cleanup step.

If the folder already exists from a previous interrupted run, delete its contents (not the folder itself) before continuing.

### 1.3 Determine the docs output path

The final HTML always lives at `<PROJECT_ROOT>/docs/security-review-<YYYY-MM-DD-HHMMSS>.html` using the local timestamp at the start of the run (e.g. `security-review-2026-05-14-053805.html`). Always include the timestamp — do not use a bare `security-review.html` name. This keeps each run's report distinct.

---

## 2. Capture goal

### 2.1 Ask the goal

Ask the user with a single `AskUserQuestion` call. If the user's initial request already answers it, skip and continue.

**Question — What to review?**

| Label | Description |
|-------|-------------|
| Access & config | Check authentication, web roles, and table permissions. Works on local files only. |
| Release readiness | Full review before publishing — checks everything. (Recommended) |
| Deployed site | Check the live site for issues. Requires deployment. |

Goal mapping (internal):

| Label | Goal id | Skills |
|-------|---------|------------|
| Access & config | `access-config` | audit-permissions, setup-auth (read-only) |
| Release readiness | `release` | scan-site, manage-headers, manage-firewall, audit-permissions, setup-auth (read-only) |
| Deployed site | `monitor` | scan-site |

### 2.2 Capture the chosen skill set

Build a `selectedSkills` list based on the answer. Always include the read-only check of `setup-auth` for the `access-config` and `release` goals (it consists of reading existing YAML, not running the skill itself — see § 4.2 below). This is the **Access & Data Security Validation** component.

---

## 3. Confirm the plan

Tell the user, in plain language, what will run and the rough time it will take. Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| I will <one-line description>. Continue? | Yes, run it (Recommended); Change the plan |

When the user confirms, mark the **Run skills** task `in_progress` and continue.

---

## 4. Run the matching skills

Spawn each selected skill as a background subagent via the `Agent` tool. Each subagent invokes its skill with the argument `--review <SYSTEM_TEMP>/security-review/`. Each skill handles its own authentication, error reporting, and progress.

### 4.1 Skill invocation via subagents

Skills run as **parallel subagents** using the `Agent` tool. Launch the long-running scan first so it gets a head start, then launch the remaining checks immediately after.

**Wave 1 — long-running scan (launch first):**

Spawn a background subagent for `scan-site` (when selected). This skill takes the most time and benefits from an early start.

**Wave 2 — remaining checks (launch immediately after Wave 1):**

Spawn background subagents for the remaining selected skills (`manage-headers`, `manage-firewall`, `audit-permissions`). When the goal only includes Wave 1 skills, skip this wave.

**Launch all waves together when possible.** Spawn all Wave 1 and Wave 2 subagents in a single message with multiple `Agent` tool calls so they start concurrently.

**Inline checks (run while subagents work):**

While subagents run, perform the read-only check for `setup-auth` inline (see 4.4).

Wait for all subagents to complete before proceeding to the report-building step.

### 4.1.1 Subagent prompt pattern

Each subagent receives a self-contained prompt that includes:

1. The skill to invoke and the `--review` argument with the temp directory path
2. The project root path so the skill can locate site files
3. Any scope/depth parameters captured in the scope capture step

Example subagent call:

```
Agent({
  description: "Run scan-site",
  prompt: "Invoke the skill `scan-site` with argument `--review <SYSTEM_TEMP>/security-review/`. The Power Pages project root is <PROJECT_ROOT>. <any additional scope parameters>. Write the **transform script stdout verbatim** to <SYSTEM_TEMP>/security-review/scan-site.json. Do NOT synthesize, augment, or re-classify the findings. If the skill fails, write { \"status\": \"skipped\", \"reason\": \"<plain-language reason>\" } instead.",
  run_in_background: true
})
```

**Verbatim rule:** the subagent's output JSON must contain only the findings emitted by the skill's transform script. The orchestrator must not append findings, rewrite titles, add severity, or otherwise editorialize.

### 4.1.2 Expected output

After all subagents complete, expect JSON files at `<SYSTEM_TEMP>/security-review/<skill-name>.json`. Each file has the shape `{ status, findings, details? }` produced by the skill's transform script:

```text
<SYSTEM_TEMP>/security-review/
├── scan-site.json
├── manage-headers.json
├── manage-firewall.json
└── audit-permissions.json   (when invoked)
```

If a skill's subagent fails or is skipped, write a placeholder file with shape `{ "status": "skipped", "reason": "<plain-language reason>" }` so the report-building step can render it as a single `info` finding for that section.

### 4.1.3 Severity policy

Only findings that come from a tool that genuinely outputs severity may carry a `severity` field:

| Section | Source | Severity allowed? |
|---------|--------|-------------------|
| `scan-site` | deep-scan (ZAP) | Yes |
| `manage-headers` | `transform-headers.js` (inventory) | **No** |
| `manage-firewall` | `transform-firewall.js` (inventory) | **No** |
| `audit-permissions` | LLM audit | **No** |
| `setup-auth` | YAML inspection | **No** |

For inventory sections, do **not** add `severity` to findings — not even `info`. The subagent and orchestrator must write the transform output **verbatim** without inserting opinionated severity-bearing findings.

### 4.1.4 Annotations policy (plain-language text)

The transform scripts for `manage-firewall` and `manage-headers` produce only structured raw data — they do **not** hardcode plain-language descriptions. The subagent must generate an annotations JSON file and pass it to the transform via `--annotations`. The annotations supply:

- Plain-language description per rule / per header
- Optional suggested fix when a genuine issue is present

See each skill's `SKILL.md` § 5.1 for the annotation file shape. The agent's job is to write accurate, terse descriptions based on the raw data — not to invent severities or fabricate issues.

### 4.2 Skills without `--review` mode

`audit-permissions` and `setup-auth` do not support `--review`. Handle them inline (not as background subagents):

- **audit-permissions** — invoke via the `Skill` tool (not `Agent`). The skill audits **both web roles and table permissions** — capture both in its output. After it completes, read its output and write `<SYSTEM_TEMP>/security-review/audit-permissions.json` in the unified `{ status, findings, details? }` shape (mapping each audit finding into the common finding fields: `id`, `title`, `tag`, `location`, `details`, `fix`). **Do NOT include a `severity` field** — audit-permissions findings are inventory, not tool-output severities.
- **setup-auth** — do not invoke as a skill. Instead, read `.powerpages-site/site-settings/` YAML files directly and check for:
  - identity provider configured? (`Authentication/OpenIdConnect/*/Authority`)
  - profile redirect disabled? (`Authentication/Registration/ProfileRedirectEnabled = false`)
  - cookie SameSite setting? (`HTTP/SameSite/Default`)

Write the resulting findings to `<SYSTEM_TEMP>/security-review/setup-auth.json` in the same format. **Do NOT include a `severity` field** on these findings — see § 4.1.3.

### 4.3 Status updates

Tell the user that all checks are running in parallel. As each subagent completes, give a short progress line (e.g., "Code check finished — 2 important issues, 4 smaller ones."). Avoid technical jargon. Do not narrate skill internal steps. Once all subagents have finished, confirm that all checks are complete before moving to the report-building step.

---

## 5. Build the consolidated report

### 5.1 Consolidate

Write up to four plain-language next-step recommendations as a JSON string array to `<SYSTEM_TEMP>/security-review/next-steps.json`. Compose a 2–4 sentence plain-language `summary` of the overall state.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-review-data.js" \
  --reportName "Security Review" \
  --inputDir "<SYSTEM_TEMP>/security-review/" \
  --siteName "<SITE_NAME>" \
  --goalLabel "<GOAL_LABEL>" \
  --scopeLabel "<SCOPE_LABEL>" \
  --summary "<SUMMARY_TEXT>" \
  --nextStepsFile "<SYSTEM_TEMP>/security-review/next-steps.json" \
  --output "<SYSTEM_TEMP>/security-review/security-review-data.json"
```

### 5.2 Render the master HTML

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-review.js" \
  --output "<DOCS_PATH>" \
  --data "<SYSTEM_TEMP>/security-review/security-review-data.json"
```

---

## 6. Present and follow-ups

### 6.1 Open in browser

Open `<DOCS_PATH>` in the user's default browser.

### 6.2 Record skill usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "SecurityReview"`.

### 6.3 Step 7 summary

Show a short plain-language summary in the chat: counts of critical / warning / info findings, where the report lives. Then offer the next action with `AskUserQuestion`:

| Question | Options |
|----------|---------|
| What would you like to do next? | Walk me through the fixes; Re-run the review; Done for now |

If the user picks "walk me through", group critical findings by section and offer the matching focused skill for each (`/manage-headers`, `/manage-firewall`, `/audit-permissions`, etc.).

If the user picks "re-run", invoke this skill again with the same goal and scope.

---

## 7. Clean up

Delete the entire `<SYSTEM_TEMP>/security-review/` folder. The final HTML, located in `docs/`, must remain. Confirm to the user that temporary files have been removed.

If the cleanup fails (file lock, permission), warn the user and continue — the report is already written and the temp folder can be removed manually later.

---

## Constraints

- **Plain language with users** — never lead with technical terms.
- **Parallel subagent delegation** — skills run as parallel subagents via the `Agent` tool. Launch `scan-site` first (long-running), then the remaining checks immediately after. Perform the inline read-only `setup-auth` check while subagents work.
- **Single consolidated HTML** — never produce per-skill HTML reports during this run. Skills run in `--review` mode.
- **Same look and feel** — use the shared template under `assets/`. The generated report must match the existing audit-permissions report visually.
- **Cleanup is mandatory** — the cleanup step is not optional. Failing to clean up is treated as a non-fatal warning, but the skill always tries.
- **Never run destructive sub-actions automatically** — skills that propose changes (e.g., editing site settings, deleting WAF rules) must operate in read-only `--review` mode during this orchestration. Apply changes only via the explicit "walk me through fixes" follow-up, after the user picks an action.

## References

- `references/flow.md` — the six-step conversation in detail
