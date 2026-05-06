---
name: manage-firewall
description: >-
  Inspects and configures the web application firewall (WAF) in front of a
  Power Pages production site — the network shield that filters out common
  web attacks before they reach the site. Lists the current state, recommends
  enabling protection when it is off, and walks the user through adding,
  updating, or removing custom and managed rules. Produces an HTML report.
  Use when the user wants to turn on WAF, add IP or rate-limit rules, review
  the current firewall configuration, or asks "is my site protected against
  bots / common web attacks?".
user-invocable: true
argument-hint: "[optional: --data-only <out-dir>]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Manage Web Application Firewall

Review and configure the web application firewall for a Power Pages production site. The firewall is a shield that lives in front of the site and blocks common attack traffic — cross-site scripting, file inclusion, session fixation, protocol violations, and malicious bots — before it reaches the site. Custom rules let you restrict traffic by country, IP address, request path, or request rate.

The skill can:

- Show whether the firewall is on or off
- Turn it on (or back off)
- Show current managed rule sets and custom rules
- Add, update, or remove a custom rule
- Report the configuration in a uniform HTML report

The firewall is only available on **production** sites. Trial and developer sites need to be converted first. When a trial is converted to production, the firewall is enabled by default (the admin can opt out during conversion).

Regional availability: the firewall is not available in Singapore Local, China, or UAE regions. Managed and custom rule configuration is additionally restricted in GCC, GCC High, and DoD regions.

After creating or updating rules, changes may take **up to one hour** to propagate to all edge locations worldwide.

## Gotchas

- **Website record id vs portal id.** `.powerpages-site/website.yml` stores the website record id, not the portal id. Every script takes `--portalId`. Resolve once via `website.js --websiteId` in Phase 1.
- **Never resolve by name.** Site names can duplicate; only the website record id is safe.
- **Production sites only.** Trial portals refuse every WAF operation with `B023`. User must convert to production.
- **Async operations.** `enable.js` and `disable.js` have built-in polling — they wait until the status reaches the target value (or timeout). `delete-rules.js` returns immediately after the server accepts the request (202). After `delete-rules.js` completes, verify the change via `get-rules.js`.
- **Concurrent-operation guard.** `B003` means another enable/disable is already in flight. Poll status until it settles, then retry.
- **False-positive managed rule:** disable it via a rule override (`EnabledState: "Disabled"` inside `RuleGroupOverrides` in the `set-rules.js` body — managed rule fields use PascalCase).
- **First-match-wins.** Rules evaluate in priority order; subsequent rules are skipped once one matches. A geo-allow-then-default-deny pattern requires an explicit default-deny rule AFTER the allow.
- **Custom rule priority starts at 11.** Values 1-10 are reserved for platform-managed rules; user rules at those values are rejected.
- **`set-rules.js` submits a full rule configuration.** Always read current rules first (Phase 2), merge changes into a complete plan, and submit the full target collection. Submitting a partial body can have unpredictable effects.
- **Use `delete-rules.js` to remove individual custom rules by name.** Removing by omission from a `set-rules.js` body is not reliable.

**Initial request:** $ARGUMENTS

## Workflow

1. **Phase 1: Prerequisites** — Locate project, confirm sign-in, identify site, check eligibility
2. **Phase 2: Read current firewall state** — Check if the firewall is on, and what rules are configured
3. **Phase 3: Decide what to do** — One question, plain language: turn on / off, add a rule, remove a rule, just report
4. **Phase 4: Apply the change** — Run the matching script, capture the result
5. **Phase 5: Summarize and next steps** — Present the before/after state, record usage, offer follow-ups

## Task Tracking

Create tasks in three batches. Mark each `in_progress` when you start and `completed` when you are done.

**Batch 1 — create at the start of Phase 1:**

| Task subject | activeForm |
|--------------|------------|
| Check prerequisites | Checking prerequisites |

Only this one task. Do not create any other tasks until Phase 1 completes and the site is resolved and eligible.

**Batch 2 — create after Phase 1 completes** (site resolved and eligible):

