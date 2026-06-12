---
name: manage-firewall
description: >-
  Inspects and configures the web application firewall (WAF) in front of a
  Power Pages production site. Lists the current state, recommends enabling
  protection when it is off, and walks the user through adding, updating,
  or removing custom rules — IP blocks, country blocks, path blocks, and
  rate limits. Use when the user wants to turn on WAF, block traffic by
  IP or country, rate-limit login or signup pages, protect pages from
  brute-force attempts, restrict access to specific paths, review the
  current firewall configuration, or asks "is my site protected against
  bots / common web attacks?" — even if they say "add rate limit" or
  "protect login page" without mentioning "firewall" or "WAF".
user-invocable: true
argument-hint: "[optional: --review <out-dir>]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Manage Web Application Firewall

Configure the firewall for a Power Pages production site. The firewall is only available on production sites and in supported regions — the scripts detect and report eligibility issues. After rule changes, edge propagation takes up to one hour.

**Initial request:** $ARGUMENTS

## Gotchas

- **Website record id vs portal id.** `.powerpages-site/website.yml` stores the website record id, not the portal id. Every script takes `--portalId`. Resolve once via `website.js --websiteId` during prerequisites.
- **Never resolve by name.** Site names can duplicate; only the website record id is safe.
- **Async operations.** `enable.js` and `disable.js` poll until the status reaches the target value (or timeout). `delete-rules.js` returns immediately (202) — verify via `get-rules.js`.
- **Concurrent-operation guard.** `B003` means another enable/disable is in flight. Poll status until it settles, then retry.
- **False-positive managed rule:** disable via a rule override (`EnabledState: "Disabled"` inside `RuleGroupOverrides` — managed rule fields use PascalCase).
- **First-match-wins.** Rules evaluate in priority order. A geo-allow-then-default-deny pattern requires an explicit default-deny rule AFTER the allow.
- **Custom rule priority range: 11–65000.** Values 1–10 are reserved for platform-managed rules.
- **`set-rules.js` is additive / update-only.** Send only rules being created or modified. The service merges them; existing rules not in the payload are untouched.
- **Use `delete-rules.js` to remove rules.** `set-rules.js` cannot remove. Always use `delete-rules.js --names`.
- **WAF state semantics — `Created` is the only "enabled" state.** `get-status.js` returns `value: "Created"` when the firewall is enabled and actively filtering (counter-intuitive — the API does NOT use `"Enabled"`). Any other value (`Disabled`, `None`, `Enabling`, `Disabling`, `Failed`) means no active policy exists. **MUST** call `get-status.js` first and only invoke `get-rules.js` when `value` is `Created` — otherwise the rules endpoint returns a 500 and the whole firewall section gets skipped in the report.

## Workflow

1. **Prerequisites** — Locate project, confirm sign-in, identify site, check eligibility
2. **Check firewall state** — Capture status and rules
3. **Choose an action** — Context-aware recommendation or question
4. **Apply the change** — Run the matching script, verify
5. **Summarize and next steps** — Present result, record usage, offer follow-ups

## Task Tracking

Create tasks in three groups. Mark each `in_progress` when starting, `completed` when done.

| Group | When to create | Tasks |
|-------|----------------|-------|
| 1 | At start | Check prerequisites |
| 2 | After prerequisites pass | Check firewall state · Choose an action (skip in review mode) |
| 3 | After user confirms an action | Apply the change (skip in review mode OR no change action was chosen) · Summarize and next steps (always) |

---

## 1. Prerequisites

### 1.1 Locate the project, detect review mode

Use `Glob` to find `**/powerpages.config.json`. If `$ARGUMENTS` contains `--review <out-dir>`, remember the output directory — Steps 3–4 are skipped and Step 5 writes JSON only.

### 1.2 Resolve site identifiers

Read `.powerpages-site/website.yml` → extract `id` field → that is `<WEBSITE_ID>`.

