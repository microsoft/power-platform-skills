# How `manage-governance` Works

A brief guide to the Power Pages **Manage Governance Policies** skill — what it
does, how a request flows through it, and which pieces do what.

## Temporary disablement

**Status: disabled pending Product approval.** The workflow is preserved in
`SKILL.disabled.md`; there is deliberately no `SKILL.md` in this directory.
Without that entry point, plugin skill discovery cannot register it for
manual or automatic invocation. Scripts and tests remain available for
development; this is not an API access restriction.

To enable it when Product approves:

1. Rename `SKILL.disabled.md` back to `SKILL.md`.
2. Restore the two `manage-governance` rows in
   `../../references/approval-gates.md` from Kind `disabled` to `gate`.
3. Update the disabled-entry test paths/assertions and enabled-skill
   documentation, then run the governance tests and approval-gate lint.
4. Reload the plugin or start a fresh session.

Existing installed copies and sessions that already loaded the skill are
not revoked by this source change; they must update/reload as well.
The sections below describe the preserved workflow, not an enabled skill.

## What it does

Applies and inspects **environment-level Power Pages governance policies**
against any environment the signed-in admin has access to. Twenty-one policies
are supported: Maker Copilot for existing sites, nine authentication toggles
(sign-in protocols, social identity providers, local login, and external
providers), and eleven `PowerPages_*` Copilot / site-control policies.
Include / Exclude scopes can target multiple selected sites. Each policy can be turned on/off for
**every site**, **no sites**, **only specific sites**, or **all except specific
sites**.

It is an **admin-only, environment-scoped** skill — it does **not** need a
`powerpages.config.json` project root.

## The three operations

| Operation | Intent | What it does |
|-----------|--------|--------------|
| **Apply** (`apply`) | "Enable/Disable X …" | POST the policy, poll to a terminal state, then verify. |
| **Fetch Env** (`fetchEnv`) | "Show/Is X … in \<env\>" | Read the env-wide value and render every site's state. |
| **Fetch Site** (`fetchSite`) | "Is X on \<site\>?" | Read one site's state. |

## Request flow

```
User free-text intent
      │
      ▼
[2.1] Parse intent  ──►  { policy, direction, envId, scope, siteIds, … }
      │                  (policy shorthands + intent→policyValue from JSON)
      ▼
[2.2] Validate + fill gaps
      │   • Env resolution → fresh inventory; exact supplied name/ID skips picker
      │   • Env picker if needed → render-env-table.js (full list, default flagged)
      │   • Scope       → list-portals.js  (all / specific sites)
      ▼
[4.2.3 Step 1b] Redundant-op guard (if already in requested state)
      │   → ask eligible-site scope: "All" (no-op) vs comma-separated sites
      ▼
[4.2.3] Impact Summary in assistant message  ──►  render-impact-summary.js
      │   (Rendered Markdown sites table, Current → New State, warnings/cascades)
      ▼
[4.2.3] Consent form: short question only, Apply now / Cancel
      ▼
[4.2.4] Apply  ──►  set-governance.js  (POST + poll /governance/status)
      ▼
[4.2.5] Verify  ──►  get-effective-status.js  +  render-portal-table.js
      ▼
[5] Loop: re-prompt for the next request, or exit
```

## Workflow contracts

This overview is not a second copy of the execution rules. The required
procedures linked from `SKILL.disabled.md` own each contract:

| Procedure | Contract |
|-----------|----------|
| [selection.md](references/selection.md) | Mapping-driven intent parsing, fresh validation of supplied environment names/IDs, full picker only when needed, site display and parsing |
| [apply.md](references/apply.md) | Eligibility, parent remediation/resumption, redundant-op guard, collateral changes, additive membership/removals, impact preparation |
| [Preserved workflow Phase 4.2.3](SKILL.disabled.md#423-confirm-before-posting) | One explicit Apply now / Cancel approval per change, including prerequisite parents |
| [status.md](references/status.md) | Batched reads, effective state, complete five-column status output, verification and internal rollout status |

Policy semantics, shorthands, side effects, and cascades live in
`references/governance-mapping.json`. Terminal-status classification lives in
`scripts/policies.js`; script flags, response shapes, and exit codes live in
`references/commands.md`.

All tables render in assistant messages, including environment selection,
site selection/eligibility, impact, and final status. Input forms follow the
table and contain only short plain-text prompts: putting Markdown tables
inside a form can display the source text instead of a rendered grid.

## Files

### Scripts (`scripts/`)

| File | Role |
|------|------|
| `list-envs.js` | List all environments the admin can access. |
| `render-env-table.js` | Render the env picker table (Markdown or ASCII box). |
| `list-portals.js` | List the sites in an environment. |
| `parse-portal-input.js` | Resolve free-text site names/IDs to portal IDs. |
| `render-impact-summary.js` | Render the consent-gate Impact Summary with a Markdown site table. |
| `set-governance.js` | POST the policy + poll to a terminal state. Supports `--portalIds` (`ToBeAdded`) and `--removePortalIds` (`ToBeRemoved`) to grow/shrink an Include/Exclude list. |
| `get-env.js` | Read the env-wide policy value. |
| `get-portal.js` | Read a single site's inclusion/exclusion state. |
| `get-status.js` | Read the last rollout status for a policy. |
| `fetch-env-status.js` | Batch the environment site list and policy/parent reads for Fetch Env. |
| `get-effective-status.js` | Batch policy/parent reads to compute effective site states for consent, Fetch Site, and verification. |
| `resolve-portal-availability.js` | Partition a site list into available / unavailable for a child auth policy based on its parent policies' state (fail-open). Renders unavailable sites below available ones with the blocking parent named. |
| `render-portal-table.js` | Render the Markdown site state table (🟢/🔴); fixed-width modes are also available. |
| `policies.js` | Frozen `SUPPORTED_POLICIES` list + write-vocabulary mapping. |
| `governance-context.js` | Resolves the API context; applies `--envId` override. |
| `governance-route.js` | Builds the gateway URL and body for each op. |
| `governance-transport.js` | Single network entry-point; issues the gateway call. |
| `colors.js` | ANSI green/red helpers for state cells. |

### References and documents

| File | Role |
|------|------|
| `governance-mapping.json` | **Single source of truth** — policies, shorthands, intent→policyValue, cascade data, effect-line templates, state colors/paraphrases. |
| `commands.md` | Script flags, response shapes, exit codes, polling semantics. |
| `selection.md` | Intent, environment, and site-selection procedures. |
| `apply.md` | Apply eligibility, remediation, impact, and submission procedures. |
| `status.md` | Read, verification, and canonical output procedures. |
| `Document/external-auth-governance-details.md` | Behavior and test guide for External Auth as the parent auth-governance setting, including Admin Center testing, child protocol / IdP effects, and expected skill UI flow. |

### `SKILL.disabled.md`

The preserved orchestrator spec (not discoverable while disabled) defines
phases, prompts, env-picker and consent-gate rules. Reads all mappings from
`governance-mapping.json`.

## Transport

All governance traffic uses a single transport — the **gateway**:
`https://api.powerplatform.com/powerpages/environments/{envId}`, authenticated
with an Azure CLI bearer (needs `PowerPages.Websites.*` admin consent). To target
a non-production ring during testing, set the `PP_GOV_API_HOST` and
`PP_GOV_TOKEN` env vars (see `governance-context.js`) — these redirect the same
gateway transport without hardcoding any host.

## Exit codes (`set-governance.js`)

| Code | Meaning |
|------|---------|
| `0` | Rollout reached success. |
| `2` | Sign-in required (`pac auth create` / `az login`). |
| `3` | Polling timed out. |
| `4` | Terminal state reached but `Failed`. |
| `1` | Other failure. |