| Task subject | activeForm |
|--------------|------------|
| Read current firewall state | Reading firewall state |
| Decide what to do | Asking what to do |

**Batch 3 — create after Phase 3 completes** (user confirmed action). Only create tasks for phases that will actually run:

| Task subject | activeForm | When to create |
|--------------|------------|----------------|
| Apply the change | Applying the change | Only if the user chose a change action (turn on, turn off, add a rule, remove a rule) AND the skill is NOT in data-only mode. Do NOT create if the user chose "Just show me what it looks like today" or if running in data-only mode. |
| Summarize and next steps | Summarizing | Always |

---

## Phase 1: Prerequisites

### 1.1 Locate the project, detect data-only mode

Use `Glob` to find `**/powerpages.config.json`. If `$ARGUMENTS` contains `--data-only <out-dir>`, remember the output directory — Phase 4 will be skipped (read-only) and Phase 5 will write only the JSON.

### 1.2 Resolve site identifiers

Two distinct GUIDs identify a Power Pages site, and the rest of the skill needs both:

- **websiteId** — the Dataverse website record id. Stored in `.powerpages-site/website.yml` as `id`. The user-facing identifier.
- **portalId** — the admin-API id used in `/websites/{id}/...` URL paths. Returned as the `Id` field on the admin-API response.

The firewall scripts in this skill only accept `--portalId`, so resolve both values once here and reuse them for the rest of the run.

**Step 1 — read the local websiteId.** Read `.powerpages-site/website.yml`. Extract the `id` field — that is `<WEBSITE_ID>`.

If `.powerpages-site/website.yml` is missing, the site has not been deployed yet. Tell the user (in plain language) that the site needs to be deployed once before the shield can be configured, and recommend they run `/deploy-site`. Then stop. Do **not** try to identify the site by name or URL — different sites can share the same name and the URL is not a reliable identifier.

**Step 2 — resolve to portalId.** Call the shared lookup with the Dataverse `<WEBSITE_ID>` from Step 1:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/website.js" --websiteId "<WEBSITE_ID>"
```

The script returns the full website record. Read the `Id` field — that is `<PORTAL_ID>`. Also capture `Type`, `Name`, and `WebsiteUrl` for the eligibility check and the report header.

**Sign-in failures show up here.** If the call exits with code `2`, the user is not signed in. Tell them (plainly) which CLI to fix and stop:

- Power Platform CLI: `pac auth create`
- Azure CLI: `az login`

If the call returns `null` (no match), tell the user the local `id` does not exist in this environment and stop.

### 1.3 Eligibility

Check the captured `Type` field. The firewall is only available for production sites. If the site type is not `Production`, tell the user in plain language and stop:

> "Your site is currently a trial or developer site. The firewall feature is only available on production sites. You can convert your site first, then come back."

---

## Phase 2: Read current firewall state

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-firewall/scripts/get-status.js" \
  --portalId "<PORTAL_ID>" \
  --output "<TEMP_DIR>/waf-status.json"
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-firewall/scripts/get-rules.js" \
  --portalId "<PORTAL_ID>" \
  --output "<TEMP_DIR>/waf-rules.json"
```

Each script captures the raw response and a normalized summary. If either returns "feature not available in this region", surface that as a `critical` finding and continue (the rest of the report still has value).

---

## Phase 3: Decide what to do

Use `AskUserQuestion` with plain language only. Never lead with words like WAF, OWASP, ModSec, ruleset, geo-block, or rate-limit.

**IMPORTANT:** Each question below is a **separate** `AskUserQuestion` call. Do NOT combine them into one multi-step form. Wait for the user's answer to one question before deciding whether to ask the next.

Call `AskUserQuestion` using the structured `questions` array. Keep `label` to **1-5 words** — long labels wrap and look broken. Put "(Recommended)" in `description`, never in `label`. Every option MUST include `description` and `preview`.