If missing, the site has not been deployed. Tell the user and recommend `/deploy-site`. Stop. Do **not** resolve by name or URL.

Resolve to portalId:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/website.js" --websiteId "<WEBSITE_ID>"
```

Capture `Id` (portalId), `Type`, `Name`, `WebsiteUrl`. If exit code `2` → sign-in required (`pac auth create` or `az login`). If `null` → site not found in this environment. Stop in either case.

### 1.3 Eligibility

Check the `Type` field and the script responses for eligibility. The scripts return specific error codes for ineligible sites (non-production, unsupported region, restricted feature). Read `references/commands.md` § "Common error catalogue" and § "Regional availability" for the full list.

If the site is ineligible, tell the user in plain language what the limitation is and stop.

---

## 2. Check firewall state

### 2.1 Get status (always run first)

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-firewall/scripts/get-status.js" --portalId "<PORTAL_ID>"
```

The response shape is `{ "status": "ok", "value": "<state>" }`.

- `Created` — WAF is enabled and filtering. Proceed to **2.2** to fetch rules.
- Any other value (`Disabled`, `None`, `Enabling`, `Disabling`, `Failed`, etc.) — **WAF is not enabled**. **MUST NOT** call `get-rules.js` — the rules endpoint will return a 500 because no active policy exists to read. Skip **2.2** and treat the rules payload as empty: `{ "status": "ok", "body": { "CustomRules": [], "ManagedRules": [] } }`.

If the status response is `"status": "unsupported"`, tell the user the firewall is not available and stop.

