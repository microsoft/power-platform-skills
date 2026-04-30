---
name: manage-http-headers
description: >-
  Inspects and configures the security headers a Power Pages code site sends
  to browsers — Content Security Policy, frame and clickjacking protection,
  cross-origin sharing, cookie behavior, and the related advanced site
  settings. Produces an HTML report that scores the current setup and
  proposes fixes. Use when the user wants to review their site's headers,
  fix CSP errors, allow embedding in another site, control cross-origin
  access, or harden a site against common browser-side attacks — even if
  they only ask "are my browser settings safe?".
user-invocable: true
argument-hint: "[optional: --data-only <out-dir>]"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Manage HTTP Headers

Review and configure the security-related response headers a Power Pages site sends to browsers. The skill reads the site's current configuration, scores it against well-known browser-side hardening practices, and (with the user's confirmation) writes the changes back as Power Pages site setting YAML files.

The headers and settings covered here:

- **Content-Security-Policy** — controls which scripts, styles, images and frames a page may load. Includes report-only mode and nonce support.
- **X-Frame-Options / Content-Security-Policy frame-ancestors** — controls whether other sites may embed pages from this site.
- **CORS** — controls which other sites may call this site's Web API from a browser.
- **Cookie SameSite mode** — controls when the browser sends the site's session cookie.
- **Other security headers** — `X-Content-Type-Options`, Referrer-Policy, Permissions-Policy, and a note on platform-managed transport security (HSTS, HTTPS redirect).

**Initial request:** $ARGUMENTS

## When to load which reference

- `references/header-rules.md` — load when the user asks about a specific header (what it does, accepted values, site-setting name), when planning CSP directives, when configuring CORS, or when the agent needs the list of runtime sources a CSP must allow.
- `references/commands.md` — when building command lines for `inspect-headers.js` or `scan-external-urls.js`, or when interpreting exit codes.

## Gotchas

- **HSTS and Cache-Control are platform-managed.** `HTTP/Strict-Transport-Security` cannot be set via site settings. Do not attempt a workaround.
- **CSP is pass-through, not merged.** The runtime does NOT add its own sources automatically. If your policy omits the runtime's `content.powerapps.*` sources, runtime resources fail to load. Use `scan-external-urls.js` to get the full allowlist including the runtime dependencies.
- **Use the `'nonce'` keyword in `script-src`, not `'unsafe-inline'`, for inline scripts.** The runtime replaces `'nonce'` with a per-request random value and auto-injects hashes for inline event handlers.
- **`HTTP/Content-Security-Policy/Inject-unsafe-eval`** is a site-setting (boolean, default true). When true and `'nonce'` is present, the runtime auto-injects `'unsafe-eval'` into `script-src`. Set to `false` only after confirming the site works without it.
- **Report-Only is a separate site-setting**, not a flag on the main CSP. Name: `HTTP/Content-Security-Policy-Report-Only`. You can run both enforcement and report-only at the same time.
- **CORS `Allow-Credentials` only accepts `true`.** There is no `false` value — omit the setting entirely to disable credentials.
- **CORS `Allow-Origin: *` is auto-specialized.** The runtime replaces `*` with the specific requesting Origin on each response.
- **A site-setting change triggers a soft restart.** Header changes take effect once the restart propagates after deploy. Verify in an incognito browser tab.
- **Maker-mode traffic bypasses all `HTTP/*` headers.** Requests from Power Pages Studio skip header emission. Always verify with a fresh browser tab.
- **Non-catalogue `HTTP/*` names are emitted by the runtime.** The runtime emits any `HTTP/*` setting as a response header. The `inspect-headers.js` script categorizes all `HTTP/*` settings it finds under the `advanced` category but does not flag unrecognized names — review the inventory manually to spot typos.

## Workflow

1. **Phase 1: Prerequisites** — Locate the project, confirm it has been deployed
2. **Phase 2: Review configured headers** — Inventory current settings and compare against safe defaults
3. **Phase 3: Plan the changes** — Walk the user through proposed fixes in plain language
4. **Phase 4: Apply the changes** — Write the updated YAML files (never destructive without confirmation)
5. **Phase 5: Summarize and next steps** — Present results and prompt for deploy

## Task Tracking

Create tasks in three batches. Mark each `in_progress` when you start and `completed` when you are done.

**Batch 1 — create at the start of Phase 1:**

| Task subject | activeForm |
|--------------|------------|
| Check prerequisites | Checking prerequisites |

Only this one task. Do not create any other tasks until Phase 1 completes and the site-settings folder is confirmed.

**Batch 2 — create after Phase 1 completes** (site-settings folder confirmed):

| Task subject | activeForm |
|--------------|------------|
| Review configured headers | Reviewing configured headers |
| Plan the changes | Planning the changes |

