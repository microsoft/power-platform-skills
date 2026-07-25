---
name: manage-governance
description: >-
  Apply, inspect, and monitor Power Pages tenant governance policies. Covers
  ten policies: toggling Maker Copilot for existing sites, and enabling/disabling
  sign-in protocols (OpenID Connect, SAML 2.0, WS-Federation, OAuth 2.0), social
  identity providers (Google, Facebook, Microsoft), local login, and external
  auth providers. Sets a policy environment-wide or per portal, watches the
  rollout to completion, and reads current state at the environment or portal
  level. Use when the user wants to "turn off OpenID Connect on Power Pages",
  "disable SAML on a portal", "block a sign-in protocol on portals",
  "enable/disable Maker Copilot for existing sites", "enable Google/Facebook/Microsoft sign-in",
  "turn off local login", "disable a sign-in protocol", "check which portals have
  a sign-in protocol enabled", or "see the governance status of my Power Pages portals"
  - even if they only name the policy or its side effect without saying
  "governance".
user-invocable: true
argument-hint: "[optional policy or operation hint]"
allowed-tools: Read, Write, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Manage Power Pages Governance Policies

Apply and inspect Power Pages tenant-level governance policies. Ten policies are supported today. One toggles Maker Copilot for existing sites, and nine enable/disable Power Pages authentication features (sign-in protocols, social identity providers, local login, and external providers):

| Policy | What it does |
|--------|--------------|
| `EnableMakerCopilotForExistingSites` | Turns Maker Copilot on (or off) for existing Power Pages sites in the environment. |
| `EnableProtocolOpenIdConnect` | Enables (or disables) the OpenID Connect sign-in protocol on Power Pages sites. |
| `EnableProtocolSAML20` | Enables (or disables) the SAML 2.0 sign-in protocol on Power Pages sites. |
| `EnableProtocolWsFederation` | Enables (or disables) the WS-Federation sign-in protocol on Power Pages sites. |
| `EnableProtocolOpenAuth` | Enables (or disables) the OAuth 2.0 sign-in protocol on Power Pages sites. |
| `EnableIdpOAuthFacebook` | Enables (or disables) Facebook sign-in on Power Pages sites. |
| `EnableIdpOAuthGoogle` | Enables (or disables) Google sign-in on Power Pages sites. |
| `EnableIdpOAuthMicrosoft` | Enables (or disables) Microsoft sign-in on Power Pages sites. |
| `EnableAuthenticationLocalLogin` | Enables (or disables) local (username & password) sign-in on Power Pages sites. |
| `EnableExternalAuthProviders` | Enables (or disables) all external (social / federated) identity providers on Power Pages sites. |

These are **admin-only** operations — applying an auth policy stops or starts the relevant authentication path for the targeted scope, and the Maker Copilot policy toggles the Copilot authoring experience for existing sites (environment or portal scope). All nine `Enable*` authentication policies use the **same configuration and Enable/Disable experience** as `EnableMakerCopilotForExistingSites` — uniform governance (every site / no sites / only specific sites / all except specific sites), the same consent gate, and the same verify tables. Always confirm with the user before posting a Set call.

**Initial request:** $ARGUMENTS

## Gotchas

- **Tenant-admin skill, not project-scoped.** Unlike most Power Pages skills, this one does **not** require a `powerpages.config.json` in the current directory. It works against any environment the signed-in user has Power Platform admin access to.
- **Two identifier shapes per portal.** The portal-scoped APIs take `portalId` (the value in the `Id` field on the `/websites` response). The Dataverse `WebsiteRecordId` shown in PAC and YAML is **not** what these APIs accept. The skill resolves portals via the same `/websites` listing that `manage-firewall` uses.
- **Env override is required.** The skill lets the user pick any environment they have access to. Each script accepts `--envId <guid>` and overrides the env in the Power Platform API base URL. When `--envId` is omitted, the script falls back to the env the user is signed into via PAC.
- **Set is async; poll until terminal.** `POST /governance` returns immediately but the policy roll-out is asynchronous. Status comes from `GET /governance/status/{policy}`. The `set-governance.js` script polls this endpoint until the status reaches a terminal value (`Succeeded` / `Completed` for success, `Failed` for failure) or the timeout elapses.
- **Policy names are case-sensitive.** Use the exact policy strings — `EnableMakerCopilotForExistingSites`, `EnableProtocolOpenIdConnect`, `EnableProtocolSAML20`, `EnableProtocolWsFederation`, `EnableProtocolOpenAuth`, `EnableIdpOAuthFacebook`, `EnableIdpOAuthGoogle`, `EnableIdpOAuthMicrosoft`, `EnableAuthenticationLocalLogin`, and `EnableExternalAuthProviders`. Anything else will be rejected by the API.
- **Plain language with the user.** Talk about "turning off the OpenID Connect / SAML sign-in path on Power Pages portals" or "enabling Google sign-in on your sites". Only show the policy string when the user asks for the technical name.
- **OpenID Connect / SAML map to the protocol toggles.** "OpenID Connect" / "OIDC" resolves to `EnableProtocolOpenIdConnect` and "SAML" / "SAML 2.0" resolves to `EnableProtocolSAML20` — whether or not the user adds a "protocol" / "enable" qualifier. (The legacy `PowerPages_DisableAuthentication*` block rules have been removed.) A "block OpenID Connect" / "block SAML" phrasing means **disabling** that protocol toggle.
- **No silent overrides.** **Disabling** any `Enable*` authentication policy (`EnableProtocol*`, `EnableIdp*`, `EnableAuthenticationLocalLogin`, `EnableExternalAuthProviders`) will sign existing users out of any portal that uses the targeted provider. Surface that consequence at the consent gate before posting. (The Maker Copilot policy has no such sign-out side effect.)

## Workflow

1. **Prerequisites** — Confirm PAC CLI + Azure CLI sign-in
2. **Understand the request** — parse the user's free-text intent (policy,
   enable/disable, environment, scope) via Phase 2.1
3. **Resolve missing pieces + consent** — env picker, scope, consent gate
4. **Run the operation** — Apply / Fetch Env / Fetch Site
5. **Loop or finish** — Offer the next operation, or exit

## Task Tracking

Create tasks in three groups. Mark each `in_progress` when starting, `completed` when done.

| Group | When to create | Tasks |
|-------|----------------|-------|
| 1 | At start | Check prerequisites · Parse intent · Resolve env/scope |
| 2 | After operation resolved | Run operation (Apply / Fetch Env / Fetch Site) |
| 3 | After operation result | Summarize and offer follow-up |

---

## 1. Prerequisites

Confirm two things:

- `pac auth who` exits 0 → PAC CLI is signed in.
- `az account show` exits 0 → Azure CLI is signed in.

If either is missing, tell the user which CLI to sign in to and stop. Do **not** require a Power Pages project root for this skill.

---

## 2. Entry point + background pre-warm

The moment the skill is invoked:

1. **Fire `list-envs.js` in the background** so the env list is ready by the
   time the user needs to specify an env. The first user-facing prompt
   should not block on it. Cache the result in `/tmp/governance-envs.json`
   for the rest of the run.
2. **Go straight to the Phase 2.1 free-text intent prompt.** Do **NOT** show a
   top-level `AskUserQuestion` menu (no "Manage a Governance Setting" / "Done"
   choice list, and no numbered/multiple-choice entry menu of any kind). The
   very first user-facing prompt is the Phase 2.1 prose question — ask it
   directly.

If the user replies that they are done (e.g. "done", "that's all", "exit",
"nothing"), exit cleanly without doing anything else.

## 2.1 Free-text intent prompt

Ask the user (prose, free text — NOT an `AskUserQuestion`):

> *"Tell me what you'd like to do. Examples:*
> *- 'Enable OpenID Connect for all portals in Sachin-Jun-2nd'*
> *- 'Disable OpenID Connect on Site 1 and Site 2'*
> *- 'Enable Maker Copilot on all sites in this environment'*
> *- 'Enable Google sign-in on all sites in this environment'*
> *- 'Disable local login on Site 1'*
> *- 'Show the SAML 2.0 status in this environment'*
> *- 'Is OpenID Connect enabled on the 8-june site?'"*

Parse the reply into a structured intent. The parser's output shape:

```json
{
  "intent": "apply" | "fetchEnv" | "fetchSite",
  "policy": "<PolicyName>" | null,
  "policyDisplayName": "<Display Name>" | null,
  "intentDirection": "enable" | "disable" | "view",
  "envId": "<guid>" | null,
  "envDisplayName": "<name>" | null,
  "scope": "All" | "None" | "Include" | "Exclude" | null,
  "siteIds": ["<guid>", ...],
  "siteNames": ["<name>", ...],
  "confidence": 0.0..1.0,
  "ambiguities": [ "..." ]
}
```