### 2.2 Get rules (only when WAF is enabled)

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-firewall/scripts/get-rules.js" --portalId "<PORTAL_ID>"
```

Both scripts output the full response as JSON to stdout. If `get-rules.js` returns `"status": "unsupported"`, tell the user the firewall is not available and stop.

---

## 3. Choose an action

Skip in **review mode**.

MUST use plain language only with the user. Never use words like WAF, OWASP, ModSec, ruleset, geo-block, rate-limit, ASN, SocketAddr, or rule priority.

Each `AskUserQuestion` call is a **separate** call. Wait for the user's answer before asking the next.

### Default approach

<!-- gate: manage-firewall:3.action-choice | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · manage-firewall:3.action-choice):** Recommend an action based on the site's current state, then ask the user to accept or choose differently. Fires once per Phase 3 entry — loops back here if the user wants to make additional changes after Phase 4 applies the first one.
>
> **Trigger:** Phase 3 entry (interactive mode only — skipped in review mode).
> **Why we ask:** Wrong-action firewall changes are visible to every site visitor; auto-recommend without consent can disable an active rule the maker added deliberately.
> **Cancel leaves:** Nothing — Phase 4 hasn't fired yet.

Analyze the site's current state (firewall status, existing custom rules, managed rules, region eligibility) and **recommend the single most relevant action**. Present the recommendation via `AskUserQuestion`:

- Firewall off → recommend enabling it.
- Firewall on, no custom rules → recommend adding a rule if there is a clear gap (e.g., no rate limiting). Otherwise, summarize the state and ask if the user wants to add a rule.
- Firewall on, rules exist → summarize what is configured and ask what the user wants to do.

If the site's state does not warrant a specific recommendation, do not force one — ask what the user wants to do.

MUST NOT proactively offer actions that reduce security (disabling the firewall, removing managed rules, weakening existing rules). If the user needs those, they will ask.

### Option rules

<!-- not-a-gate: meta-documentation describing how to structure `AskUserQuestion` options in this skill — not a literal call site. The actual destructive firewall changes (enable/disable/add-rule/remove-rule) are gated by the prose-described "apply only after user approval" rule in §3 Plan-validate-execute and §4 Apply the change. See approval-gates.md §6.24a + §6.25. -->

When presenting options via `AskUserQuestion`:
- Keep `label` to 1–5 words. Include `description` on every option.
- Include `preview` **only** when the option represents a concrete change (create, update, or delete a rule) — use it to show the configuration that will be applied so the user can review before approving. Do not add `preview` to navigation or informational choices.
- Only show options that are actionable given the current state. Omit options for features the site cannot use (check `references/commands.md` § "Regional availability").
- Mark "(Recommended)" only when there is a genuine, context-based reason. If nothing stands out, do not mark any.
- When offering to add a rule type that already exists on the site, acknowledge it in the `description` — include the count and summarize what is configured so the user can decide whether to add or update.
- For path-based rules, reference actual page paths from the project structure when known. Fall back to generic language only when no project context is available.

### Rule type follow-up

When the user picks "Add a rule", ask a follow-up for the rule type. The same option rules apply. Translate the answer into `set-rules.js` parameters — keep the user out of priority-numbering and rule-naming details. Read `references/rule-reference.md` for rule shapes.

### Remove a rule

List current custom rules showing: what each rule does (plain language), what traffic it matches, whether it blocks or allows, and its priority relative to others. If removing a rule would break a deny/allow pattern, warn before proceeding.

### Plan-validate-execute

<!-- gate: manage-firewall:3.execute-consent | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · manage-firewall:3.execute-consent):** Final consent before any destructive WAF mutation (enable/disable, add/update/delete rule). Echoes the proposed JSON payload + the surfaced validation issues. Fires PER CHANGE — each enable, disable, rule add, rule update, and rule delete is its own consent.
>
> **Trigger:** Phase 3 action chosen, plan + validation surfaced.
> **Why we ask:** Firewall changes are env-level and visible to every site visitor; auto-applying can lock out legitimate traffic or weaken protection.
> **Cancel leaves:** Nothing — the API call hasn't fired yet; the plan + validation are throwaway.

For all rule changes:

1. **Plan** — build the JSON payload containing only the rules being added or updated.
2. **Validate** — check the plan against the existing rule set and surface:
   - Priority conflicts with existing rules
   - Overlapping match conditions (same `matchVariable`/`operator`, overlapping `matchValue`) — explain which rule wins via first-match-wins
   - Contradictions between Allow and Block rules — flag and explain priority implications
   - Redundancy — suggest updating the existing rule instead of adding a duplicate
3. **Execute** — apply only after user approval via `AskUserQuestion`:

For deletions, show the rule names and what each currently does before proceeding.

In **review mode**, skip this step entirely.

---

## 4. Apply the change

Skip in **review mode**.

| Action | Script |
|--------|--------|
| Enable | `enable.js --portalId <id>` |
| Disable | `disable.js --portalId <id>` |
| Add / update rules | `set-rules.js --portalId <id> --data-inline '<json>'` |
| Remove rules | `delete-rules.js --portalId <id> --names <comma-separated>` |

Run enable/disable with `run_in_background: true` (async operations with built-in polling).

Before applying, show only the disclosure relevant to the action being taken:
- **Enabling:** managed rule set enforces immediately; some legitimate requests may be blocked until reviewed.
- **Disabling:** site is unprotected until re-enabled.
- **Adding / updating rules:** propagation takes up to an hour. If the rule uses Allow, explain it creates an exception even when block rules would apply.
- **Deleting rules:** matched traffic is no longer blocked (or allowed). If the rule was an Allow exception in a deny pattern, warn that traffic will now be blocked.
- **Disabling a managed rule:** that attack category is no longer inspected — name the category.

After completion, re-run status and rules calls to verify the new state.

---

## 5. Summarize and next steps

### 5.1 Review mode

Apply the same status-then-rules gating as § 2 — `get-rules.js` MUST only be invoked when the status `value` is `Created`. For any other value the WAF policy does not exist and the rules endpoint will return 500; the orchestrator must write the empty-rules payload directly instead of calling the script.

**Step A — always run status:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-firewall/scripts/get-status.js" --portalId "<PORTAL_ID>" > "<REVIEW_DIR>/firewall-status.json"
```

**Step B — branch on the captured `value`:**