**Batch 3 — create after Phase 3 completes** (user has responded to all proposed changes):

| Task subject | activeForm | When to create |
|--------------|------------|----------------|
| Apply the changes | Applying the changes | Only if the user accepted at least one change AND the skill is NOT in data-only mode. Do not create this task otherwise. |
| Summarize and next steps | Summarizing | Always |

---

## Phase 1: Prerequisites

Use `Glob` to find `**/powerpages.config.json`. If it is not found, tell the user (in plain language) to create the site first with `/create-site`, then stop.

Also confirm the `.powerpages-site/site-settings/` folder exists. This folder is created on the first deploy. If it is missing, the site has not been deployed yet — tell the user the site needs to be deployed once before its browser settings can be reviewed, recommend `/deploy-site`, then stop.

If `$ARGUMENTS` contains `--data-only <out-dir>`, remember the output directory — Phase 5 will be skipped (no edits) and Phase 6 will write only the JSON data file.

---

## Phase 2: Review configured headers

### 2.1 Inventory current settings

Run the inventory script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-http-headers/scripts/inspect-headers.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --output "<TEMP_DIR>/headers-inventory.json"
```

The script reads every YAML file under `.powerpages-site/site-settings/` and returns a normalized structure listing each header-related setting found (name, value, file path, category) plus a `missing` array of expected settings that have no corresponding YAML file.

### 2.2 Score against safe defaults

For each setting in `references/header-rules.md`, classify it using these rules. Use the agent's own reasoning (not a script) to interpret values and assign severity — do **not** rely on naive keyword matches.

| Severity | When to use |
|----------|-------------|
| `critical` | Setting is required for safe browser behavior and is missing, off, or wide-open. Examples: no `Content-Security-Policy`, frame ancestors set to `*`, `Access-Control-Allow-Origin: *` together with credentialed responses. |
| `warning` | Setting is present but loose enough that an attacker could still bypass it. Examples: CSP that allows `unsafe-inline` or `unsafe-eval`; SameSite set to `None` without a clear reason. |
| `info` | The current value is acceptable but a stricter option exists. Examples: CSP present in report-only mode without an enforcement counterpart; Referrer-Policy set but a stricter option is available. |
| `pass` | Value matches a documented safe default. |

For each finding, write a `reasoning` line in plain language that explains *what could happen* if the setting stays this way (e.g., "Without this header, attackers can hide your sign-in page inside a fake site that they control and trick users into clicking buttons that look harmless."). Add a `fix` line that describes the change in concrete terms ("Set this value to ...").

### CSP allowlist discovery

For any CSP evaluation or change, run the external URL scanner first:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-http-headers/scripts/scan-external-urls.js" \
  --projectRoot "<PROJECT_ROOT>"
```

The script returns two outputs:
- `byDirective` — specific external hosts the project's source files reference (e.g., `fonts.googleapis.com`, `images.unsplash.com`), grouped by CSP directive.
- `runtimeDependencies` — cloud-agnostic Power Pages runtime sources. These contain broad `https:` wildcards as safe starting points.

**Composing the CSP — use specific hosts, not broad wildcards:**

1. **Detect the site's cloud.** Run `pac auth who` and read the `Cloud` field. Add the matching `content.powerapps.*` host to `script-src` (see the cloud table in `references/header-rules.md`).
2. **Start with `runtimeDependencies`** as the base for each directive.
3. **Replace broad `https:` wildcards with the specific hosts from `byDirective`** wherever the scanner found concrete hosts. For example, if `byDirective` lists hosts for a directive, use those specific hosts (e.g., `https://<discovered-host>`) instead of the broad `https:`. Keep the `https:` wildcard ONLY for directives where no specific hosts were discovered and the runtime requires it.
4. **Exclude hosts from non-deployed directories.** The scanner walks the full project tree. If hosts appear only in files under `docs/`, `dist/`, or other non-deployed directories, exclude them from the CSP — they are not loaded by the live site.
5. The cloud-specific `content.powerapps.*` host for `script-src` is NOT in the scan output — add it from step 1.

---

## Phase 3: Plan the changes

Use `AskUserQuestion` with **plain language only**. Never lead with words like CSP, CORS, SameSite, HSTS, frame-ancestors. Translate as needed.

**IMPORTANT:** Each question below is a **separate** `AskUserQuestion` call. Do NOT combine them into one multi-step form. Wait for the user's answer to one question before deciding whether to ask the next.

| Technical name | Plain wording |
|----------------|---------------|
| Content Security Policy | "the rule that says what the browser may load on each page" |
| frame-ancestors / X-Frame-Options | "whether other websites may embed your pages inside theirs" |
| CORS | "which other websites may call your site from a browser" |
| SameSite cookie mode | "when the browser is allowed to send your sign-in cookie" |
| X-Content-Type-Options | "stop the browser from guessing file types" |

