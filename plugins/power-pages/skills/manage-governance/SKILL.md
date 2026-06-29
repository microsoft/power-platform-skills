---
name: manage-governance
description: >-
  Apply, inspect, and monitor Power Pages governance policies across a tenant.
  Supports the two tenant-level policies that switch off legacy authentication
  on Power Pages sites — PowerPages_DisableAuthenticationOpenIdConnect and
  PowerPages_DisableAuthenticationSAML20. Lets the admin set the policy
  (environment-wide or for a specific portal), watches the rollout until it
  reports complete, and reads the current state at the environment or portal
  level. Use when the user wants to "turn off OpenID Connect on Power Pages",
  "disable SAML on a portal", "block legacy auth on portals", "check which
  portals have legacy auth disabled", "see the governance status of my Power
  Pages portals", or otherwise wants to manage Power Pages governance policies
  on a tenant — even if they only name the policy or the side effect without
  saying "governance".
user-invocable: true
argument-hint: "[optional policy or operation hint]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Manage Power Pages Governance Policies

Apply and inspect Power Pages tenant-level governance policies. Two policies are supported today, both targeted at disabling legacy authentication providers on Power Pages portals:

| Policy | What it does |
|--------|--------------|
| `PowerPages_DisableAuthenticationOpenIdConnect` | Turns off OpenID Connect (OIDC) authentication on Power Pages portals. |
| `PowerPages_DisableAuthenticationSAML20` | Turns off SAML 2.0 authentication on Power Pages portals. |

These are **admin-only** operations — applying a policy stops the relevant authentication path for the targeted scope (environment or portal). Always confirm with the user before posting a Set call.

**Initial request:** $ARGUMENTS

## Gotchas

- **Tenant-admin skill, not project-scoped.** Unlike most Power Pages skills, this one does **not** require a `powerpages.config.json` in the current directory. It works against any environment the signed-in user has Power Platform admin access to.
- **Two identifier shapes per portal.** The portal-scoped APIs take `portalId` (the value in the `Id` field on the `/websites` response). The Dataverse `WebsiteRecordId` shown in PAC and YAML is **not** what these APIs accept. The skill resolves portals via the same `/websites` listing that `manage-firewall` uses.
- **Env override is required.** The skill lets the user pick any environment they have access to. Each script accepts `--envId <guid>` and overrides the env in the Power Platform API base URL. When `--envId` is omitted, the script falls back to the env the user is signed into via PAC.
- **Set is async; poll until terminal.** `POST /governance` returns immediately but the policy roll-out is asynchronous. Status comes from `GET /governance/status/{policy}`. The `set-governance.js` script polls this endpoint until the status reaches a terminal value (`Succeeded` / `Completed` for success, `Failed` for failure) or the timeout elapses.
- **Policy names are case-sensitive.** Use the exact policy strings — `PowerPages_DisableAuthenticationOpenIdConnect` and `PowerPages_DisableAuthenticationSAML20`. Anything else will be rejected by the API.
- **Plain language with the user.** Talk about "turning off the OpenID Connect / SAML sign-in path on Power Pages portals". Only show the policy string when the user asks for the technical name.
- **No silent overrides.** Applying a Disable* policy will sign existing users out of any portal that uses the targeted provider. Surface that consequence at the consent gate before posting.

## Workflow

1. **Prerequisites** — Confirm PAC CLI + Azure CLI sign-in
2. **Pick a policy** — OIDC or SAML
3. **Pick an operation** — Set / Fetch (Env) / Fetch (Portal)
4. **Run the operation** — branches on the choice in step 3
5. **Loop or finish** — Offer the next operation against the same policy, or exit

## Task Tracking

Create tasks in three groups. Mark each `in_progress` when starting, `completed` when done.

| Group | When to create | Tasks |
|-------|----------------|-------|
| 1 | At start | Check prerequisites · Pick policy · Pick operation |
| 2 | After operation chosen | Run operation (Set / Fetch Env / Fetch Portal) |
| 3 | After operation result | Summarize and offer follow-up |