- If `value` is `Created`, fetch rules:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/manage-firewall/scripts/get-rules.js" --portalId "<PORTAL_ID>" > "<REVIEW_DIR>/firewall-rules.json"
  ```

- Otherwise (`Disabled`, `None`, `Enabling`, `Disabling`, `Failed`, anything else), do NOT call `get-rules.js`. Write the empty-rules payload yourself:

  ```json
  { "status": "ok", "body": { "CustomRules": [], "ManagedRules": [] } }
  ```

After capturing the raw output, **read both files** and write `<REVIEW_DIR>/firewall-annotations.json` with plain-language descriptions of the state and each rule (the transform script no longer hardcodes these — they come from you):

```json
{
  "state": {
    "description": "Plain-language explanation of what \"<value>\" means — is the firewall actively filtering requests, or not?",
    "fix": "Optional — include only if the state genuinely needs action."
  },
  "rules": {
    "<RuleName>": { "description": "What this rule does, in plain language.", "fix": "Optional fix if the rule has a genuine issue." }
  }
}
```

Power Pages WAF state semantics (use these when writing the state description — do not invent meanings):
- `Created` — WAF is enabled. The firewall is active and filtering requests.
- `Disabled` — WAF is not enabled and no firewall policy exists. The site is unprotected.
- `None` — no firewall policy has ever been provisioned. Same user-facing meaning as `Disabled`.
- `Enabling` / `Disabling` — operation in progress; wait.
- `Failed` — last enable/disable operation failed.

Then run the transform:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-firewall/scripts/transform-firewall.js" \
  --statusFile "<REVIEW_DIR>/firewall-status.json" \
  --rulesFile  "<REVIEW_DIR>/firewall-rules.json" \
  --annotations "<REVIEW_DIR>/firewall-annotations.json"
```

Write the transform stdout to `<REVIEW_DIR>/manage-firewall.json` and stop. The transform emits `{ status, findings }`; the orchestrating skill handles presentation.

### 5.2 Present summary

Plain-language summary: firewall on/off, rule count, what changed, important gaps.

### 5.3 Record skill usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "ManageFirewall"`.

### 5.4 Offer follow-ups

If a natural follow-up action exists based on the site's verified post-action state, suggest it. Do not offer actions that reduce security. If no meaningful follow-up exists, end the skill — do not ask just to ask.

---

## Constraints

- **Plain language** — MUST NOT use technical jargon with the user. Use everyday language; explain the technical name only when asked.
- **Eligibility** — MUST short-circuit on ineligible sites (non-production, unsupported region). The scripts detect these — read `references/commands.md` for the full error catalogue.
- **Background ops** — MUST run enable/disable via `run_in_background`.
- **Send only what changes** — `set-rules.js` payload MUST contain only new or modified rules.
- **Rule naming** — PascalCase, letters and numbers only (e.g., `BlockCountries`, `AllowOfficeIP`).
- **No company names** — use generic names in rule examples.
- **Context-aware interactions** — every question, option, follow-up, and disclosure MUST reflect the site's current state:
  - Never offer options that don't apply (e.g., "Remove a rule" when none exist).
  - Acknowledge existing rules of the same type when offering to add a new one.
  - Reference actual site page paths in descriptions when known from the project.
  - Check new rules against existing rules for conflicts, overlaps, contradictions, and redundancy before presenting the plan.
  - Show only the disclosure relevant to the action being taken.
  - Never proactively suggest reducing protection.
- **Preview is for change review only** — include `preview` only on options representing a concrete change the user needs to approve. Do not add to navigation or informational choices.

## References

- `references/commands.md` — script flags, response shapes, error catalogue, regional availability. Read § "Common error catalogue" when a script returns a non-zero exit code. Read § "Regional availability" during eligibility checks.
- `references/rule-reference.md` — field-level schema for custom rules, match conditions, managed rule overrides, match variables, operators, and priority bands. Read when building a rule plan.
