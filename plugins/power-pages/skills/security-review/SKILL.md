---
name: security-review
description: >-
  Runs a guided, end-to-end security review of a Power Pages site and
  consolidates every finding into one HTML report covering source code
  and dependencies, the live site, browser headers, firewall,
  authentication, and role-based permissions. Use when the user wants a
  full security review, a release-readiness check before publishing, a
  code-and-config check during development, live site monitoring, or
  asks open-ended questions like "review my site security", "is my site
  safe to ship", "do a security check", "monitor my site" — even if they
  do not name the individual checks.
user-invocable: true
argument-hint: "[optional natural-language hint about the goal]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, Skill, Agent
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Review Security

Guide the user through a full security review of their Power Pages site. Runs the matching focused skills and assembles every finding into a single HTML report.

The skill never asks the user technical questions. The conversation stays in plain language.

**Initial request:** $ARGUMENTS

## Workflow

The skill has six phases. Phases 2–5 each map to one conversation beat with the user; phases 1 and 6 are silent setup and cleanup. See `references/flow.md` for the rationale behind each beat.

| Phase | What happens | User-facing beat |
|-------|--------------|------------------|
| 1 — Prerequisites | Locate project, set up working folders | (silent setup) |
| 2 — Scope | Capture goal — one question, three answers, plain language | Ask the goal |
| 3 — Skills | Run the matching skills, surface progress | Scan in progress |
| 4 — Report | Build the consolidated report — totals + per-section findings | Results summary + Findings |
| 5 — Present | Present results, offer remediation follow-ups | Next steps and guidance |
| 6 — Cleanup | Remove temporary files | (silent cleanup) |

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

**Group 3 — create after the goal is captured:**

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

For the `code-config` goal, the deploy check is not required: source code, dependencies, authentication, web roles, and table permissions are read from local files alone.

### 1.2 Prepare a temporary working folder

Create a fresh working directory: `<SYSTEM_TEMP>/security-review/`. The folder holds JSON data files emitted by each skill in **review mode**. The folder is removed in the cleanup step.

If the folder already exists from a previous interrupted run, delete its contents (not the folder itself) before continuing.

### 1.3 Determine the docs output path

The final HTML always lives at `<PROJECT_ROOT>/docs/security-review-<YYYY-MM-DD-HHMMSS>.html` using the local timestamp at the start of the run (e.g. `security-review-2026-05-14-053805.html`). Always include the timestamp — do not use a bare `security-review.html` name. This keeps each run's report distinct.

---

## 2. Capture goal

### 2.1 Ask the goal

<!-- gate: security-review:2.1.goal | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · security-review:2.1.goal):** Capture the review goal — choice branches into one of three sub-skill sets (`code-config` / `release` / `monitor`).
>
> **Trigger:** Phase 2.1 entry, unless `$ARGUMENTS` already answers it.
> **Why we ask:** Auto-picking `release` runs ALL sub-skills (slow; possibly hits scan/firewall endpoints unnecessarily); auto-picking the wrong goal mis-scopes the review.
> **Cancel leaves:** Nothing — no sub-skills invoked yet.

Ask the user with a single `AskUserQuestion` call. If the user's initial request already answers it, skip and continue.

**Question — What to review?**

| Label | Description |
|-------|-------------|
| Code & config | Check source code, dependencies, authentication, web roles, and table permissions. Works on local files only. |
| Release readiness | Full review before publishing — checks everything. (Recommended) |
| Deployed site | Check the live site for issues. Requires deployment. |

Goal mapping (internal):

| Label | Goal id | Skills |
|-------|---------|------------|
| Code & config | `code-config` | scan-code, audit-permissions, setup-auth (read-only) |
| Release readiness | `release` | scan-code, scan-site, manage-headers, manage-firewall, audit-permissions, setup-auth (read-only) |
| Deployed site | `monitor` | scan-site |

### 2.2 Capture the chosen skill set

Build a `selectedSkills` list based on the answer. Always include the read-only check of `setup-auth` for the `code-config` and `release` goals (it consists of reading existing YAML, not running the skill itself — see § 3.2 below). This is the **Access & Data Security Validation** component.

---

## 3. Run the matching skills

Spawn each selected skill as a background subagent via the `Agent` tool. Each subagent invokes its skill with the argument `--review <SYSTEM_TEMP>/security-review/`. Each skill handles its own authentication, error reporting, and progress.

### 3.1 Skill invocation via subagents

Skills run as **parallel subagents** using the `Agent` tool.