```json
{
  "questions": [{
    "question": "What do you want to do with your site's protection?",
    "header": "Action",
    "multiSelect": false,
    "options": [
      {
        "label": "Turn it on",
        "description": "Enable the firewall. (Recommended if currently off)",
        "preview": "Enables the web application firewall in front of your site. It starts blocking known attack patterns (cross-site scripting, file inclusion, session attacks) using a set of managed rules that are kept up to date automatically.\n\nThe operation takes a minute or two to complete. Once enabled, the firewall is always on — you can add custom rules or turn it off later."
      },
      {
        "label": "Turn it off",
        "description": "Disable the firewall.",
        "preview": "Disables the firewall. Your site will no longer be protected by managed or custom rules until you re-enable it.\n\nThe operation takes a minute or two. Any custom rules you created are preserved and will be active again when you re-enable."
      },
      {
        "label": "Add a rule",
        "description": "Add a new custom rule.",
        "preview": "Add a custom rule to control who can reach your site. You can block or allow traffic based on:\n\n• Country — block or allow visitors from specific countries\n• IP address — block or allow specific IPs or ranges\n• Page path — block requests to specific URLs\n• Request rate — slow down visitors making too many requests\n\nYou will pick the type next."
      },
      {
        "label": "Remove a rule",
        "description": "Delete an existing custom rule.",
        "preview": "Remove one or more custom rules you previously added. Managed rules (the built-in protection set) are not affected.\n\nYou will see your current rules and pick which ones to remove."
      }
    ]
  }]
}
```

If the firewall is already off, also offer a "Just show me" option:
```json
{ "label": "Just show me", "description": "View the current state without changes.", "preview": "Shows whether the firewall is on or off, which managed rules are active, and what custom rules are configured.\n\nNo changes are made." }
```

If the user picks **Add a rule**, use a follow-up `AskUserQuestion`:

```json
{
  "questions": [{
    "question": "What kind of rule do you want to add?",
    "header": "Rule type",
    "multiSelect": false,
    "options": [
      {
        "label": "Block countries",
        "description": "Block visitors from specific countries.",
        "preview": "Creates a rule that blocks traffic from the countries you specify, using two-letter country codes.\n\nCommon use: restrict access to regions where you have no customers, reducing unwanted traffic and attack surface."
      },
      {
        "label": "Block IPs",
        "description": "Block specific IP addresses or ranges.",
        "preview": "Creates a rule that blocks traffic from specific IP addresses or CIDR ranges you provide.\n\nCommon use: block known bad actors or suspicious IPs you have seen in your logs."
      },
      {
        "label": "Block pages",
        "description": "Block requests to specific page paths.",
        "preview": "Creates a rule that blocks requests matching a URL pattern you specify (e.g., paths containing '/admin' or '/_services').\n\nCommon use: hide internal endpoints or admin pages from the public internet."
      },
      {
        "label": "Slow down requests",
        "description": "Limit how many requests one visitor can make.",
        "preview": "Creates a rate-limit rule that blocks any single visitor who exceeds a request threshold within a time window (1 to 5 minutes).\n\nCommon use: protect sign-in pages from brute-force attempts, or prevent bots from scraping your site too fast."
      }
    ]
  }]
}
```

A fifth option for "Allow trusted IPs" can be offered when contextually appropriate (same structured format).

Translate the answer into the parameters required by `set-rules.js`. Keep the user out of the priority-numbering and rule-naming details: pick safe defaults (priority `1000+i`, rule names like `Block-Countries`, `Allow-Office-IP`).

If the user picks **Remove a rule**, list current rules with friendly names and pick by name.

For rule-configuration operations, use a **plan-validate-execute** pattern:

1. **Plan** — read existing rules from Phase 2, merge the user's desired change into a complete target rule set, and write the full target to a transient JSON file (e.g., `waf-plan.json`). Include ALL custom rules, not just additions.
2. **Validate** — have the user review the plan before applying. Show what will change (added, updated, removed rules) and the priority ordering.
3. **Execute** — proceed to Phase 4 only after user approval.

For `delete-rules.js`, the plan is a comma-separated list of rule names. Show the names to the user before proceeding.

