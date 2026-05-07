---
name: security-review
description: >-
  Runs a guided, end-to-end security review of a Power Pages site by
  delegating to the focused security skills (code and dependencies, live
  site scan, browser headers, web application firewall, authentication,
  and table permissions) and consolidating every finding into one
  HTML report with a glossary. Use when the user wants a full security
  review, a release-readiness check before publishing, a code scan during
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

Guide the user through a full security review of their Power Pages site. The skill asks one short question to capture the goal, then — for code-and-config — a follow-up to set depth. Release readiness skips the follow-up and runs every check at advanced depth by default. The skill then runs the matching focused skills and assembles every finding into a single HTML report with a built-in glossary so the user never has to switch tabs.

The skill never asks the user technical questions. The conversation stays in plain language; technical names appear in the final report and the glossary explains them.

**Initial request:** $ARGUMENTS

## High-level flow (the seven steps)

The conversation always follows the same seven steps. Each step maps to a row in the workflow table below.

1. **Ask the goal** — one question, three answers, plain language
2. **Choose scope and depth** — one follow-up for code-and-config; release defaults to all checks at advanced depth; monitor skips this step
3. **Confirm and start** — show a one-line plan, give the user a chance to back out
4. **Scan in progress** — run the matching sub-skills, surface progress
5. **Results summary** — totals, top findings
6. **Findings and remediation** — group findings by section, offer to fix
7. **Next steps and guidance** — concrete recommendations, link the next action

## Workflow

| Step | What happens | Maps to |
|------|--------------|---------|
| 1 — Prerequisites | Prerequisites and working folders | (setup) |
| 2 — Scope | Capture goal and scope | Steps 1 and 2 |
| 3 — Confirm | Confirm the plan | Step 3 |
| 4 — Sub-skills | Run the matching sub-skills | Step 4 |
| 5 — Report | Build the consolidated report | Steps 5 and 6 |
| 6 — Present | Present and offer follow-ups | Step 7 |
| 7 — Cleanup | Clean up temporary files | (closing) |

## Task Tracking

Create tasks in three groups. Mark each `in_progress` when you start and `completed` when you are done.

**Group 1 — create at the start of prerequisites:**

| Task subject | activeForm |
|--------------|------------|
| Check prerequisites | Checking prerequisites |

Only this one task. Do not create any other tasks until prerequisites complete.

**Group 2 — create after prerequisites complete:**

| Task subject | activeForm |
|--------------|------------|
| Capture goal and scope | Capturing goal and scope |
| Confirm the plan | Confirming the plan |

**Group 3 — create after the user confirms the plan:**

| Task subject | activeForm |
|--------------|------------|
| Run sub-skills | Running checks |
| Build the report | Building the report |
| Present findings | Presenting findings |
| Clean up | Cleaning up |

---

## 1. Prerequisites

### 1.1 Locate the project

Use `Glob` to find `**/powerpages.config.json`. If none is found, tell the user the site needs to be created first with `/create-site`, then stop.

For the `monitor` and `release` goals (any goal that delegates to `scan-site` or `manage-firewall`), also confirm that `.powerpages-site/website.yml` exists. If it does not, the site has not been deployed yet — tell the user (in plain language) the site needs to be deployed once before a live security review can run, recommend `/deploy-site`, then stop. Do **not** try to identify the site by name or URL — different sites can share the same name.

For the `code-config` goal, the deploy check is not required: code and package scanning works on local source files alone.

### 1.2 Prepare a temporary working folder

Create a fresh working directory: `<PROJECT_ROOT>/.security-review-tmp/`. The folder holds JSON data files emitted by each sub-skill in **review mode**. The folder is removed in the cleanup step.

If the folder already exists from a previous interrupted run, delete its contents (not the folder itself) before continuing.

### 1.3 Determine the docs output path

The final HTML lives at `<PROJECT_ROOT>/docs/security-review.html`. If that file already exists, append a date suffix (`security-review-2026-04-29.html`).

---

## 2. Capture goal and scope

**IMPORTANT:** Each question below is a **separate** `AskUserQuestion` call. Do NOT combine them into one multi-step form. Wait for the user's answer to one question before deciding whether to ask the next.

### 2.1 Step 1 — Ask the goal

Call `AskUserQuestion` using the structured `questions` array. Keep `label` to **1-5 words**. Put "(Recommended)" in `description`, never in `label`. Every option MUST include `description` and `preview`.

```json
{
  "questions": [
    {
      "question": "What would you like to review?",
      "header": "Goal",
      "multiSelect": false,
      "options": [
        {
          "label": "Code and config",
          "description": "Check code, configs, dependencies, and access control.",
          "preview": "Scans code for risky patterns, checks packages, and reviews authentication, roles, and permissions.\n\nWorks entirely on local files. Good for frequent checks during development."
        },
        {
          "label": "Release readiness",
          "description": "End-to-end review before you publish. (Recommended)",
          "preview": "Runs every check: code, packages, secrets, headers, firewall, authentication, permissions, and live site scan.\n\nCovers both local files and the deployed site. Best before going live."
        },
        {
          "label": "Deployed site",
          "description": "Detect issues from real user traffic.",
          "preview": "Scans your deployed site for runtime vulnerabilities, exposed pages, and missing protections.\n\nFocuses on what is happening on your live site right now. Requires deployment."
        }
      ]
    }
  ]
}
```