**Default — launch every Agent-eligible skill in one parallel batch.** Spawn all selected subagents in a single message with multiple `Agent` tool calls so they start concurrently. Each subagent runs with `run_in_background: true`. The Agent-eligible set is `scan-code`, `scan-site`, `manage-headers`, `manage-firewall` — these all support `--review` mode. `scan-site` (server-side scan, several minutes) and `scan-code` (local static analysis + dependency scan, up to minutes on large projects) are the slowest; the others typically finish within seconds.

**Fallback — staggered launch.** If the harness rejects a parallel-batch call for any reason, launch `scan-code` and `scan-site` first (the long-running ones) and then the remaining skills in a follow-up message. This is a tool-affordance fallback, not the preferred path.

**Inline checks (run while subagents work).** `audit-permissions` and `setup-auth` do not support `--review` and MUST NOT be launched via `Agent` — handle them inline as described in § 3.2.

Wait for all subagents to complete before proceeding to the report-building step.

### 3.1.1 Subagent prompt pattern

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

### 3.1.2 Expected output

After all subagents complete, expect JSON files at `<SYSTEM_TEMP>/security-review/<skill-name>.json`. Each file has the shape `{ status, findings, details? }` produced by the skill's transform script:

```text
<SYSTEM_TEMP>/security-review/
├── scan-code.json           (when invoked)
├── scan-site.json
├── manage-headers.json
├── manage-firewall.json
└── audit-permissions.json   (when invoked)
```

If a skill's subagent fails or is skipped, write a placeholder file with shape `{ "status": "skipped", "reason": "<plain-language reason>" }`. The report-building step renders this as a single non-severity finding for that section (no `severity` field, to stay consistent with § 3.1.3).

### 3.1.3 Severity policy

Only findings that come from a tool that genuinely outputs severity may carry a `severity` field:

| Section | Source | Severity allowed? |
|---------|--------|-------------------|
| `scan-code` | opengrep, trivy | Yes |
| `scan-site` | deep-scan (ZAP) | Yes |
| `manage-headers` | `transform-headers.js` (inventory) | **No** |
| `manage-firewall` | `transform-firewall.js` (inventory) | **No** |
| `audit-permissions` | Web roles & table permissions audit | **No** |
| `setup-auth` | Site settings & auth-related source code audit | **No** |

For inventory sections, do **not** add `severity` to findings — not even `info`. The subagent and orchestrator must write the transform output **verbatim** without inserting opinionated severity-bearing findings. The `tag` field is **also** off-limits as a severity workaround: it is reserved for short mechanical identifiers from tools (e.g. ZAP rule ids, CWE codes) and MUST NOT carry severity-equivalent strings (`critical`, `warning`, `info`), since the report template renders it as a visible chip next to the title.

### 3.1.4 Annotations policy (plain-language text)

The transform scripts for `manage-firewall` and `manage-headers` produce only structured raw data — they do **not** hardcode plain-language descriptions. The subagent must generate an annotations JSON file and pass it to the transform via `--annotations`. The annotations supply:

- Plain-language description per rule / per header
- Optional suggested fix when a genuine issue is present

See each skill's `SKILL.md` § 5.1 for the annotation file shape. The agent's job is to write accurate, terse descriptions based on the raw data — not to invent severities or fabricate issues.

### 3.2 Skills without `--review` mode

`audit-permissions` and `setup-auth` do not support `--review`. Handle them inline (not as background subagents):

- **audit-permissions** — invoke via the `Skill` tool (not `Agent`). The skill audits **both web roles and table permissions** — capture both in its output. After it completes, read its output and write `<SYSTEM_TEMP>/security-review/audit-permissions.json` in the unified `{ status, findings, details? }` shape (mapping each audit finding into the common finding fields: `id`, `title`, `location`, `details`, `fix`).
- **setup-auth** — do not invoke as a skill. Instead, read `.powerpages-site/site-settings/` YAML files directly and check for:
  - identity provider configured? (`Authentication/OpenIdConnect/*/Authority`)
  - profile redirect disabled? (`Authentication/Registration/ProfileRedirectEnabled = false`)
  - cookie SameSite setting? (`HTTP/SameSite/Default`)

Write the resulting findings to `<SYSTEM_TEMP>/security-review/setup-auth.json` in the same format.

**Field policy for both sections** — these are inventory sections, not tool-output severities (see § 3.1.3):