---

## 1. Prerequisites

Confirm two things:

- `pac auth who` exits 0 → PAC CLI is signed in.
- `az account show` exits 0 → Azure CLI is signed in.

If either is missing, tell the user which CLI to sign in to and stop. Do **not** require a Power Pages project root for this skill.

---

## 2. Top-level menu + background pre-warm

The moment the skill is invoked:

1. **Fire `list-envs.js` in the background** so the env list is ready by the
   time the user needs to specify an env. The first user-facing prompt
   should not block on it. Cache the result in `/tmp/governance-envs.json`
   for the rest of the run.
2. Show a single `AskUserQuestion` with two options:

| Top-level label | Description (shown to the user) | Internal value |
|-----------------|----------------------------------|----------------|
| External Auth Governance Setting | Enable or disable Power Pages authentication Protocols and Identity Provider for sites in an environment. | `external-auth` |
| Done | End the skill. | `done` |

If the user picks `Done`, exit cleanly without doing anything else.

## 2.1 Free-text intent prompt

When `External Auth Governance Setting` is chosen, ask the user (prose, free
text — NOT an `AskUserQuestion`):

> *"Tell me what you'd like to do. Examples:*
> *- 'Enable OpenID Connect for all portals in Sachin-Jun-2nd'*
> *- 'Disable OpenID Connect on Site 1 and Site 2'*
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

The parser MUST recognize the three supported policy display names + their
shorthand variants:

| User shorthand | Resolves to |
|----------------|-------------|
| "OpenID Connect" / "OIDC" / "OpenIdConnect" | `PowerPages_DisableAuthenticationOpenIdConnect` |
| "SAML" / "SAML 2.0" / "SAML20" | `PowerPages_DisableAuthenticationSAML20` |

And map the `intentDirection` + scope qualifier to a `policyValue`. The
mapping is **uniform across all policies** — the verb attaches to the
Governance Setting itself, not to the underlying protocol or feature.

> **Source of truth**: read these mappings from `references/governance-mapping.json` (`intentToPolicyValue.rows`). The table below is a copy for readability; if the two disagree, the JSON wins.


| intentDirection | scope qualifier                              | policyValue | ToBeAdded   |
|-----------------|----------------------------------------------|-------------|-------------|
| `enable`        | "for all portals" / "everywhere"             | `All`       | `[]`        |
| `enable`        | "only X" / "for X and Y" / "specific sites"  | `Include`   | `[X, Y, …]` |
| `disable`       | "for all portals" / "everywhere"             | `None`      | `[]`        |
| `disable`       | "only X" / "for X and Y" / "specific sites"  | `Exclude`   | `[X, Y, …]` |

The consent gate's **Effect** line restates **the user's operation in
plain English** — what they typed, normalized. It is the user-facing
check that the orchestrator parsed the intent correctly. The API mapping
line already shows the technical translation (`policyValue` + ToBeAdded),
so the Effect line does NOT need to repeat that detail; it covers the
intent side.

Effect-line template — pick the row that matches the parsed
`intentDirection` × scope:

| intentDirection | scope qualifier  | Effect-line template |
|-----------------|------------------|----------------------|
| `enable`        | all portals      | *"&lt;Subject&gt; will be enabled on all portals in &lt;ENV_DISPLAY&gt;."* |
| `enable`        | specific portals | *"&lt;Subject&gt; will be enabled on the listed portals in &lt;ENV_DISPLAY&gt;: &lt;site name list&gt;."* |
| `disable`       | all portals      | *"&lt;Subject&gt; will be disabled on all portals in &lt;ENV_DISPLAY&gt;."* |
| `disable`       | specific portals | *"&lt;Subject&gt; will be disabled on the listed portals in &lt;ENV_DISPLAY&gt;: &lt;site name list&gt;."* |

`<Subject>` = the plain-English name of the thing being enabled / disabled,
derived from the policy:

| Policy | `<Subject>` |
|--------|------------|
| `PowerPages_DisableAuthenticationOpenIdConnect` | "OpenID Connect sign-in" |
| `PowerPages_DisableAuthenticationSAML20` | "SAML 2.0 sign-in" |

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
| `policy` | "Which governance setting? OpenID Connect or SAML 2.0?" | "I don't recognize '\<X\>' — supported settings are: OpenID Connect, SAML 2.0. Try again." |
| `intentDirection` | "Do you want to enable or disable it?" | — |
| `envId` | Use the standardized env picker (see "Env picker pattern" below). Track the env from the most recent successful operation as `<RECENT_ENV>` so option 1 can show it; persist the chosen env id as `<ENV_ID>` and the display name as `<ENV_DISPLAY>`. | "I couldn't find an env matching '\<X\>'. Pick from the list or paste an id." |
| `scope` (when `apply`) | "Apply to all sites in \<env\>, no sites, only selected sites, or all except selected?" — only when the user's phrasing was genuinely ambiguous | — |
| `siteIds` (when scope is `Include`/`Exclude`) | "Which sites? Names or IDs, comma-separated. Here's the list: …" | "I couldn't find a site named '\<X\>' in \<env\>." |
| `portalId` (when intent=`fetchSite`) | "Which site? Names or IDs…" | "Couldn't find '\<X\>' in \<env\>." |

Phrases the parser treats as unambiguous and skips the scope prompt for:

- "for all portals" / "across the env" / "everywhere" / "for live portals" /
  "for running portals" — all map to "every portal in this env"
- "for no portals" / "clear the policy" → `policyValue=None`
- "for just X" / "only on X" / "for X and Y" → `Include` with the named sites
- "for everything except X" / "all except X" → `Exclude` with the named sites

### Env picker pattern (standardized 4-option)

When an env is missing or ambiguous, the orchestrator MUST show this exact
`AskUserQuestion` shape. Do NOT inline specific env names in the labels
(except option 1, which echoes the most recent env). The labels stay stable
run-to-run; the dynamic part is option 1's display name.

| # | Label | Description shown to the user | Branch |
|---|-------|-------------------------------|--------|
| 1 | Use the recent environment: \<RECENT_ENV_DISPLAY\> | "Reuse the env from your previous operation in this session: \<RECENT_ENV_DISPLAY\> (\<RECENT_ENV_ID\>)." | Skip ahead with the cached env |
| 2 | Pick from the full environment list | "I'll render the full list of environments you have admin access to (pre-fetched) and you pick a row by number or name." | Render the table from `governance-envs.json` with **exactly two data columns — Environment Name and Environment ID** (plus a leading row number for picking); do NOT include URL, type, region, or any other field. User replies with row number, name, or id. |
| 3 | Provide an environment name or ID | "Paste a name like 'Sachin-Jun-2nd' or an env id like '202c4f04-2eb7-eef3-a26d-14c77c8c13c5'. I'll resolve it against the env list." | Free-text reply; orchestrator resolves with fuzzy match |
| 4 | End the request | "Cancel the current request. No API call will be made." | Exit cleanly without POST or read |

Rules:

- **Option 1 only appears when `<RECENT_ENV>` is set.** On the very first env
  pick of a session, the picker shows options 2–4 only.
- **No top-3 guesses.** Don't list "Sachin-Jun-2nd / Sachin-2026-May22 /
  Test_Test_…" inline. Only option 1's recent env is named.
- **Option 4 exits the request entirely**, not just the env pick. Honor it
  as a cancel and run the loop-end summary.
- After option 2 or 3 resolves to a valid env, update `<RECENT_ENV>` so the
  next request can reuse it via option 1.

### Consent gate (always before POST) — structured summary, not a one-liner

Once every required field is resolved, render a **structured summary** of
the request — every entity the parser pulled from the user's input or the
clarification answers — and then ask for explicit go-ahead. POST is
destructive; this gate is mandatory even on the NLP path. The summary's
purpose is to let the user catch a misinterpretation before any API call
fires.

The summary MUST include:

| Row | Source | Example value |
|-----|--------|---------------|
| Action | from `intentDirection` + policy display name | "Disable the OpenId Connect Protocol" |
| Environment | display name + envId (small, for transparency) | "Sachin-Jun-2nd (`202c4f04-…`)" |
| Scope (plain language) | derived from policyValue + site list | "Every site in this environment" / "Only Site 1 and 8-june" / "Every site except Site 2" / "No sites (clears the policy)" |
| Affected sites | rendered as a small table (name + URL + ID) when Include/Exclude | (see below) |
| What this changes | one-line plain-language consequence | "OpenID Connect sign-in will be blocked on all 3 sites." |

Render it then ask via `AskUserQuestion`:

```
SUMMARY of the change I'll make:

  Action:        Disable the OpenId Connect Protocol
  Environment:   Sachin-Jun-2nd  (202c4f04-2eb7-eef3-a26d-14c77c8c13c5)
  Scope:         Every site in this environment
  Sites in env:
                 | Name   | URL                                       |
                 |--------|-------------------------------------------|
                 | Site 1 | https://site-dmq4c.powerappsportals.com   |
                 | Site 2 | https://site-uo75u.powerappsportals.com   |
                 | 8-june | https://site-pjpuy.powerappsportals.com   |
  Effect:        OpenID Connect sign-in will be blocked on all 3 sites.

  Q: Apply this change?    [ Apply now ]  [ Cancel ]
```

Same pattern adapts to Include / Exclude scopes — render only the sites
that match the scope as the "Sites covered" table, plus a one-line note
about what's NOT covered.

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
| Disable the OpenId Connect Protocol | `PowerPages_DisableAuthenticationOpenIdConnect` |
| Disable the SAML 2.0 Protocol | `PowerPages_DisableAuthenticationSAML20` |

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

The same uniform mapping applies on every policy — see Phase 2.1 for the
canonical version. Reproduced here for the Apply-flow author:

| User said | scope qualifier                                  | policyValue | ToBeAdded   |
|-----------|--------------------------------------------------|-------------|-------------|
| Enable    | "for all portals" / "everywhere" / "live portals"| `All`       | `[]`        |
| Enable    | "only X" / "for X and Y" / "specific sites"      | `Include`   | `[X, Y, …]` |
| Disable   | "for all portals" / "everywhere"                 | `None`      | `[]`        |
| Disable   | "only X" / "for X and Y" / "specific sites"      | `Exclude`   | `[X, Y, …]` |

"Everywhere except X" phrasing is **not** auto-inverted — ask the user to
re-phrase as either *"Enable for X"* or *"Disable for X"*.

### Scope picker (when scope is missing or ambiguous)

When the user's intent has no scope qualifier, ask with these **two**
options. Labels stay neutral — they don't leak `Include` / `Exclude`:

| # | Label | Description shown to the user | Maps to |
|---|-------|-------------------------------|---------|
| 1 | All portals in environment | Apply the chosen Enable/Disable action to every site in the env. Clears any inclusion / exclusion list. | `policyValue=All` (enable) or `policyValue=None` (disable). `ToBeAdded=[]`. |
| 2 | Specific portals | I'll list the sites; you reply with the names or IDs (comma-separated). | `policyValue=Include` (enable) or `policyValue=Exclude` (disable). `ToBeAdded=[picked ids]`. |

The uniform NLP table above is the **source of truth** for the consent-gate
summary. The summary MUST translate `policyValue` back to plain language —
never leak the internal `All` / `Include` / `None` / `Exclude` terms to the
user. The plain-language Effect line MUST match the policy-specific row in
the Phase 2.1 "Enable / Disable" table.

---

## 3. Pick an operation

Use `AskUserQuestion` with three options. Interpolate `<POLICY_DISPLAY_NAME>`
(from Phase 2) into option #1's label and option #3's description so the user
sees concrete language tied to the policy they picked.