Map the answer to a goal id:

| Option | Goal id | Sub-skills involved |
|--------|---------|-------------------------------|
| Code and config | `code-config` | scan-code, audit-permissions (and read-only check of setup-auth state) |
| Release readiness | `release` | scan-code, scan-site, manage-headers, manage-firewall, audit-permissions (and read-only check of setup-auth state) |
| Deployed site | `monitor` | scan-site |

### 2.2 Step 2 — Choose scope and depth

Ask one follow-up `AskUserQuestion` that depends on the goal id. Use the same structured format with short labels, `description`, and `preview`.

**For `code-config`:**

```json
{
  "questions": [
    {
      "question": "How thorough should the check be?",
      "header": "Depth",
      "multiSelect": false,
      "options": [
        {
          "label": "Basic",
          "description": "OWASP Top Ten coverage. Good balance. (Recommended)",
          "preview": "OWASP Top Ten ruleset — covers the most exploited web vulnerability categories.\n\nFlags medium+ severity. Best choice for most projects."
        },
        {
          "label": "Advanced",
          "description": "Full security audit ruleset. Slowest.",
          "preview": "Full security audit ruleset — all patterns including low-severity findings.\n\nMay take several minutes on larger projects. Best before a PR."
        }
      ]
    }
  ]
}
```

**For `monitor`:** skip this step — the scan covers public pages automatically.

**For `release`:** skip this step entirely. Default to running **all** sub-skills at **advanced** depth (full security audit ruleset, all severity levels).

### 2.3 Capture the chosen sub-skill set

Build a `selectedSkills` list based on the answers. Always include the read-only check of `setup-auth` for the `code-config` and `release` goals (it consists of reading existing YAML, not running the sub-skill itself — see 4.4 below). This is the **Access & Data Security Validation** component.

---

## 3. Confirm the plan

Tell the user, in plain language, what will run and the rough time it will take. Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| I will <one-line description>. Continue? | Yes, run it (Recommended); Change the plan |

When the user confirms, mark the **Run sub-skills** task `in_progress` and continue.

---

## 4. Run the matching sub-skills

Spawn each selected sub-skill as a background subagent via the `Agent` tool. Each subagent invokes its skill with the argument `--review <PROJECT_ROOT>/.security-review-tmp/`. Each sub-skill handles its own authentication, error reporting, and progress.

### 4.1 Sub-skill invocation via subagents

Sub-skills run as **parallel subagents** using the `Agent` tool. Launch the long-running scans first so they get a head start, then launch the remaining checks immediately after.

**Wave 1 — long-running scans (launch first):**