- **Do NOT include a `severity` field** on any finding.
- **Do NOT include a `tag` field.** The `tag` field is reserved for short mechanical identifiers from tools (`HTTP/X-Frame-Options`, ZAP rule id `10055`, CWE codes). It MUST NOT carry severity-equivalent strings (`critical`, `warning`, `info`) — the report template renders `tag` as a visible chip next to the title, so stashing LLM-judged severity there would visually re-introduce the severity bucketing this section explicitly forbids.

### 3.3 Status updates

Tell the user that all checks are running in parallel. As each subagent completes, give a short progress line (e.g., "Code check finished — 2 important issues, 4 smaller ones."). Avoid technical jargon. Do not narrate skill internal steps. Once all subagents have finished, confirm that all checks are complete before moving to the report-building step.

---

## 4. Build the consolidated report

### 4.1 Consolidate

Write up to four plain-language next-step recommendations as a JSON string array to `<SYSTEM_TEMP>/security-review/next-steps.json`. Compose a 2–4 sentence plain-language `summary` of the overall state.

```bash
node "${PLUGIN_ROOT}/scripts/build-review-data.js" \
  --reportName "Security Review" \
  --inputDir "<SYSTEM_TEMP>/security-review/" \
  --siteName "<SITE_NAME>" \
  --goalLabel "<GOAL_LABEL>" \
  --scopeLabel "<SCOPE_LABEL>" \
  --summary "<SUMMARY_TEXT>" \
  --nextStepsFile "<SYSTEM_TEMP>/security-review/next-steps.json" \
  --output "<SYSTEM_TEMP>/security-review/security-review-data.json"
```

### 4.2 Render the master HTML

```bash
node "${PLUGIN_ROOT}/scripts/render-review.js" \
  --output "<DOCS_PATH>" \
  --data "<SYSTEM_TEMP>/security-review/security-review-data.json"
```

---

## 5. Present and follow-ups

### 5.1 Open in browser

Open `<DOCS_PATH>` in the user's default browser.

### 5.2 Record skill usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "SecurityReview"`.

### 5.3 In-chat summary

<!-- gate: security-review:5.3.next-action | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · security-review:5.3.next-action):** Post-report next-action prompt — *"Walk me through the fixes / Re-run the review / Done for now"*. Drives whether remediation skills get invoked.
>
> **Trigger:** Phase 5.1 wrote the HTML report.
> **Why we ask:** Auto-invoking remediation skills (`/manage-headers`, `/manage-firewall`, `/audit-permissions`) without the user reading the report; auto-re-running the review wastes time on a still-fresh result.
> **Cancel leaves:** Nothing — the HTML report at `docs/security-review-<ts>.html` is the final artifact regardless.

Show a short plain-language summary in the chat: counts of critical / warning / info findings, where the report lives. Then offer the next action with `AskUserQuestion`:

| Question | Options |
|----------|---------|
| What would you like to do next? | Walk me through the fixes; Re-run the review; Done for now |

If the user picks "walk me through", group critical findings by section and offer the matching focused skill for each (`/manage-headers`, `/manage-firewall`, `/audit-permissions`, etc.).

If the user picks "re-run", invoke this skill again with the same goal and scope.

---

## 6. Clean up

Delete the entire `<SYSTEM_TEMP>/security-review/` folder. The final HTML, located in `docs/`, must remain. Confirm to the user that temporary files have been removed.

If the cleanup fails (file lock, permission), warn the user and continue — the report is already written and the temp folder can be removed manually later.

---

## Constraints

- **Plain language with users** — never lead with technical terms.
- **Parallel subagent delegation** — every selected skill runs as a parallel subagent via the `Agent` tool, launched in a single message. Perform the inline read-only `setup-auth` check while subagents work. Use the staggered launch (§ 3.1 fallback) only if the harness rejects the parallel-batch call.
- **Single consolidated HTML** — never produce per-skill HTML reports during this run. Skills run in `--review` mode.
- **Same look and feel** — rendering goes through the shared template at `${PLUGIN_ROOT}/scripts/lib/templates/security-review-report.html` via `scripts/render-review.js`. Do not author per-skill HTML or duplicate the template; the generated report must match the existing audit-permissions report visually.
- **Cleanup is mandatory** — the cleanup step is not optional. Failing to clean up is treated as a non-fatal warning, but the skill always tries.
- **Never run destructive sub-actions automatically** — skills that propose changes (e.g., editing site settings, deleting WAF rules) must operate in read-only `--review` mode during this orchestration. Apply changes only via the explicit "walk me through fixes" follow-up, after the user picks an action.

## References

- `references/flow.md` — rationale and example phrasing for the conversation beats in phases 2–5