In **data-only mode**, skip this phase and treat the action as "Just show me what it looks like today".

---

## Phase 4: Apply the change

Skip in **data-only mode**.

All scripts in this phase take `--portalId` (the admin-API id from Phase 1.2).

| Action | Script |
|--------|--------|
| Turn it on | `enable.js --portalId <id>` |
| Turn it off | `disable.js --portalId <id>` |
| Add or update rules | `set-rules.js --portalId <id> --rules <file>` |
| Remove rules | `delete-rules.js --portalId <id> --names <comma-separated>` |

Each script handles polling for asynchronous operations (enable / disable). Run them with `run_in_background: true` so the user can continue working.

### Required disclosures before applying

- **Enabling:** the site starts enforcing the managed rule set immediately. Some legitimate requests may be blocked until managed rules are reviewed.
- **Disabling:** the site is no longer protected until re-enabled.
- **Rule changes:** apply globally; edge propagation can take up to an hour. Priority determines evaluation order (first-match-wins).
- **Disabling a managed rule:** that attack vector is no longer inspected until re-enabled.

After the script completes, re-run the Phase 2 status and rules calls to verify the new state. For async operations (enable/disable/delete), the script's built-in polling handles the wait — but confirm the final state before reporting success. Note that rule changes may take up to one hour to propagate to all edge locations — inform the user of this delay.

---

## Phase 5: Summarize and next steps

### 5.1 Data-only mode

In **data-only mode**, write a JSON data file to `<DATA_ONLY_DIR>/manage-firewall.json` with:

- `REPORT_TITLE` — `"Web Application Firewall"`
- `REPORT_DESC` — short description naming the site
- `SITE_NAME` — site display name
- `SUMMARY` — 2–3 plain-language sentences explaining whether the shield is on, how many rules are active, and whether anything important is missing
- `FINDINGS_DATA` — array of findings: severity buckets reflect "is the shield on" (off → `critical`), "are managed rule sets active" (none → `warning`), "is there at least one rate-limit rule" (none → `info`), "are there overly broad allow rules" (`*` → `critical`), etc. Use the agent's reasoning to decide severity rather than a hand-coded scoring script.
- `DETAILS_DATA` — `{ label: 'Rules', kind: 'table', columns: ['Name', 'Type', 'Action', 'Priority', 'Enabled'], rows: [...] }`

Then stop — the orchestrating skill handles presentation.

### 5.2 Present summary

Show a plain-language summary in the chat: whether the shield is on or off, how many rules are active, what changed, and any important gaps.

### 5.3 Record skill usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "ManageFirewall"`.

### 5.4 Offer follow-ups

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Anything else? | Add another rule; Turn the shield off again; Done for now |

---

## Constraints

- **Plain language with users** — never use words like WAF, OWASP, geo-block, rate-limit, ASN, ModSec, SocketAddr, or rule priority. Use everyday language and explain the technical name when asked.
- **Production sites only** — short-circuit early if the site is a trial or developer site. Do not attempt the operation.
- **Background long-running calls** — enable / disable are asynchronous. Run them via `run_in_background` and rely on the helper script's built-in polling.
- **Idempotent operations** — re-running the same action is safe. Track success / failure per call and continue on partial failures.
- **Never replace rules silently** — `set-rules.js` writes the full rule list; the skill must read existing rules first and merge them with the new rule unless the user explicitly chose "replace".
- **No company names in rule examples** — use generic names ("Allow-Office-IP", "Block-Bot-Traffic") and avoid referencing real organizations.

## Progress tracking table

Keep this table in your final response, filling each status as phases complete:

| Phase | Status |
|---|---|
| 1. Check prerequisites | ☐ |
| 2. Read current firewall state | ☐ |
| 3. Decide what to do | ☐ |
| 4. Apply the change | ☐ |
| 5. Summarize and next steps | ☐ |

## References

- `references/commands.md` — flags, response shape and error catalogue for the firewall scripts
- `references/rule-cookbook.md` — copy-paste rule shapes for common needs (block list, allow list, rate limit)