Spawn background subagents for `scan-code` and `scan-site` (when selected). These sub-skills take the most time and benefit from an early start.

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
  description: "Run scan-code",
  prompt: "Invoke the skill `scan-code` with argument `--review <PROJECT_ROOT>/.security-review-tmp/`. The Power Pages project root is <PROJECT_ROOT>. <any additional scope parameters>. Write findings to <PROJECT_ROOT>/.security-review-tmp/scan-code.json in the section data format. If the skill fails, write { \"status\": \"skipped\", \"reason\": \"<plain-language reason>\" } instead.",
  run_in_background: true
})
```

### 4.1.2 Expected output

After all subagents complete, expect JSON files at `<PROJECT_ROOT>/.security-review-tmp/<skill-name>.json` matching the [section data format](references/section-data-format.md):

```text
.security-review-tmp/
├── scan-code.json
├── scan-site.json
├── manage-headers.json
├── manage-firewall.json
└── audit-permissions.json   (when invoked)
```

If a sub-skill's subagent fails or is skipped, write a placeholder file with shape `{ "status": "skipped", "reason": "<plain-language reason>" }` so the report-building step can render it as a single `info` finding for that section.

### 4.2 Sub-skills that lack a review mode

`audit-permissions` and `setup-auth` do not currently run in review mode by themselves. Treat them as follows:

- **audit-permissions** — invoke via `Skill` and capture its findings JSON manually. The skill writes its data to `<PROJECT_ROOT>/docs/<file>.html`; in this orchestration, **read its findings JSON shape from the inventory you collected during the run** and write it to `.security-review-tmp/audit-permissions.json` matching the shared section format documented in `references/section-data-format.md`.
- **setup-auth** — do not invoke. Instead, read existing `.powerpages-site/site-settings/` files for authentication and cookie settings and produce a small finding list:
  - identity provider configured? (look for `Authentication/OpenIdConnect/*/Authority`)
  - profile redirect disabled? (`Authentication/Registration/ProfileRedirectEnabled = false`)
  - cookie SameSite reasonable? (`HTTP/SameSite/Default`)

Write the resulting findings to `.security-review-tmp/setup-auth.json` in the [section data format](references/section-data-format.md).

### 4.3 Status updates

Tell the user that all checks are running in parallel. As each subagent completes, give a short progress line (e.g., "Code check finished — 2 important issues, 4 smaller ones."). Avoid technical jargon. Do not narrate sub-skill internal steps. Once all subagents have finished, confirm that all checks are complete before moving to the report-building step.

---

## 5. Build the consolidated report

### 5.1 Read all section data

Load every JSON file in `.security-review-tmp/`. Each file should match the [section data format](references/section-data-format.md). Skip files marked `status: "skipped"` after capturing their reason for the per-section placeholder.

### 5.2 Compute totals

Count `critical`, `warning`, `info`, and `pass` findings across all sections.

### 5.3 Pick top findings

Choose up to five findings for the Overview's "Top findings" list. Prioritize critical findings, break ties with the section order: code → site → headers → firewall → permissions → auth.

### 5.4 Write next-step guidance

Generate up to four concrete next steps in plain language. Examples:

- "Fix the three critical items in **Browser headers** before publishing."
- "Run a thorough live-site scan once the headers are deployed."
- "Add a rate-limit rule for sign-in pages."

The agent should reason about which next step is most valuable per case rather than picking from a hard-coded list.

### 5.5 Build the data file

Write the consolidated data to `.security-review-tmp/security-review-data.json`:

```json
{
  "SITE_NAME": "<site name>",
  "GOAL_LABEL": "<plain-language goal label>",
  "SCOPE_LABEL": "<plain-language scope label>",
  "GENERATED_AT": "<YYYY-MM-DD HH:MM>",
  "REVIEW_DATA": {
    "summary": "<2-4 plain-language sentences>",
    "totals": {
      "critical": 0,
      "warning": 0,
      "info": 0,
      "pass": 0
    },
    "topFindings": [
      <findingObj>,
      ...
    ],
    "sections": [
      {
        "id": "code-scan",
        "icon": "▦",
        "label": "Code & Packages",
        "description": "Review of source files and installed packages.",
        "findings": [
          <findingObj>,
          ...
        ],
        "details": {
          "kind": "kv",
          "label": "Tools used",
          "entries": [
            ...
          ]
        }
      }
      // … one entry per section
    ],
    "nextSteps": [
      "..."
    ],
    "glossary": [
      {
        "term": "...",
        "aka": "...",
        "definition": "..."
      }
    ]
  }
}
```

The glossary entries come from `references/glossary.md`. Include only the terms that appear in any of the section findings. Do not include the entire glossary if half of it is not relevant — fewer, more useful entries beat a complete dump.

### 5.6 Render the master HTML

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/security-review/scripts/render-review.js" \
  --output "<DOCS_PATH>" \
  --data "<TEMP_DIR>/security-review-data.json"
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
| What would you like to do next? | Walk me through fixing the critical items now; Re-run the review after I make changes; Stop here, I will read the report myself |

If the user picks "walk me through", group critical findings by section and offer the matching focused skill for each (`/manage-headers`, `/manage-firewall`, `/audit-permissions`, etc.).

If the user picks "re-run", invoke this skill again with the same goal and scope.

---

## 7. Clean up

Delete the entire `.security-review-tmp/` folder. The final HTML, located in `docs/`, must remain. Confirm to the user that temporary files have been removed.

If the cleanup fails (file lock, permission), warn the user and continue — the report is already written and the temp folder can be removed manually later.

---

## Constraints

- **Plain language with users** — never lead with technical terms. The glossary in the final report covers them.
- **Parallel subagent delegation** — sub-skills run as parallel subagents via the `Agent` tool. Launch `scan-code` and `scan-site` first (long-running), then the remaining checks immediately after. Perform the inline read-only `setup-auth` check while subagents work.
- **Single consolidated HTML** — never produce per-skill HTML reports during this run. Sub-skills run in `--review` mode.
- **Same look and feel** — use the shared template under `assets/`. The generated report must match the existing audit-permissions report visually.
- **Glossary always present** — every report includes a Glossary section with at least the terms that appeared in the findings.
- **Cleanup is mandatory** — the cleanup step is not optional. Failing to clean up is treated as a non-fatal warning, but the skill always tries.
- **Never run destructive sub-actions automatically** — sub-skills that propose changes (e.g., editing site settings, deleting WAF rules) must operate in read-only `--review` mode during this orchestration. Apply changes only via the explicit "walk me through fixes" follow-up, after the user picks an action.

## References

- `references/section-data-format.md` — the JSON shape every section uses
- `references/glossary.md` — plain-language explanations of the technical terms
- `references/flow.md` — the seven-step conversation in detail