The parser MUST recognize all ten supported policy display names + their
shorthand variants. All policies share the **same** uniform Enable/Disable
experience — the auth `Enable*` family below is configured exactly like
`EnableMakerCopilotForExistingSites`.

| User shorthand | Resolves to |
|----------------|-------------|
| "Maker Copilot" / "Copilot" / "Maker Copilot for existing sites" | `EnableMakerCopilotForExistingSites` |
| "OpenID Connect" / "OIDC" / "OpenIdConnect" / "OpenID Connect protocol" / "enable OpenID Connect" | `EnableProtocolOpenIdConnect` |
| "SAML" / "SAML 2.0" / "SAML20" / "SAML 2.0 protocol" / "enable SAML" | `EnableProtocolSAML20` |
| "WS-Federation" / "WsFederation" / "WsFed" | `EnableProtocolWsFederation` |
| "OpenAuth" / "OAuth 2.0 protocol" / "OAuth protocol" | `EnableProtocolOpenAuth` |
| "Facebook" / "Facebook login" / "Facebook sign-in" | `EnableIdpOAuthFacebook` |
| "Google" / "Google login" / "Google sign-in" | `EnableIdpOAuthGoogle` |
| "Microsoft" / "Microsoft account" / "Microsoft sign-in" | `EnableIdpOAuthMicrosoft` |
| "local login" / "local authentication" / "username and password" | `EnableAuthenticationLocalLogin` |
| "external auth providers" / "external identity providers" | `EnableExternalAuthProviders` |

> **OpenID Connect / SAML now map straight to the protocol toggles.** The legacy
> `PowerPages_DisableAuthentication*` block rules have been removed, so
> "OpenID Connect" / "OIDC" resolves to `EnableProtocolOpenIdConnect` and
> "SAML" / "SAML 2.0" resolves to `EnableProtocolSAML20` — with or without a
> "protocol" / "enable" qualifier. A "block OpenID Connect" / "block SAML"
> phrasing means **disabling** that protocol toggle (env-wide disable = `None`).

> **Read the shorthands from the JSON.** The authoritative shorthand list for
> every policy lives in `references/governance-mapping.json` under each policy's
> `userShorthands`. The table above is a convenience summary — resolve against
> the JSON at parse time.

And map the `intentDirection` + scope qualifier to a `policyValue`. The
mapping is **uniform across all policies** — the verb attaches to the
Governance Setting itself, not to the underlying protocol or feature.

> **Source of truth (READ IT):** load `references/governance-mapping.json` and
> use the `intentToPolicyValue` array for this mapping. Each row gives
> `intentDirection` + `scope` (`all` / `specific`) + `scopeQualifiers` →
> `policyValue` + `toBeAdded` (`empty` or `pickedIds`). Do not rely on an
> inline copy — read the JSON at parse time.

The consent gate's **Effect** line restates **the user's operation in
plain English** — what they typed, normalized. It is the user-facing
check that the orchestrator parsed the intent correctly. The API mapping
line already shows the technical translation (`policyValue` + ToBeAdded),
so the Effect line does NOT need to repeat that detail; it covers the
intent side.

Effect-line template — read the `effectLineTemplates` array from
`governance-mapping.json` and pick the row matching the parsed
`intentDirection` × `scope` (`all` / `specific`). Substitute `{Subject}`,
`{EnvDisplay}`, and `{SiteNameList}` into the template.

`{Subject}` = the plain-English name of the thing being enabled / disabled —
read it from the matching policy's `subject` field in
`governance-mapping.json` (`policies[].subject`).

Concrete renderings:

- "Enable OpenID Connect on all portals in Sachin-Jun-2nd" → Effect: *"OpenID Connect sign-in will be enabled on all portals in Sachin-Jun-2nd."*
- "Disable SAML on Site 1 and Site 2" → Effect: *"SAML 2.0 sign-in will be disabled on the listed portals in &lt;env&gt;: Site 1, Site 2."*
- "Enable OpenID Connect everywhere" → Effect: *"OpenID Connect sign-in will be enabled on all portals in &lt;env&gt;."*

If the user uses an "everywhere except X" phrasing (e.g., *"Disable OIDC
everywhere except Site 1"*), the orchestrator MUST ask the user to
re-phrase it as either *"Enable for X"* or *"Disable for X"* so the
uniform mapping applies cleanly. Don't try to auto-invert.

## 2.2 Validate, ask for missing pieces, take consent, then submit

After parsing, validate each field. Ask the user ONLY for the missing or
ambiguous ones — never re-ask for what the user already specified.

| Field | Missing → ask user | Invalid → reject + reprompt |
|-------|--------------------|------------------------------|
| `policy` | "Which governance setting? For example OpenID Connect, SAML 2.0, Maker Copilot, a sign-in protocol (WS-Federation / OAuth), a social provider (Google / Facebook / Microsoft), local login, or external providers?" | "I don't recognize '\<X\>' — supported settings are the ten governance policies (Maker Copilot, the OpenID Connect / SAML 2.0 / WS-Federation / OAuth 2.0 protocols, Google / Facebook / Microsoft sign-in, local login, external providers). Try again." |
| `intentDirection` | "Do you want to enable or disable it?" | — |
| `envId` | Use the env picker (see "Env picker pattern" below): list all envs and default to the previously-used env. Track the env from the most recent successful operation as `<RECENT_ENV>` so it becomes the default selection; persist the chosen env id as `<ENV_ID>` and the display name as `<ENV_DISPLAY>`. | "I couldn't find an env matching '\<X\>'. Pick a row from the list or paste an id." |
| `scope` (when `apply`) | "Apply to all sites in \<env\>, no sites, only selected sites, or all except selected?" — only when the user's phrasing was genuinely ambiguous | — |
| `siteIds` (when scope is `Include`/`Exclude`) | "Which sites? Names or IDs, comma-separated. Here's the list: …" | "I couldn't find a site named '\<X\>' in \<env\>." |
| `portalId` (when intent=`fetchSite`) | "Which site? Names or IDs…" | "Couldn't find '\<X\>' in \<env\>." |

Phrases the parser treats as unambiguous and skips the scope prompt for:

- "for all portals" / "across the env" / "everywhere" / "for live portals" /
  "for running portals" — all map to "every portal in this env"
- "for no portals" / "clear the policy" → `policyValue=None`
- "for just X" / "only on X" / "for X and Y" → `Include` with the named sites
- "for everything except X" / "all except X" → `Exclude` with the named sites

### Env picker pattern (list-all + default-to-previous)

> **Rule 0 — display the environment list table FIRST, every time.** The very
> first thing the orchestrator emits whenever an env is needed is the
> **complete** environment list as a rendered Markdown table (produced by
> `render-env-table.js --markdown`). The table MUST be visible in the **same
> message** that asks the user to choose — never ask "which environment?" in a
> message (or a bare `AskUserQuestion`/pop-up) that does not itself contain the
> full table. Show the table, then, directly beneath it, prompt the user to
> reply with a **row #**, **environment name**, or **environment ID** (or
> `keep` to accept the flagged default, `cancel` to stop). If the user re-asks,
> can't see the list, or submits any new operation, re-render the whole table
> again before doing anything else. Displaying the table is mandatory and
> load-bearing — skipping it, truncating it, or asking without it is a defect.

> **Rule 0b — ALWAYS show the site (portal) list immediately after the
> environment is selected, then ask the user to pick the scope.** The moment an
> env pick resolves (whether the user typed `keep`, a row #, a name, or an id —
> and including the case where the env was named directly in the request), the
> orchestrator's **very next action** is to run `list-portals.js` for that env
> and render the site list as a table (Portal Name / Portal URL / Portal ID).
> **Directly beneath the table, prompt the user to choose the scope:** reply
> **`all`** to apply to every site in the environment, or a **comma-separated
> list of site names or IDs** to apply to only those specific sites (plus
> `cancel` to stop). This is unconditional and applies to **every** operation —
> Apply, Fetch Env, and Fetch Site alike — and to every loop iteration. Do NOT
> skip straight to the impact summary or any `get-*` / `set-*` call before the
> site list is visible and the user has chosen `all` vs specific sites in the
> same or immediately preceding exchange. If the env has more than 10 sites,
> render the top 10 via `orderPortalsForDisplay()` and note "Showing 10 of
> &lt;total&gt; — type any site name or ID, or 'all'". Only when the env
> genuinely has zero sites do you skip the table — and then you say so
> explicitly. Proceeding without showing the site list and taking the scope
> reply after env selection is a defect.

When an env is needed (missing or ambiguous), the orchestrator MUST:

1. **List all environments.** ALWAYS render the **complete** env list by
   running the `render-env-table.js` helper with `--markdown`, and emit its
   output **verbatim as a Markdown table** (a real table renders reliably in
   chat UIs; the ASCII box collapses to blank on surfaces that don't render
   fenced code blocks). Do not hand-build the table — always produce it via the
   helper so the rows, numbering, and current-selection marker stay
   deterministic and testable.

   **Show every row, on every pick.** This applies to the **first** pick AND to
   **every subsequent pick** (including "Apply/Check the same policy somewhere
   else" and any re-entry into the env picker). Emit **all** rows the helper
   prints — do NOT truncate, abbreviate, summarize, or collapse the table to
   only the default / current-selection row. The user must always see the full
   list so they can switch to any environment. The `keep`/default row is a
   convenience, not a replacement for showing the list.

   **Render the env picker on EVERY new user request / operation.** Every time
   the user submits a new input that starts or re-enters an operation (Apply,
   Fetch Env, Fetch Site — including each loop iteration and each new intent the
   user types), the orchestrator MUST render the full env-list table again
   **before** doing anything else for that request. NEVER silently reuse
   `<RECENT_ENV>` and skip straight to the site list / operation. The recent env
   is only pre-flagged in the **Selected** column; the user still sees the whole
   list and confirms with `keep` or switches. Showing the site picker or running
   any `get-*` / `set-*` call without first re-rendering the env list is a
   defect.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-env-table.js" \
     --envsFile <cached-governance-envs.json> --markdown [--current "<RECENT_ENV_ID>"]
   ```

   The helper (with `--markdown`) prints a GitHub-flavored Markdown table with
   exactly a row-number column, a marker column, **Environment Name**, and
   **Environment ID** — no URL, type, or region. Emit it directly as a table
   (NOT wrapped in a code fence — that would show the raw pipes instead of a
   rendered table).

   **Hard rule — the env list is NEVER optional and NEVER hidden.** Displaying
   the full environment list is a mandatory, load-bearing step of *every* env
   pick. The orchestrator MUST NOT ask the user to choose an environment
   without the list visible in the same or immediately preceding message, and
   MUST NOT fall back to a bare free-text "which environment?" prompt. If the
   user says they can't see the list, re-render it immediately — do not argue
   or proceed.

   **Legacy ASCII box (optional).** Running the helper without `--markdown`
   still prints the fixed-width ASCII box table (row-number, marker,
   Environment Name, Environment ID). It is ASCII-only on purpose — emoji /
   wide glyphs break monospace alignment — but because fenced code blocks don't
   render as monospace on every chat surface, `--markdown` is the default,
   guaranteed-visible rendering. Only use the box for terminal-only contexts.
2. **Default to the previously-used env — or, on the first pick, to the
   tenant-default env.** When `<RECENT_ENV>` is set (an env was chosen earlier in
   this session), pass its id as `--current` so the helper flags that row in the
   **Selected** column. On the **first** pick of a session (no `<RECENT_ENV>`
   yet), **do not run a separate command** to find the default — the
   `render-env-table.js` helper auto-flags the env whose `type` is `Default` in
   the `list-envs.js` output when `--current` is omitted. So the env list loads
   and renders the default in **one step**, with no `pac auth who` round-trip
   (which would cold-start the CLI and can trigger its own approval prompt). Just
   pipe `list-envs.js` output straight into the renderer. Either way, state:
   *"Reply 'keep' to continue with `<flagged env display name>`, or reply with a
   row number, name, or ID to switch."* Do **NOT** tell the user to "press Enter"
   or send an empty message — this chat surface cannot send an empty reply, so an
   empty message is not a valid confirmation. The user MUST type `keep` (or a
   row/name/id) explicitly. If the user says "keep", reuse the flagged env and
   skip ahead.
3. **Allow selecting another env.** The user may reply with any row number,
   environment name, or environment id to switch. Resolve fuzzy /
   case-insensitive matches against the cached list. To cancel the request
   entirely, the user replies `cancel` (no API call is made — run the
   loop-end summary).

Rules:

- **First env pick of a session** (no `<RECENT_ENV>` yet): the default is the
  **tenant-default env**, auto-flagged by `render-env-table.js` from the
  `type: Default` row in the `list-envs.js` output (no separate `pac auth who`
  call). Flag it in the **Selected** column and let the user `keep` it or
  switch. Always still render the full list.
- **Subsequent picks**: the previously-chosen env is pre-selected as the
  default, but the orchestrator STILL renders the **entire** env list (every
  row) — the default is only pre-flagged in the **Selected** column; it does not
  replace showing the full list. The user only has to reply if they want to
  switch.
- After a pick resolves to a valid env (whether kept or switched), update
  `<RECENT_ENV>` so the next request defaults to it.
- Render the list **directly in the chat** as the Markdown table produced by
  `render-env-table.js --markdown` (not an `AskUserQuestion` — the list is
  typically larger than 4 rows, and a real table renders reliably in chat).
  After the table add one line combining the keep/switch/cancel instructions
  above.

Canonical rendering (subsequent pick, `<RECENT_ENV>` = Sachin-preprod-July) —
the `render-env-table.js --markdown --current 2a0887a0-…` output looks like the
table below. **Note:** the `…` rows here are only an abbreviation **for this
document** — in an actual reply you MUST emit every environment row the helper
prints, never these placeholders.

| # | Selected | Environment Name | Environment ID |
|---|---|---|---|
| 1 |  | Ashmigration | e364969c-d426-eb11-b9d2-c9e20c2cd15a |
| … |  | … | … |
| 28 | **← selected earlier** | Sachin-preprod-July | 2a0887a0-6366-ef59-9992-118cfcd2fa2b |
| … |  | … | … |

*"Reply 'keep' to continue with Sachin-preprod-July, or reply with a row number, environment name, or environment ID to switch. Reply 'cancel' to stop."*

### Consent gate (always before POST) — structured summary, not a one-liner

> **Deterministic renderer.** The concrete invocation lives in **Phase 4.2.3**,
> which pipes the resolved request through
> `scripts/render-impact-summary.js` so the Action / Environment / Scope /
> Sites / Effect / Side-effect rows stay consistent with this spec and the
> per-policy data. The format below documents what that helper emits — do not
> hand-build it when the helper is available.

Once every required field is resolved, render a **structured summary** of
the request — every entity the parser pulled from the user's input or the
clarification answers — and then ask for explicit go-ahead. POST is
destructive; this gate is mandatory even on the NLP path. The summary's
purpose is to let the user catch a misinterpretation before any API call
fires.

The summary MUST include:

| Row | Source | Example value |
|-----|--------|---------------|
| Action | from `intentDirection` + policy subject | "Disable OpenID Connect sign-in" |
| Environment | display name + envId (small, for transparency) | "Sachin-Jun-2nd (`202c4f04-…`)" |
| Scope (plain language) | derived from policyValue + site list | "Every site in this environment" / "Only Site 1 and 8-june" / "Every site except Site 2" / "No sites (clears the policy)" |
| Affected sites | rendered as a table with **Name, URL, Portal ID, Current State, New State** (see below) | (see below) |
| What this changes | one-line plain-language consequence | "OpenID Connect sign-in will be blocked on all 3 sites." |

**Current State / New State columns (required).** Before rendering the
consent summary, resolve the **Current State** of each affected site by
reading the live policy state (`get-env.js` for the env value + `get-portal.js`
for the inclusion/exclusion lists, then apply the Phase 4.4.3 site-state
table). **New State** is what that site becomes after the requested operation
(enable → Enabled, disable → Disabled, for the sites in scope). Render both
cells with the green/red convention (`🟢 Enabled` / `🔴 Disabled`) from
`governance-mapping.json` `stateColors`. This lets the user see the exact
transition before approving. If a live read fails, render Current State as
`Unknown` (never block the gate on a read error) and say so in a footnote.

Render it then ask for explicit go-ahead as a **free-text** prompt (NOT an
`AskUserQuestion` — do not present numbered/multiple-choice options). End with
one prose line: *"Reply **Apply now** to proceed, or **cancel** to stop."* Do
**NOT** prepend any lead-in line, heading, or label of any kind — e.g.
 "Impact summary:", "Here's the impact summary:", "SUMMARY of the change I'll
make:", "Impact summary:", or similar. Start the impact summary directly at the
`Action:` row.

```
Action:        🔴 Disable OpenID Connect sign-in
Environment:   Sachin-Jun-2nd  (202c4f04-2eb7-eef3-a26d-14c77c8c13c5)
Scope:         Every site in this environment
Sites in env:

┌──────────┬─────────────────────────────────────────┬──────────────────────────────────────┬────────────┬──────────────────────┐
│ Portal   │ Portal URL                              │ Portal ID                            │ Current    │ New State            │
│ Name     │                                         │                                      │ State      │                      │
├──────────┼─────────────────────────────────────────┼──────────────────────────────────────┼────────────┼──────────────────────┤
│ Site 1   │ https://site-dmq4c.powerappsportals.com │ 3e13d603-2607-43e0-90aa-d15bacaa8787 │ 🟢 Enabled │ 🔴 Disabled ←        │
│          │                                         │                                      │            │ CHANGED              │
├──────────┼─────────────────────────────────────────┼──────────────────────────────────────┼────────────┼──────────────────────┤
│ Site 2   │ https://site-uo75u.powerappsportals.com │ ea51fc54-94e0-47fc-ab13-d3db18567809 │ 🟢 Enabled │ 🔴 Disabled ←        │
│          │                                         │                                      │            │ CHANGED              │
├──────────┼─────────────────────────────────────────┼──────────────────────────────────────┼────────────┼──────────────────────┤
│ 8-june   │ https://site-pjpuy.powerappsportals.com │ fe624c02-8793-4423-84f0-3546d80dee49 │ 🔴 Disabled│ 🔴 Disabled          │
└──────────┴─────────────────────────────────────────┴──────────────────────────────────────┴────────────┴──────────────────────┘
Effect:        OpenID Connect sign-in will be disabled on all portals in Sachin-Jun-2nd.
```

*Reply **Apply now** to proceed, or **cancel** to stop.*

Also do **NOT** precede the summary with any introductory sentence (e.g.
"Here it is re-rendered:", "Here's the impact:", "Below is the summary:") —
emit the `Action:` row as the very first line of the reply.

Same pattern adapts to Include / Exclude scopes — render only the sites
that match the scope as the "Sites covered" table (with the same Current
State / New State columns), plus a one-line note about what's NOT covered.

If the user picks **Cancel**, exit cleanly with *"No change made. Send a
new request or pick a different operation."*. Do not POST.

### Build + POST

On `Apply now`, build the policy payload using the helpers in
`set-governance.js` and POST. After the apply returns, show the verification
table (env value + site list) per Phase 4.3.1.

## 2.3 Supported policies and policyValue meaning

For the consent gate and verification render, refer to this table:

| Policy display name | Internal `PolicyName` |
|---------------------|-----------------------|
| Enable Maker Copilot for existing sites | `EnableMakerCopilotForExistingSites` |
| Enable the OpenID Connect protocol | `EnableProtocolOpenIdConnect` |
| Enable the SAML 2.0 protocol | `EnableProtocolSAML20` |
| Enable the WS-Federation protocol | `EnableProtocolWsFederation` |
| Enable the OAuth 2.0 protocol | `EnableProtocolOpenAuth` |
| Enable Facebook sign-in | `EnableIdpOAuthFacebook` |
| Enable Google sign-in | `EnableIdpOAuthGoogle` |
| Enable Microsoft sign-in | `EnableIdpOAuthMicrosoft` |
| Enable local login | `EnableAuthenticationLocalLogin` |
| Enable external authentication providers | `EnableExternalAuthProviders` |

### policyValue meaning — uniform across all policies

> **Moved**: the canonical mapping (per-value `userIntent`, `apiBehavior`,
> `envBodyLabel`, `summaryScopeLabel`) now lives in
> `references/governance-mapping.json` under the `policyValueSemantics` key.
> Read from the JSON; do not duplicate the table here.

Quick rule of thumb (full detail in the JSON):

- The four `policyValue` strings have the **same user-facing meaning regardless
  of which policy is being applied** — the verb attaches to the Governance
  Setting itself, not to the underlying protocol.
- `All` / `Include` mean **Enable** (env-wide vs listed sites).
- `None` / `Exclude` mean **Disable** (env-wide vs listed sites).
- What "Enable" / "Disable" actually does in the user's world depends on the
  policy — the consent gate's Effect line translates that into plain English
  via the per-policy `subject` field in the JSON.

### NLP intent → policyValue mapping (uniform)

The same uniform mapping applies on every policy — read the
`intentToPolicyValue` array from `governance-mapping.json` (the canonical
source, also used in Phase 2.1).

"Everywhere except X" phrasing is **not** auto-inverted — ask the user to
re-phrase as either *"Enable for X"* or *"Disable for X"* (see
`ambiguousPhrasings` in the JSON).

### Scope picker (when scope is missing or ambiguous)

When the user's intent has no scope qualifier, do **NOT** use an
`AskUserQuestion`. Instead follow the **Phase 4.2.1** flow: list the sites
(top 10 via `orderPortalsForDisplay()`), then take a single **free-text**
reply — `all` for every site, or a **comma-separated** list of site names / IDs
for specific sites. Map the reply (with the known verb) to `policyValue`:

| User reply | Verb | Maps to |
|------------|------|---------|
| `all` | enable | `policyValue=All`, `ToBeAdded=[]` |
| `all` | disable | `policyValue=None`, `ToBeAdded=[]` |
| comma-separated names/IDs | enable | `policyValue=Include`, `ToBeAdded=[picked ids]` |
| comma-separated names/IDs | disable | `policyValue=Exclude`, `ToBeAdded=[picked ids]` |

The uniform NLP table above is the **source of truth** for the consent-gate
summary. The summary MUST translate `policyValue` back to plain language —
never leak the internal `All` / `Include` / `None` / `Exclude` terms to the
user. The plain-language Effect line MUST match the policy-specific row in
the Phase 2.1 "Enable / Disable" table.

---

## 3. Determine the operation

`<OP>` comes from the parsed intent (Phase 2.1) — do **not** ask the user to
re-pick it when the intent is already clear:

| Parsed `intent` | `<OP>` | Section |
|-----------------|--------|---------|
| `apply` | Set | 4.2 |
| `fetchEnv` | Fetch Env | 4.3 |
| `fetchSite` | Fetch Portal | 4.4 |

Only when the intent is genuinely ambiguous, ask the user to clarify with a
**free-text** prompt (NOT an `AskUserQuestion` — no numbered/multiple-choice
options). Describe the three operations in plain prose and let the user reply in
their own words, interpolating `<POLICY_DISPLAY_NAME>` (from Phase 2) so the
language is concrete:

> *"Do you want to **apply / change** the "&lt;POLICY_DISPLAY_NAME&gt;" setting,
> **check its status across the environment**, or **check its status on a
> specific site**? Reply in your own words."*

Map the free-text reply to an operation:

| Free-text reply resolves to | Internal operation |
|-----------------------------|--------------------|
| apply / change / enable / disable / configure the policy | Set (POST + watch + verify) |
| check / status across the environment / env-wide | Fetch Env |
| check / status on a specific site / one portal | Fetch Portal |

Persist the chosen operation as `<OP>`.

(The status endpoint is still used internally — `set-governance.js` polls it during Apply and surfaces it via the verify call. It is intentionally not exposed as a standalone operation.)

---

## 4. Run the operation

### 4.1 Common — resolve the environment

**Branch on what the request already provided** (from the Phase 2.1 parse):

- **Environment already provided** (the user named an env or gave an env id in
  their request, e.g. *"disable OIDC in Contoso-Prod"*): **skip the interactive
  picker.** Resolve the name/id against the cached env list, confirm it in one
  line — *"Using environment **&lt;ENV_DISPLAY&gt;** (`<ENV_ID>`)."* — and go
  straight to the next step (4.2 scope for Set, 4.3 for Fetch Env, 4.4 for
  Fetch Portal). Do **not** re-render the full env table when the env is
  unambiguously resolved.
- **Environment NOT provided** (the common case): render the **full** env-list
  table (every row, every request) via `render-env-table.js --markdown`,
  default to `<RECENT_ENV>` when set (flagged in the **Selected** column), and
  let the user `keep` / switch / `cancel`. Never skip the list by silently
  reusing the previously-chosen env — the env list is NEVER optional or hidden
  when a pick is required.

The env list comes from `list-envs.js` (cached as `governance-envs.json`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-envs.js"
```

Output is `{ status: "ok", envs: [ { envId, displayName, envUrl, type, region } ] }`. Pipe it (or the cached file) through `render-env-table.js --markdown` and emit the Markdown table **verbatim** (as a rendered table, not inside a code fence). Resolve the user's row-number / name / id reply against the cached list (fuzzy, case-insensitive). Persist the choice as `<ENV_ID>` and `<ENV_DISPLAY>`, and update `<RECENT_ENV>`.

### 4.2 Apply the policy (`<OP>` = Set)

**Entry variants — skip any step the request already resolved.** Branch on
what the Phase 2.1 parse produced, then run only the remaining steps:

| What the request provided | Steps to run |
|---------------------------|--------------|
| **Nothing** (no env, no sites) | 4.1 pick env → 4.2.1 top-10 sites + all/selected → (4.2.2 if selected) → **4.2.3 Impact Summary + consent** → 4.2.4 apply → 4.2.5 verify |
| **Environment only** | 4.1 resolves env (skips picker) → 4.2.1 top-10 sites + all/selected → (4.2.2 if selected) → **4.2.3 Impact Summary + consent** → 4.2.4 apply → 4.2.5 verify |
| **Environment + site(s)** | 4.1 resolves env + resolve named site(s) to `<PORTAL_IDS>` (skip 4.2.1/4.2.2) → **4.2.3 Impact Summary + consent** → 4.2.4 apply → 4.2.5 verify |

When sites are already named in the request, resolve them with
`parse-portal-input.js` (against `list-portals.js` output) to get
`<PORTAL_IDS>` / `<PORTAL_NAMES_LIST>` and set `<POLICY_VALUE>` = `Include`
(enable) or `Exclude` (disable), then jump straight to **4.2.3**. The
**Impact Summary is always shown before the consent gate in every variant** —
never POST without it.

#### 4.2.1 Pick the scope (site list + free-text input)

Do **NOT** use an `AskUserQuestion` for the scope. Instead, show the site
list and take a single **free-text** reply. The **verb** (Enable / Disable)
is already known from the parsed intent (`<INTENT_DIRECTION>`); this step only
resolves **scope** (all sites vs specific sites).

**Step A — resolve the verb.** Use `<INTENT_DIRECTION>` from the NLP parse.
Only if it is genuinely missing, ask a single short **free-text** prompt (NOT an
`AskUserQuestion`): *"Do you want to **enable** or **disable** it? Reply
'enable' or 'disable'."* Map the reply to the verb, then continue.

**Step B — list the sites (top 10).** Always show the site list first so the
free-text input is safe (admins recognise site **names**, not GUIDs):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
  [--useAdminPortal --token "<TOKEN>"]
```

Render as a plain-text table. **Display cap (10 rows):** when the env has more
than 10 sites, show only the top 10 via `orderPortalsForDisplay()` (Production
→ `StateConfigured` → oldest `createdOn`) and add "Showing 10 of &lt;total&gt;
sites — type any site name or ID (including ones not listed), or 'all'." With
10 or fewer, show them all.

```
| # | Portal Name   | Portal URL                                | Portal ID                             |
|---|---------------|-------------------------------------------|---------------------------------------|
| 1 | Site 1        | https://site-dmq4c.powerappsportals.com   | 3e13d603-2607-43e0-90aa-d15bacaa8787  |
| 2 | Site 2        | https://site-uo75u.powerappsportals.com   | ea51fc54-94e0-47fc-ab13-d3db18567809  |
| 3 | 8-june        | https://site-pjpuy.powerappsportals.com   | fe624c02-8793-4423-84f0-3546d80dee49  |
```

**Step C — prompt for scope (prose, free text — NOT an `AskUserQuestion`).**
Ask, using the known verb:

> *"Reply **all** to &lt;enable/disable&gt; Maker Copilot on **every** site in
> &lt;ENV_DISPLAY&gt;, or reply with a **comma-separated** list of site names
> or IDs to &lt;enable/disable&gt; only those. Reply 'cancel' to stop."*

**Step D — map the reply to `<POLICY_VALUE>`:**

| User reply | Verb | Internal `policyValue` | Next |
|------------|------|------------------------|------|
| `all` (or "every site") | enable | `All` | → 4.2.3 consent gate |
| `all` | disable | `None` | → 4.2.3 consent gate |
| comma-separated names/IDs | enable | `Include` | → 4.2.2 parse the list |
| comma-separated names/IDs | disable | `Exclude` | → 4.2.2 parse the list |

`Include` / `Exclude` are **internal-only** terms — never show them to the
user. Persist the resolved `policyValue` as `<POLICY_VALUE>`.

If the reply is `all`, jump straight to **4.2.3** (consent gate) — no further
site parsing needed. If the reply is a comma-separated list, go to **4.2.2** to
validate and resolve the named sites.

#### 4.2.2 Site picker (Specific Sites / All-except-specific only)

Only when `<POLICY_VALUE>` is `Include` or `Exclude` (i.e., the user picked one
of the two "specific sites" options). Always list sites first — the table is
what makes the free-text input safe (admins recognise site **names**, not
GUIDs).

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
  [--useAdminPortal --token "<TOKEN>"]
```

Render the result as a plain-text table the user can copy from:

```
| # | Portal Name      | Portal URL                                | Portal ID                              |
|---|------------------|-------------------------------------------|----------------------------------------|
| 1 | Site 1           | https://site-dmq4c.powerappsportals.com   | 3e13d603-2607-43e0-90aa-d15bacaa8787   |
| 2 | Site 2           | https://site-uo75u.powerappsportals.com   | ea51fc54-94e0-47fc-ab13-d3db18567809   |
| 3 | 8-june           | https://site-pjpuy.powerappsportals.com   | fe624c02-8793-4423-84f0-3546d80dee49   |
```

> **Display cap (10 rows).** When the environment has **more than 10**
> portals, render only the top 10 using `orderPortalsForDisplay()` from
> `list-portals.js` — Production sites first, then `StateConfigured` status,
> then oldest-first by `createdOn`. Add a line "Showing 10 of &lt;total&gt;
> sites — type any site name or ID (including ones not listed) to pick it."
> With 10 or fewer, show them all in the original order. The user can still
> reference any site by name/ID because the parser validates against the full
> list.

If the list is empty, tell the user there are no portals in that environment and back the user up to **4.2.1**.

Then prompt the user (prose, not `AskUserQuestion` — the answer is free text).
Use plain language matching the 4.2.1 choice:

- When `<POLICY_VALUE>` is `Include`: *"Reply with a comma-separated list of the site names or IDs you want to **enable** the Governance Setting on. The others stay as-is."*
- When `<POLICY_VALUE>` is `Exclude`: *"Reply with a comma-separated list of the site names or IDs you want to **disable** the Governance Setting on. The others stay under the policy."*

Parse the user's reply with the helper:

```bash
echo "<USER_INPUT>" | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/parse-portal-input.js" \
  --portalsFile <path-to-list-portals-output>
```

Or call `parsePortalInput(input, { validIds: portals })` directly when integrating from JS. Output: `{ policyValue, portalIds[], resolvedNames[], errors[] }`.

When invoking the parser from this step the orchestrator should ignore the parser's `policyValue` field (it was decided in 4.2.1) and only use `portalIds` + `resolvedNames`. If `errors` is non-empty, surface each one to the user and reprompt.

Persist `<PORTAL_IDS>` (comma-joined) for downstream steps. Persist `<PORTAL_NAMES_LIST>` (the `resolvedNames` array joined with commas) for the consent gate.

#### 4.2.3 Confirm before posting (Impact Summary + consent gate)

Confirm as a **free-text** prompt (NOT an `AskUserQuestion` — no numbered /
multiple-choice options). First render the **Impact Summary** deterministically
with the helper (do NOT hand-build it — the helper keeps the Action /
Environment / Scope / Sites / Effect / Side-effect rows consistent with the
committed spec and per-policy data), then ask for explicit go-ahead.

**Step 1 — resolve each affected site's Current State.** Read the live policy
state so the summary can show the exact transition: run `get-env.js` for the
env value, and (for `Include` / `Exclude`) `get-portal.js` for the
inclusion/exclusion lists, then apply the Phase 4.4.3 site-state table to each
site in scope. If a live read fails, pass `currentState: "Unknown"` (never
block the gate on a read error).

**Step 2 — render the Impact Summary via the helper.** Build the request JSON
and pipe it through `render-impact-summary.js`, emitting its output **verbatim**
(it starts directly at the `Action:` row — do NOT prepend any lead-in label or
introductory sentence like "Impact summary:"):

```bash
echo '{
  "policy": "<POLICY>",
  "direction": "<INTENT_DIRECTION>",
  "scope": "<all|specific>",
  "policyValue": "<POLICY_VALUE>",
  "env": { "displayName": "<ENV_DISPLAY>", "envId": "<ENV_ID>" },
  "sites": [ { "name": "...", "url": "...", "portalId": "...", "currentState": "Enabled|Disabled|Unknown" } ]
}' | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-impact-summary.js"
```

`scope` is `all` when `<POLICY_VALUE>` is `All` / `None`, and `specific` when it
is `Include` / `Exclude`. Pass **only the sites in scope** in `sites` (every
site in the env for `all`; the picked sites for `specific`). The helper renders
the Current State → New State transition per site, marks changed rows, and adds
the sign-out Side-effect line only when the resulting `policyValue` triggers it.

**Cascade block (downstream-methods checklist).** When the user applies a
*parent* policy that affects other sign-in methods, the helper appends a numbered
checklist of those downstream methods directly below the Effect / Side-effect
line. This is data-driven from `governance-mapping.json`
`policies[].cascadeOnDisable` (disable) and `policies[].cascadeOnEnable` (enable)
— no cascade renders for policies without dependents. Today two policies have a
cascade:

- **Enable external authentication providers** (`EnableExternalAuthProviders`)
- **Enable the OAuth 2.0 protocol** (`EnableProtocolOpenAuth`)

**On disable** the block lists the methods the parent turns **off**, each marked
with the red state marker `🔴 Disabled`. The heading is per-policy (read from
`cascadeOnDisable.heading`):

- External auth providers ("Below Setting will get Disable") → OpenIdConnect,
  SAML2.0, OAuth2.0, WS_Federation, Facebook, Google, Microsoft.
- OAuth 2.0 protocol ("The following OAuth 2.0 identity providers will be
  disabled:") → Facebook, Google, Microsoft (the OAuth-based social identity
  providers).

**On enable** the block is *informational*: it lists the methods that become
**available** again (subject to each provider's own configuration). Enabling a
parent does **not** auto-enable the children, so the social-provider rows are
annotated "Controlled by the &lt;provider&gt; setting." and — for External Auth —
a footer note reminds the admin each provider must still be configured:

- External auth providers → OpenID Connect, SAML 2.0, OAuth 2.0, WS-Federation,
  Facebook, Google, Microsoft (+ "must still be configured" note).
- OAuth 2.0 protocol → Facebook, Google, Microsoft (not auto-enabled — each
  managed via its own setting).

An enable item may also declare `state: "Enabled"` in the mapping, which renders
the green state marker `🟢 Enabled` (the mirror of the disable side's red one).

**Action-line color.** The helper colors the `Action:` row by direction — green
`🟢 Enable …` when the operation turns something on, red `🔴 Disable …` when it
turns something off — matching the green=Enabled / red=Disabled state convention.

Emit the block verbatim as the helper prints it — it is part of the consent-gate
summary the admin approves.

> **Never editorialize about a missing cascade.** For any policy that has **no**
> `cascadeOnDisable` / `cascadeOnEnable` (e.g. SAML 2.0, WS-Federation, OpenID
> Connect, local login, the individual social-provider policies), the helper
> emits **nothing** after the Effect / Side-effect line. Do **NOT** add your own
> note explaining the absence — no parentheticals like "(SAML 2.0 has no
> downstream providers, so there's no cascade list.)" or any similar sentence.
> Emit the helper output exactly as-is and stop; silence is the correct render
> for a policy without dependents.

**Step 3 — ask for consent.** After the summary, end with one prose line:
*"Reply **Apply now** to proceed, or **cancel** to stop."* Do not proceed
without an explicit free-text `Apply now`. If the user replies `cancel`, exit
cleanly with *"No change made."* and do not POST.

#### 4.2.4 Apply and watch

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/set-governance.js" \
  --envId "<ENV_ID>" \
  --policy "<POLICY>" \
  --policyValue "<POLICY_VALUE>" \
  [--portalIds "<PORTAL_IDS>"] \
  [--useAdminPortal --token "<TOKEN>"]
```

`--portalIds` accepts a comma- or whitespace-separated list. Use `--portalId` (singular) only for the legacy single-portal call shape. When `--policyValue` is `All` or `None`, omit `--portalIds`.

The script posts to `/governance`, then polls `/governance/status/{envId}/{policy}` every 30 seconds until the response reports a terminal state (`Succeeded` / `Completed` for success, `Failed` for failure) or the timeout elapses (default 15 minutes).

Run this script with `run_in_background: true`. While it polls, surface its stderr progress lines to the user every 30 seconds at most.

Exit codes:
- `0` — rollout reached the success terminal state.
- `3` — polling timed out before terminal state.
- `4` — terminal state reached, but it was `Failed`.
- `2` — sign-in required.
- `1` — other failure (parse the stderr message to the user).

#### 4.2.5 Confirm after rollout

After the script exits, re-read the current state at the same scope and show it
to the user. This is a verify step — never trust the polling outcome alone.

- `policyValue` was `All` or `None` → run **`get-env.js`**.
- `policyValue` was `Include` or `Exclude` → run **`get-portal.js`** (which reads the policyRecord, then check that each picked portal lands on the expected list).

**Render the verification as a state table (canonical structure).** After the
read confirms the new state, render a headline + table that lists **every site
the operation touched**. **Do NOT hand-build a Markdown table with emoji / ANSI
inside the cells — that breaks column alignment and the Status header.** Instead
render the table with the **`render-portal-table.js`** helper (the same
fixed-width ASCII-box approach the env picker uses), piping the sites through it
and emitting the output **verbatim inside a fenced code block**:

```bash
echo '<PORTALS_JSON>' | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-portal-table.js" --no-color
```

`<PORTALS_JSON>` is a JSON array of `{ "name", "url", "portalId", "state" }`
where `state` is `true` (Enabled) / `false` (Disabled) — compute each site's
state from the read via the Phase 4.4.3 site-state table. Use `--no-color` for
chat surfaces (ANSI is stripped there and would show as raw escapes); the helper
auto-colorizes the State column green / red only in a real terminal. The helper
emits a fixed-width box with columns `# | Name | URL | Site ID | State` and
stays aligned because widths are computed on the visible text.

**The State cell MUST show the status icon** — 🟢 for Enabled, 🔴 for Disabled.
The helper prepends these by default (pass `--no-icons` only if you explicitly
need them off). NEVER render a state table without the 🟢 / 🔴 icon.

Pick the headline + row set by scope:

- **`All` (env-wide enable)** — headline *"This Governance setting is 🟢 Enabled for these Sites:"*; list **all** sites in the env (from `list-portals.js`), every `state=true`.
- **`None` (env-wide disable)** — headline *"This Governance setting is 🔴 Disabled for these Sites:"*; list **all** sites in the env, every `state=false`.
- **`Include` / `Exclude`** — list only the sites the operation targeted; compute each site's state via the Phase 4.4.3 site-state table. Use the singular *"…for this Site:"* headline when exactly one site was targeted.

Env-wide (`None`) example — every site rendered via the helper (icons on):

```
This Governance setting is 🔴 Disabled for these Sites:

+---+----------+-----------------------------------------+--------------------------------------+-------------+
| # | Name     | URL                                     | Site ID                              | State       |
+---+----------+-----------------------------------------+--------------------------------------+-------------+
| 1 | Portal_1 | https://site-3axiv.powerappsportals.com | d1df518c-8e39-4bd5-8410-eb1c0c28e56c | 🔴 Disabled |
| 2 | Portal_2 | https://site-37umu.powerappsportals.com | bf8ead09-df94-488a-b78c-d4065899e1a4 | 🔴 Disabled |
+---+----------+-----------------------------------------+--------------------------------------+-------------+
```

Then give the one-line Phase 5 loop summary.

### 4.3 Check current state across an environment (`<OP>` = Fetch Env)

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-env.js" \
  --envId "<ENV_ID>" \
  --policy "<POLICY>" \
  [--useAdminPortal --token "<TOKEN>"]
```

Output: `{ status: "ok", body: "All" | "None" | "Include" | "Exclude" }`.

Render in plain language. Use the friendly mapping the loop section calls out:

| Internal `body` | Friendly description |
|-----------------|----------------------|
| `All` | "every site" |
| `None` | "no sites" |
| `Include` | "the sites on the allow-list" |
| `Exclude` | "every site except the ones on the exception list" |

**Highlight the status summary.** The one-line plain-language summary MUST be
**emphasized** (bold) and lead with the env-level state icon so the user can
scan it at a glance — 🟢 when the setting is on env-wide (`All`) or on some
sites (`Include`/`Exclude`), 🔴 when it is off everywhere (`None`). Render it as
a bold line, e.g.:

- `All` → **🟢 Maker Copilot is enabled on every site in `<env>`.**
- `None` → **🔴 Maker Copilot is disabled on every site in `<env>`.**
- `Include` → **🟢 Maker Copilot is enabled on the listed sites in `<env>`.**
- `Exclude` → **🟢 Maker Copilot is enabled on every site in `<env>` except the listed ones.**

Use the policy's `summaryLabel` / `subject` from `governance-mapping.json` for
the label, and the `stateColors` emoji for the icon. Never render the Fetch Env
summary as an un-emphasized plain sentence.

#### 4.3.1 ALWAYS show the portal details table (every env value)

A bare summary leaves the user guessing which sites are affected. For **every**
env value (`All`, `None`, `Include`, `Exclude`), the orchestrator MUST also
fetch the env's full site list, compute each site's state, and render the
portal-details state table via **`render-portal-table.js`** (icons on) so the
user sees every portal's name, URL, Site ID, and 🟢/🔴 state.

Steps:

1. Fetch the policy record (needed for `Include`/`Exclude` membership; harmless
   for `All`/`None`):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-portal.js" \
     --envId "<ENV_ID>" \
     --policy "<POLICY>" \
     --portalId 00000000-0000-0000-0000-000000000000 \
     [--useAdminPortal --token "<TOKEN>"]
   ```
   The dummy portalId is fine — the helper returns the env's full
   `InclusionList` / `ExclusionList` regardless. We're using it for the env-level
   record here, not for membership of the dummy id.

2. Fetch the env's full site list:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" \
     --envId "<ENV_ID>" \
     [--useAdminPortal --token "<TOKEN>"]
   ```

3. Compute each site's state via the Phase 4.4.3 site-state table (using the env
   `body` + the inclusion/exclusion lists), then render the **full** portal
   list through the helper, emitting its output **verbatim inside a fenced code
   block**:
   ```bash
   echo '<PORTALS_JSON>' | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-portal-table.js" --no-color
   ```
   `<PORTALS_JSON>` is a JSON array of `{ "name", "url", "portalId", "state" }`
   (`state` true=Enabled / false=Disabled) for **every** site in the env. The
   State cell MUST show the 🟢 / 🔴 icon (helper default). Pick the headline by
   env value:

   - `All` → *"This Governance setting is 🟢 Enabled for these Sites:"* (all rows 🟢)
   - `None` → *"This Governance setting is 🔴 Disabled for these Sites:"* (all rows 🔴)
   - `Include` → *"This Governance setting is 🟢 Enabled for these Sites:"* (listed sites 🟢, the rest 🔴)
   - `Exclude` → *"This Governance setting is 🟢 Enabled for these Sites:"* (excepted sites 🔴, the rest 🟢)

   If a policy-list id does NOT appear in `list-portals` (e.g., the site was
   deleted after being added), still show it in the table with `(site not
   found)` for the name and an empty URL.

4. Finally, give the highlighted (bold + icon) one-line summary from Phase 4.3
   above.

### 4.4 Check current state on one portal (`<OP>` = Fetch Portal)

After **4.1** runs, list every site in `<ENV_ID>` and let the user pick by **name** (preferred) or ID. Sites in this skill are referred to as "sites", not "portals", in user-facing prose.

#### 4.4.1 List sites and render the table

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
  [--useAdminPortal --token "<TOKEN>"]
```

Render the output as a plain-text table (same format as 4.2.2):

```
| # | Name      | URL                                       | Site ID                                |
|---|-----------|-------------------------------------------|----------------------------------------|
| 1 | Site 1    | https://site-dmq4c.powerappsportals.com   | 3e13d603-2607-43e0-90aa-d15bacaa8787  |
| 2 | Site 2    | https://site-uo75u.powerappsportals.com   | ea51fc54-94e0-47fc-ab13-d3db18567809  |
| 3 | 8-june    | https://site-pjpuy.powerappsportals.com   | fe624c02-8793-4423-84f0-3546d80dee49  |
```

> **Display cap (10 rows).** Same rule as Phase 4.2.2 — when the env has more
> than 10 sites, render only the top 10 via `orderPortalsForDisplay()`
> (Production → `StateConfigured` → oldest `createdOn`) and note "Showing 10
> of &lt;total&gt;". The user may still name any site not in the visible 10.

If the list is empty, tell the user there are no sites in this environment and stop.

#### 4.4.2 Ask which site

Prompt the user (prose, free text):

> *"Reply with a site name (e.g. `Site 1`) or a site ID."*

Pipe the reply through `parse-portal-input.js` with the listed sites as `validIds`. The helper resolves the name to a portal id when the input isn't a UUID.

```bash
echo "<USER_REPLY>" | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/parse-portal-input.js" \
  --portalsFile <path-to-list-portals-output>
```

The reply must resolve to exactly one site. If the helper returns more than one (the user typed multiple), tell them this is a single-site read and ask again. If it returns zero or errors, surface the message and reprompt.

Persist as `<PORTAL_ID>` and `<PORTAL_NAME>` (for plain-language output).

#### 4.4.3 Run the read and render the result

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-portal.js" \
  --envId "<ENV_ID>" \
  --portalId "<PORTAL_ID>" \
  --policy "<POLICY>" \
  [--useAdminPortal --token "<TOKEN>"]
```

Compute whether the policy applies to the chosen site using the env value
(from `get-env.js`, run in parallel) plus the inclusion/exclusion lists in
this response:

| env `body` | Inclusion list contains site? | Exclusion list contains site? | Site state |
|-----------|--------------------------------|-------------------------------|------------|
| `All`      | —                              | —                             | **Enabled** |
| `None`     | —                              | —                             | **Disabled** |
| `Include`  | yes                            | —                             | **Enabled** |
| `Include`  | no                             | —                             | **Disabled** |
| `Exclude`  | —                              | yes                           | **Disabled** |
| `Exclude`  | —                              | no                            | **Enabled** |

##### Plain-English state paraphrasing

When you render the Governance Setting state to the user (in any table
cell, summary, or sentence — env-level or site-level), MUST follow the
**Governance Setting state → user-facing paraphrase** mapping per policy.
The paraphrasing labels track the user's natural-English mental model of
the feature. Read the paraphrase strings from `governance-mapping.json` —
the matching policy's `stateParaphrase.Enabled` / `stateParaphrase.Disabled`.

Render the cell with the state label first, then the paraphrase in
parentheses:

```
| 1 | Site 1 | …url… | 🟢 Enabled  (OIDC sign-in Enabled) |
| 2 | 8-june | …url… | 🔴 Disabled (OIDC sign-in Blocked) |
```

##### Color convention (green = Enabled, red = Disabled)

When rendering the Governance Setting state in **any summary, verification, or
state table** (the consent-gate summary, the post-Set verify table, Fetch Env,
Fetch Site, and the Phase 5 loop summary), colour-code the **Status** column
using **ANSI SGR escape codes** so the state renders green / red in an
ANSI-capable terminal. Keep the emoji marker inside the coloured span as a
fallback for surfaces that strip ANSI.

Wrap the **entire** Status cell — emoji + label + paraphrase — in the colour
code, and **reset after every cell** with `\x1b[0m`:

| State | ANSI open | Rendered cell (wrapped) |
|-------|-----------|--------------------------|
| Enabled | `\x1b[32m` (green) | `\x1b[32m🟢 Enabled (<paraphrase>)\x1b[0m` |
| Disabled | `\x1b[31m` (red) | `\x1b[31m🔴 Disabled (<paraphrase>)\x1b[0m` |

ANSI codes (also in `references/governance-mapping.json` → `stateColors.ansi`):

- Green: `\x1b[32m`
- Red: `\x1b[31m`
- Reset: `\x1b[0m`  ← **always** close each Status cell with this.

Example (Fetch Site status table):

```text
| # | Site Name | URL   | Status |
|---|-----------|-------|--------|
| 1 | Site 1    | …url… | \x1b[32m🟢 Enabled (OIDC sign-in Enabled)\x1b[0m |
| 2 | 8-june    | …url… | \x1b[31m🔴 Disabled (OIDC sign-in Blocked)\x1b[0m |
```

Read the codes + emoji from `references/governance-mapping.json` under
`stateColors` (`stateColors.ansi.green` / `.red` / `.reset`, and each state's
`emoji`) — do not hard-code them elsewhere. Apply this uniformly to every
Status cell and to the consent-gate **Action / Effect** rows (green when the
operation enables, red when it disables).

> **Terminal vs. stripped surfaces.** ANSI escapes render as colour only in an
> ANSI-capable terminal. Surfaces that strip ANSI (some chat renderers) show
> the escape text or drop it — in those the emoji (🟢 / 🔴) remains the visible
> green / red indicator, which is why the emoji stays inside the coloured span.

This applies uniformly — env-level renders, per-site renders, the
Phase 5 loop summary, and any verification table. Do NOT invert or
re-interpret these labels based on the underlying API direction; the
user has chosen this mental model and we render it consistently.

Then render the result as a one-line headline + **the fixed-width ASCII-box
table produced by `render-portal-table.js`** (icons on) — **never** a
hand-built Markdown table with emoji / ANSI in the cells (that breaks the
Status header and column alignment), and never multi-sentence prose. Pipe the
single site through the helper:

```bash
echo '[{"name":"<PORTAL_NAME>","url":"<URL>","portalId":"<PORTAL_ID>","state":<true|false>}]' \
  | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-portal-table.js" --no-color
```

`state` is `true` when the Phase 4.4.3 site-state table resolves to Enabled,
`false` when Disabled. **The State cell MUST show the icon** — 🟢 Enabled /
🔴 Disabled (the helper adds it by default). Emit the helper output verbatim in
a fenced code block.

For **Enabled**:

```
This Governance setting is 🟢 Enabled for this Site:

+---+--------+-----------------------------------------+--------------------------------------+------------+
| # | Name   | URL                                     | Site ID                              | State      |
+---+--------+-----------------------------------------+--------------------------------------+------------+
| 1 | 8-june | https://site-pjpuy.powerappsportals.com | fe624c02-8793-4423-84f0-3546d80dee49 | 🟢 Enabled |
+---+--------+-----------------------------------------+--------------------------------------+------------+
```

For **Disabled**:

```
This Governance setting is 🔴 Disabled for this Site:

+---+--------+-----------------------------------------+--------------------------------------+-------------+
| # | Name   | URL                                     | Site ID                              | State       |
+---+--------+-----------------------------------------+--------------------------------------+-------------+
| 1 | Site 1 | https://site-dmq4c.powerappsportals.com | 3e13d603-2607-43e0-90aa-d15bacaa8787 | 🔴 Disabled |
+---+--------+-----------------------------------------+--------------------------------------+-------------+
```

Do not surface internal terms (`policyValue`, `InclusionList`, `ExclusionList`,
`Include`, `Exclude`) to the user. The single-table view is the source of
truth for whether the policy is on or off for that site.

### 4.5 Check the rollout status (`<OP>` = Fetch Status)

For when the user wants to verify that a recent Apply call actually landed,
or to confirm a rollout is still in flight.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-status.js" \
  --envId "<ENV_ID>" \
  --policy "<POLICY>" \
  [--useAdminPortal --token "<TOKEN>"]
```

Endpoint hit (admin-portal transport):
`GET /api/v1/powerPortal/governance/status/<ENV_ID>/<POLICY>`

The response body is one bare JSON string. Map it to plain language for the
user:

| Returned value | Plain-language summary |
|----------------|------------------------|
| `Succeeded` / `Completed` | "The last rollout to \<env\> finished successfully." |
| `Failed` / `Error` | "The last rollout to \<env\> failed." |
| `InProgress` / `Created` / `Pending` | "A rollout is in flight." |
| `None` or unknown | "No rollout has run on this policy yet, or the status hasn't been recorded." |

This is the same endpoint `set-governance.js` uses internally for polling, so
running it after a recent Apply is the cheapest way to confirm without
re-POSTing.

---

## 5. Loop or finish

After every operation, summarize in a single short sentence using plain
language. Do not surface internal terms — exit codes, `policyValue`, `attempts`,
`finalValue`, `transport`, status keywords, etc. — to the user.

| Operation | Pattern |
|-----------|---------|
| Set succeeded — env-wide (`All`) | *"The \<plain policy label\> Governance setting now applies to every site in \<env\>."* |
| Set succeeded — env-wide (`None`) | *"The \<plain policy label\> Governance setting has been cleared on \<env\>."* |
| Set succeeded — `Include` | *"The \<plain policy label\> Governance setting now applies to the listed sites in \<env\>."* (then render the site table from Phase 4.3.1) |
| Set succeeded — `Exclude` | *"The \<plain policy label\> Governance setting now applies to every site in \<env\> except the listed ones."* (then render the site table from Phase 4.3.1) |
| Set partially succeeded (verify mismatch) | *"The operation was sent but \<env\> still reports the previous value. Re-check shortly."* |
| Set failed | *"The operation didn't go through — \<plain-language reason\>. Want to try again?"* |
| Fetch Env | *"\<Plain policy label\> is currently set to \<plain scope label\> on \<env\>."* |
| Fetch Site | *"\<Plain policy label\> is currently \<applied to / not applied to\> \<site name\>."* |
| Fetch Status | *"The last rollout on \<env\> \<finished successfully / failed / is still in flight\>."* |

Map `<plain policy label>` from the matching policy's `summaryLabel` field in
`governance-mapping.json` (`policies[].summaryLabel`).

These labels read naturally in the loop-summary patterns above. E.g.
"*OpenID Connect sign-in is now enabled on every site in &lt;env&gt;*"
means the protocol is on everywhere (`policyValue=All` on the OpenID Connect
toggle); "*OpenID Connect sign-in has been cleared on &lt;env&gt;*"
means it is off everywhere (`policyValue=None`).

Map internal `policyValue` values to plain-language phrases when summarizing
Fetch Env:

| Internal | Plain language |
|----------|----------------|
| `All` | "every site" |
| `None` | "no sites" |
| `Include` | "the sites on the allow-list" |
| `Exclude` | "every site except the ones on the exception list" |

Then, instead of an `AskUserQuestion` menu, **re-prompt the user with the
free-text intent prompt from Phase 2.1** — the same *"Tell me what you'd like to
do…"* prose with the examples. Do **NOT** present the old four-option menu
("Apply the same policy somewhere else" / "Check the same policy somewhere else"
/ "Switch to a different policy" / "Done"). The user simply types their next
request in natural language (a new policy, env, direction, or scope), and the
orchestrator re-enters at **Phase 2.1** to parse it — re-rendering the full env
list per the "Always show the env list" rule. If the user says they're done
(e.g. "done", "that's all", "exit"), end the skill cleanly.

Loop until the user indicates they are done.

Skill tracking:

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "ManageGovernance"`. The tracking script silently no-ops when not running inside a Power Pages project — that is fine for this skill.

---

## Constraints

- **Plain language** — talk about "turning off the OpenID Connect / SAML sign-in path on portals", "turning Maker Copilot on / off for existing sites", or "enabling Google sign-in on your sites". Show the policy strings only when the user has shown they want the technical name.
- **Explicit consent for Set** — never POST `/governance` without a Set-specific **free-text** confirmation (the user replies `Apply now`; do NOT use an `AskUserQuestion` with numbered options) that spells out which sign-in path / feature is being turned off and what happens to currently-signed-in users.
- **Always verify after Set** — run the matching `get-*` call after the polling script exits, even when it reports success.
- **Always show the env list** — for **every** new user request / operation
  (Apply, Fetch Env, Fetch Site — including each loop iteration and every new
  intent the user types), the orchestrator MUST render the **full** env-list
  table (via `render-env-table.js --markdown`, every row, as a rendered
  Markdown table) and let the user confirm `keep` or switch **before** running
  the site picker or any `get-*` / `set-*` call. Never silently reuse the
  previously-chosen env and skip the env list — the default env is only
  pre-flagged in the **Selected** column (the signed-in / tenant-default env on
  the first pick, or the previously-chosen env on later picks).
- **No auto-proceed on Set** — flagging a default env in the **Selected** column
  is allowed, but the pick is never applied automatically: the user must
  confirm explicitly by typing `keep` (to use the flagged env) or a row
  number / name / id (to switch). Never POST against a flagged env without that
  explicit confirmation. The portal pick is never defaulted.
- **Background polling** — run `set-governance.js` with `run_in_background: true`. Stream stderr to the user at most once every 30 seconds.
- **Policy strings are hard-coded** — only the ten policies named in Phase 2.3 are valid (`EnableMakerCopilotForExistingSites`, `EnableProtocolOpenIdConnect`, `EnableProtocolSAML20`, `EnableProtocolWsFederation`, `EnableProtocolOpenAuth`, `EnableIdpOAuthFacebook`, `EnableIdpOAuthGoogle`, `EnableIdpOAuthMicrosoft`, `EnableAuthenticationLocalLogin`, `EnableExternalAuthProviders`). This list is the frozen `SUPPORTED_POLICIES` array in `scripts/policies.js`. Reject any custom policy name with a clear "this skill only supports those ten governance policies today" message.
- **Sign-in failures** — exit code `2` from any script means PAC or Azure CLI is signed out. Tell the user which command to run (`pac auth create` or `az login`) and stop.

## References

- **`references/governance-mapping.json`** — **single source of truth** for the uniform intent→policyValue table, per-policy display names + plain-English state paraphrases, side-effect callouts, scope picker labels, Effect-line templates, env-list rendering rules, and the consent-gate row requirements. The orchestrator MUST read mappings from this JSON rather than re-deriving them from the prose in this file. Updating a label here propagates to every render path (consent gate, verify table, loop summary, parser).
- `references/commands.md` — script flags, response shapes, assumed API contract, exit codes, polling semantics.