| User-facing label (interpolated) | `description` on the question | Internal operation |
|----------------------------------|-------------------------------|--------------------|
| Apply "&lt;POLICY_DISPLAY_NAME&gt;" Governance Policy | Configure and persist the policy value at the environment level. | Apply (POST + watch + verify) |
| Retrieve Environment-Level Policy Status | Evaluate the effective policy status for the environment by reading the environment-level configuration and site-level mappings when the policy is configured as selective enabled/disable. | Fetch Env |
| Retrieve Site-Level Policy Status | Determine whether the "&lt;POLICY_DISPLAY_NAME&gt;" policy is enabled or disabled for a specific site. | Fetch Site |

Persist the chosen operation as `<OP>`.

(The status endpoint is still used internally — `set-governance.js` polls it during Apply and surfaces it via the verify call. It is intentionally not exposed as a standalone operation in the user-facing menu.)

---

## 4. Run the operation

### 4.1 Common — pick an environment

For all three operations the user picks an environment first.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-envs.js"
```

Output is `{ status: "ok", envs: [ { envId, displayName, envUrl, type, region } ] }`. When you render the list to the user, show **only** `displayName` (as "Environment Name") and `envId` (as "Environment ID") — plus a leading row number for picking. Do NOT show `envUrl`, `type`, `region`, or any other field. Render as a **Markdown table** (not a fenced code-block / monospace table) so the chat UI renders proper table styling. Do NOT use `AskUserQuestion` — the list is typically larger than 4 rows. The user replies with a row number, the environment name, or the environment id; resolve fuzzy / case-insensitive matches against the cached list. Persist the choice as `<ENV_ID>` and `<ENV_DISPLAY>`.

Canonical rendering template — emit this **directly in the chat message** (no surrounding fences, no `node ... | head`), one row per environment:

```markdown
| # | Environment Name | Environment ID |
|---|------------------|----------------|
| 1 | Ashmigration | e364969c-d426-eb11-b9d2-c9e20c2cd15a |
| 2 | automationtesting | 6db95a21-0ea2-e287-823a-f9522414f0b7 |
| … | … | … |
```

After the table, add one line: *"Reply with a row number, environment name, or environment ID."* Do NOT also print the raw monospace table.

### 4.2 Apply the policy (`<OP>` = Set)

#### 4.2.1 Pick the scope (4 plain-language options)

Use `AskUserQuestion` with exactly four options that name both axes
explicitly: the **verb** (Enable/Disable) on the Governance Setting AND the
**scope** (all sites vs specific sites). The labels and descriptions shown
to the user MUST be the plain-language variants in the "User-facing label"
column; map them to the internal `policyValue` strings on the right purely
for the API call.

`Include` and `Exclude` are **internal-only** terms — they must never appear in
any `AskUserQuestion` label, description, or summary the user reads.

| User-facing label | What it does (plain language) | Internal `policyValue` | Trigger portal picker? |
|-------------------|-------------------------------|------------------------|------------------------|
| **Enable on all sites in this environment** | Turn the Governance Setting ON for every site in the env. Clears any prior site-level list. | `All` | No |
| **Disable on all sites in this environment** | Turn the Governance Setting OFF for every site in the env. Clears any prior site-level list. | `None` | No |
| **Enable on specific sites** | Turn the Governance Setting ON only for the listed sites; every other site is unaffected. | `Include` | Yes |
| **Disable on specific sites** | Turn the Governance Setting OFF only for the listed sites; every other site stays under the policy. | `Exclude` | Yes |

Persist the chosen `policyValue` as `<POLICY_VALUE>`.

If `<POLICY_VALUE>` is `All` or `None`, jump to **4.2.3** (consent gate). No
portal picker is needed.

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
| # | Name      | URL                                       | Portal ID                              |
|---|-----------|-------------------------------------------|----------------------------------------|
| 1 | Site 1    | https://site-dmq4c.powerappsportals.com   | 3e13d603-2607-43e0-90aa-d15bacaa8787  |
| 2 | Site 2    | https://site-uo75u.powerappsportals.com   | ea51fc54-94e0-47fc-ab13-d3db18567809  |
| 3 | 8-june    | https://site-pjpuy.powerappsportals.com   | fe624c02-8793-4423-84f0-3546d80dee49  |
```

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