For each finding (or group of related findings), call `AskUserQuestion` using the structured `questions` array format. Each option MUST include both a `description` and a `preview` field. The `preview` renders as a visual card panel alongside the options.

**Exact call pattern:**

```json
{
  "questions": [{
    "question": "<plain-language risk explanation — 1-2 sentences>. What would you like to do?",
    "header": "<max 12 ch>",
    "multiSelect": false,
    "options": [
      {
        "label": "Apply",
        "description": "Adds this setting to your site. (Recommended)",
        "preview": "Setting: <setting-name>\n\nValue:\n  <planned-value>\n\nNote: <any caveat>"
      },
      {
        "label": "Skip",
        "description": "Leave the site without this setting."
      }
    ]
  }]
}
```

- **`label`** — **1-5 words only**. Keep labels very short so they fit on one line (e.g., "Apply", "Test mode first", "Skip"). Never put "(Recommended)" in the label — put it in the `description` instead. Long labels wrap and look broken.
- **`header`** — max 12 characters, used as the tab label (e.g., "Browser rule", "Embedding", "CORS", "Cookies").
- **`description`** — short explanation of what the option does (1 sentence). Add "(Recommended)" here if this is the recommended option.
- **`preview`** — the planned setting name and value as a formatted markdown string. For CSP, break each directive onto its own line. **Always include `preview` on the recommended option** so the user can see exactly what they are approving.
- **Max 4 options** per question (an "Other" option is added automatically).

---

## Phase 4: Apply the changes

Skip this phase entirely in **data-only mode**.

For each accepted change, write or update a YAML file under `.powerpages-site/site-settings/`. Use the existing helper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "<SETTING_NAME>" \
  --value "<NEW_VALUE>" \
  --description "<short description>"
```

The helper is **not** idempotent — if a setting with the same name already exists, it exits with an error. To update an existing setting, use the `Edit` tool to modify the YAML file directly (preserve the existing `id`). Track each call's result. Continue past failures and report them in the final summary.

After all accepted changes are written, run a quick `git diff .powerpages-site/site-settings` (via Bash) to confirm exactly what changed. Show the diff to the user.

---

## Phase 5: Summarize and next steps

### 6.1 Data-only mode

In **data-only mode**, write a JSON data file to `<DATA_ONLY_DIR>/manage-http-headers.json` with:

- `REPORT_TITLE` — `"Browser Security Headers"`
- `REPORT_DESC` — short description naming the site
- `SITE_NAME` — site display name
- `SUMMARY` — 2–3 plain-language sentences covering what was checked, how many issues were found, and how many fixes were applied
- `FINDINGS_DATA` — array of findings (post-fix). Items the user accepted should appear with severity `pass` and a note that the change was applied.
- `DETAILS_DATA` — `{ label: 'Settings', kind: 'table', columns: ['Setting', 'Current value', 'Recommended', 'Status'], rows: [...] }`

Then stop — the orchestrating skill handles presentation.

### 6.2 Summarize

Present a plain-language summary in the chat: how many headers were checked, what was found, and what was changed. List each setting with its before → after value.

### 6.3 Record skill usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "ManageHttpHeaders"`.

### 6.4 Prompt for deploy

If any change was applied, use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| The header changes are saved locally. Do you want to deploy them now? | Yes, deploy now (Recommended); No, I will deploy later |

If yes, invoke `/deploy-site`. If no, remind the user that the new headers only take effect after deploy.

---

## Constraints

- **Plain language with users** — never use jargon in the questions or summary. Explain technical names only when the user asks.
- **One change at a time** — propose changes per setting, not in a single bulk diff. Confirm each one.
- **Never auto-apply destructive changes** — tightening CSP can break a site. Always confirm and prefer a `Report-Only` policy as a stepping stone before enforcement.
- **Use shared helpers for new settings** — use `create-site-setting.js` for new settings; for existing settings, use `Edit` to update the YAML value in-place (preserve the `id`).
- **Track failures, don't roll back** — record per-setting success/failure and continue.
- **Read-only by default** — without explicit confirmation in Phase 4, the skill writes nothing.

## Progress tracking table

Keep this table in your final response, filling each status as phases complete:

| Phase | Status |
|---|---|
| 1. Check prerequisites | ☐ |
| 2. Review configured headers | ☐ |
| 3. Plan the changes | ☐ |
| 4. Apply the changes | ☐ |
| 5. Summarize and next steps | ☐ |

## References

- `references/header-rules.md` — the per-setting safe defaults, why they matter, and the corresponding Power Pages site setting names
- `references/commands.md` — flags and response shape for the scripts and exit codes