#### 4.2.3 Confirm before posting (consent gate)

`AskUserQuestion` — show the picked portals **by name** so the user verifies their intent:

```
Apply <POLICY_PLAIN_LABEL> to <ENV_DISPLAY>?
  - policyValue: <POLICY_VALUE>
  - portals:     <PORTAL_NAMES_LIST>  (or "all" / "none")
```

The consent gate's **Effect** line MUST restate the **user's operation in
plain English** using the template from Phase 2.1. It does NOT repeat the
`policyValue` (the API-mapping line already shows that) and does NOT try
to describe second-order auth side-effects — it covers the intent side.

Pick the row that matches `intentDirection` × scope:

- `enable` + all portals → *"&lt;Subject&gt; will be enabled on all portals in &lt;ENV_DISPLAY&gt;."*
- `enable` + specific portals → *"&lt;Subject&gt; will be enabled on the listed portals in &lt;ENV_DISPLAY&gt;: &lt;names&gt;."*
- `disable` + all portals → *"&lt;Subject&gt; will be disabled on all portals in &lt;ENV_DISPLAY&gt;."*
- `disable` + specific portals → *"&lt;Subject&gt; will be disabled on the listed portals in &lt;ENV_DISPLAY&gt;: &lt;names&gt;."*

`<Subject>` is mapped from the policy per the table in Phase 2.1
("OpenID Connect sign-in" / "SAML 2.0 sign-in").

Options: `Apply now` / `Cancel`. Do not proceed without explicit `Apply now`.

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

After the script exits, re-read the current state at the same scope and show it to the user:

- `policyValue` was `All` or `None` → run **`get-env.js`**.
- `policyValue` was `Include` or `Exclude` → run **`get-portal.js`** (which reads the policyRecord, then check that each picked portal lands on the expected list).

This is a verify step — never trust the polling outcome alone.

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

#### 4.3.1 When `body` is `Include` or `Exclude`, ALWAYS show the list of sites

A bare summary like *"applied to the sites on the allow-list"* leaves the user
guessing. When the env value is `Include` or `Exclude`, the orchestrator MUST
also fetch the policy record + the env's full site list, resolve names, and
render a table.

Steps:

1. Fetch the policy record:
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

3. Pick the list that applies (`InclusionList` for `Include`, `ExclusionList` for
   `Exclude`), resolve each id to a site name + URL from the list-portals
   output, and render **one** table with the appropriate header:

   - `Include` → header: *"Policy is enabled for these sites:"*
   - `Exclude` → header: *"Policy is disabled for these sites:"*

   ```
   Policy is enabled for these sites:
   | Name   | URL                                       | Site ID                                |
   |--------|-------------------------------------------|----------------------------------------|
   | 8-june | https://site-pjpuy.powerappsportals.com   | fe624c02-8793-4423-84f0-3546d80dee49  |
   ```

   Do not also show the "other sites" table — the user asked for the simpler
   one-table form.

   If a list contains an id that does NOT appear in `list-portals` (e.g., the
   site was deleted after being added to the policy), still show it in the
   table with `(site not found)` for the name and an empty URL.

4. Finally, give the one-line plain-language summary (the same pattern as in
   Phase 5).

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
the feature:

| Policy | Governance Setting **Enabled** | Governance Setting **Disabled** |
|--------|--------------------------------|----------------------------------|
| `PowerPages_DisableAuthenticationOpenIdConnect` | "OIDC Protocol sign-in Enabled" | "OIDC Protocol sign-in Blocked" |
| `PowerPages_DisableAuthenticationSAML20` | "SAML Protocol sign-in Enabled" | "SAML Protocol sign-in Blocked" |

Render the cell with the state label first, then the paraphrase in
parentheses:

```
| 1 | Site 1 | …url… | Enabled  (OIDC sign-in Enabled) |
| 2 | 8-june | …url… | Disabled (OIDC sign-in Blocked) |
```

This applies uniformly — env-level renders, per-site renders, the
Phase 5 loop summary, and any verification table. Do NOT invert or
re-interpret these labels based on the underlying API direction; the
user has chosen this mental model and we render it consistently.

Then render the result as a one-line headline + table, **never as
multi-sentence prose**:

For **Enabled**:

```
This Governance setting is Enabled for this Site:

| Name      | URL                                       | Site ID                                |
|-----------|-------------------------------------------|----------------------------------------|
| 8-june    | https://site-pjpuy.powerappsportals.com   | fe624c02-8793-4423-84f0-3546d80dee49  |
```

For **Disabled**:

```
This Governance setting is Disabled for this Site:

| Name   | URL                                       | Site ID                                |
|--------|-------------------------------------------|----------------------------------------|
| Site 1 | https://site-dmq4c.powerappsportals.com   | 3e13d603-2607-43e0-90aa-d15bacaa8787  |
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

Map `<plain policy label>` from the policy display name in Phase 2:

| Policy display name | `<plain policy label>` in summaries |
|---------------------|--------------------------------------|
| Disable the OpenId Connect Protocol | "OpenID Connect block rule" |
| Disable the SAML 2.0 Protocol | "SAML 2.0 block rule" |

These labels read naturally in the loop-summary patterns above. E.g.
"*The OpenID Connect block rule now applies to every site in &lt;env&gt;*"
means the block IS enforced everywhere (`policyValue=All` on the OIDC
policy); "*The OpenID Connect block rule has been cleared on &lt;env&gt;*"
means the block is NOT enforced anywhere (`policyValue=None`).

Map internal `policyValue` values to plain-language phrases when summarizing
Fetch Env:

| Internal | Plain language |
|----------|----------------|
| `All` | "every site" |
| `None` | "no sites" |
| `Include` | "the sites on the allow-list" |
| `Exclude` | "every site except the ones on the exception list" |

Then offer follow-ups via a single `AskUserQuestion`:

| Option | What it does |
|--------|--------------|
| Apply the same policy somewhere else | Re-enters **4.2** with the same `<POLICY>`. |
| Check the same policy somewhere else | Re-enters **4.1** with the same `<POLICY>` and asks Env or Portal scope. |
| Switch to the other policy | Re-enters **2**. |
| Done | Exits cleanly. |

Loop until the user picks Done.

Skill tracking:

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "ManageGovernance"`. The tracking script silently no-ops when not running inside a Power Pages project — that is fine for this skill.

---

## Constraints

- **Plain language** — talk about "turning off the OpenID Connect / SAML sign-in path on portals". Use the policy strings only as labels in `AskUserQuestion` `description` fields when the user has shown they want the technical name.
- **Explicit consent for Set** — never POST `/governance` without a Set-specific `AskUserQuestion` confirmation that spells out which sign-in path is being turned off and what happens to currently-signed-in users.
- **Always verify after Set** — run the matching `get-*` call after the polling script exits, even when it reports success.
- **No env defaults on Set** — never default the env or portal pick. Both must be chosen explicitly.
- **Background polling** — run `set-governance.js` with `run_in_background: true`. Stream stderr to the user at most once every 30 seconds.
- **Policy strings are hard-coded** — only the two policies named in Phase 2.3 are valid (`PowerPages_DisableAuthenticationOpenIdConnect`, `PowerPages_DisableAuthenticationSAML20`). Reject any custom policy name with a clear "this skill only supports those two governance policies today" message.
- **Sign-in failures** — exit code `2` from any script means PAC or Azure CLI is signed out. Tell the user which command to run (`pac auth create` or `az login`) and stop.

## References

- **`references/governance-mapping.json`** — **single source of truth** for the uniform intent→policyValue table, per-policy display names + plain-English state paraphrases, side-effect callouts, scope picker labels, Effect-line templates, env-list rendering rules, and the consent-gate row requirements. The orchestrator MUST read mappings from this JSON rather than re-deriving them from the prose in this file. Updating a label here propagates to every render path (consent gate, verify table, loop summary, parser).
- `references/commands.md` — script flags, response shapes, assumed API contract, exit codes, polling semantics.
