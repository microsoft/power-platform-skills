---
name: manage-governance
description: >-
  Apply, inspect, and monitor Power Pages tenant governance policies. Covers
  twenty-one policies: toggling Maker Copilot for existing sites, enabling/disabling
  sign-in protocols (OpenID Connect, SAML 2.0, WS-Federation, OAuth 2.0), social
  identity providers (Google, Facebook, Microsoft), local login, and external
  auth providers, plus eleven Power Pages Copilot / site-control policies. Sets
  a policy environment-wide or per portal, watches the rollout to completion, and
  reads current state at the environment or portal level. Use when the user wants
  to "turn off OpenID Connect on Power Pages", "disable SAML on a portal",
  "enable/disable Maker Copilot for existing sites", "enable Google/Facebook/Microsoft
  sign-in", "turn off local login", "allow site Copilot on sites", "disable external
  service calls from server logic", or "see the governance status of my Power Pages
  portals" - even if they only name the policy or its side effect without saying
  "governance".
user-invocable: true
argument-hint: "[optional policy or operation hint]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Manage Power Pages Governance Policies

Apply and inspect Power Pages tenant-level governance policies. Twenty-one policies are supported today. One toggles Maker Copilot for existing sites, nine enable/disable Power Pages authentication features (sign-in protocols, social identity providers, local login, and external providers), and eleven govern Power Pages Copilot experiences and site-level controls:

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
| `PowerPages_AllowMakerCopilotsForNewSites` | Allows (or blocks) Maker Copilots on newly created Power Pages sites. |
| `PowerPages_AllowMakerCopilotsForExistingSites` | Allows (or blocks) Maker Copilots on existing Power Pages sites. |
| `PowerPages_AllowProDevCopilotsForSites` | Allows (or blocks) pro-developer Copilots on Power Pages sites. |
| `PowerPages_AllowSiteCopilotForSites` | Allows (or blocks) the site Copilot on Power Pages sites. |
| `PowerPages_AllowSearchSummaryCopilotForSites` | Allows (or blocks) the search-summary Copilot on Power Pages sites. |
| `PowerPages_AllowListSummaryCopilotForSites` | Allows (or blocks) the list-summary Copilot on Power Pages sites. |
| `PowerPages_AllowIntelligentFormsCopilotForSites` | Allows (or blocks) the intelligent-forms Copilot on Power Pages sites. |
| `PowerPages_AllowSummarizationAPICopilotForSites` | Allows (or blocks) the summarization-API Copilot on Power Pages sites. |
| `PowerPages_AllowProDevCopilotsForEnvironment` | Allows (or blocks) pro-developer Copilots for the Power Pages environment. |
| `PowerPages_AllowNonProdPublicSites` | Allows (or blocks) non-production public Power Pages sites. |
| `PowerPages_DisableExtSvcCallsFromServerLogic` | Controls external service calls from Power Pages server-side logic. |

These are **admin-only** operations — applying an auth policy stops or starts the relevant authentication path for the targeted scope, the Maker Copilot policy toggles the Copilot authoring experience for existing sites (environment or portal scope), and the eleven `PowerPages_*` Copilot / site-control policies govern their respective Copilot experiences or site controls for the targeted scope. All twenty new/existing `Enable*` and `PowerPages_*` policies use the **same configuration and Enable/Disable experience** as `EnableMakerCopilotForExistingSites` — uniform governance (every site / no sites / only specific sites / all except specific sites), the same consent gate, and the same verify tables. Always confirm with the user before posting a Set call.

**Initial request:** $ARGUMENTS

## Gotchas

- **Tenant-admin skill, not project-scoped.** Unlike most Power Pages skills, this one does **not** require a `powerpages.config.json` in the current directory. It works against any environment the signed-in user has Power Platform admin access to.
- **Two identifier shapes per portal.** The portal-scoped APIs take `portalId` (the value in the `Id` field on the `/websites` response). The Dataverse `WebsiteRecordId` shown in PAC and YAML is **not** what these APIs accept. The skill resolves portals via the same `/websites` listing that `manage-firewall` uses.
- **Env override is required.** The skill lets the user pick any environment they have access to. Each script accepts `--envId <guid>` and overrides the env in the Power Platform API base URL. When `--envId` is omitted, the script falls back to the env the user is signed into via PAC.
- **Set is async; poll until terminal.** `POST /governance` returns immediately but the policy roll-out is asynchronous. Status comes from `GET /governance/status/{policy}`. The `set-governance.js` script polls this endpoint until the status reaches a terminal value (`Succeeded` / `Completed` for success, `Failed` for failure) or the timeout elapses.
- **Policy names are case-sensitive.** Use the exact policy strings — `EnableMakerCopilotForExistingSites`, `EnableProtocolOpenIdConnect`, `EnableProtocolSAML20`, `EnableProtocolWsFederation`, `EnableProtocolOpenAuth`, `EnableIdpOAuthFacebook`, `EnableIdpOAuthGoogle`, `EnableIdpOAuthMicrosoft`, `EnableAuthenticationLocalLogin`, `EnableExternalAuthProviders`, `PowerPages_AllowMakerCopilotsForNewSites`, `PowerPages_AllowMakerCopilotsForExistingSites`, `PowerPages_AllowProDevCopilotsForSites`, `PowerPages_AllowSiteCopilotForSites`, `PowerPages_AllowSearchSummaryCopilotForSites`, `PowerPages_AllowListSummaryCopilotForSites`, `PowerPages_AllowIntelligentFormsCopilotForSites`, `PowerPages_AllowSummarizationAPICopilotForSites`, `PowerPages_AllowProDevCopilotsForEnvironment`, `PowerPages_AllowNonProdPublicSites`, and `PowerPages_DisableExtSvcCallsFromServerLogic`. Anything else will be rejected by the API.
- **Plain language with the user.** Talk about "turning off the OpenID Connect / SAML sign-in path on Power Pages portals" or "enabling Google sign-in on your sites". Only show the policy string when the user asks for the technical name.
- **OpenID Connect / SAML map to the protocol toggles.** "OpenID Connect" / "OIDC" resolves to `EnableProtocolOpenIdConnect` and "SAML" / "SAML 2.0" resolves to `EnableProtocolSAML20` — whether or not the user adds a "protocol" / "enable" qualifier. (The legacy `PowerPages_DisableAuthentication*` block rules have been removed.) A "block OpenID Connect" / "block SAML" phrasing means **disabling** that protocol toggle.
- **No silent overrides.** **Disabling** any `Enable*` authentication policy (`EnableProtocol*`, `EnableIdp*`, `EnableAuthenticationLocalLogin`, `EnableExternalAuthProviders`) will sign existing users out of any portal that uses the targeted provider. Surface that consequence at the consent gate before posting. (The Maker Copilot policy has no such sign-out side effect.)
- **Parent/child availability is a hard gate on every apply path.** The four sign-in protocols (OpenID Connect, SAML 2.0, WS-Federation, OAuth 2.0) require `EnableExternalAuthProviders` to be Enabled on a portal; the three social providers (Facebook, Google, Microsoft) require **both** `EnableExternalAuthProviders` **and** `EnableProtocolOpenAuth`. On a portal where the required parent is Disabled the child can be **neither enabled nor disabled** — with **no "force"/"anyway" override**. The scope picker **always lists every portal with an explicit `Eligible` (Yes / No) column** (via `resolve-portal-availability.js --markdown`) — eligible portals first, ineligible ones just below with the blocking parent named — and **only the eligible (Yes) portals may be selected**; the **named-site fast path** (when the site is named directly in the request) hard-blocks ineligible sites the same way via Phase 4.2.2b. When **none** qualify (a required parent is Disabled env-wide) it shows a single *"External Auth is Disabled for this environment"* message — and for a **social IdP** (two parents) it names both, *"External Auth or OAuth 2.0 sign-in is Disabled for this environment"* — and the skill does not prompt for a scope or POST. See the "Parent/child availability" section under Phase 2.3. **The environment picker itself is never filtered** — every environment is always shown in the full env list; availability only marks the per-portal Eligible status.
- **Governance STATUS is ALWAYS the complete 5-column Unicode box.** Every status render — Fetch Env (4.3.1), Fetch Site (4.4.3), and the post-Set verify (4.2.5) — uses `render-portal-table.js --unicode --no-color`, emitted **verbatim and in full inside a fenced code block**, with **exactly** the columns `# | Name | URL | Site ID | State` (`┌─┬─┐ │ ├─┼─┤ └─┴─┘`, a rule between every row). Never add, drop, reorder, rename, truncate, summarize, or manually recreate columns or rows, and never substitute a Markdown table or a compact recap table for status. The helper's complete stdout is the status artifact delivered to the user; response-length or brevity preferences never override it. This is uniform for **all twenty-one policies** including the gated children (OpenID Connect / SAML 2.0 / WS-Federation / OAuth 2.0 / Facebook / Google / Microsoft): for a gated child the single `State` shows the **effective** state (own AND every gating parent) — the parent chain is computed but never rendered as extra columns. The eleven `PowerPages_*` Copilot / site-control policies are independent leaves (no gating parent), so their single `State` is simply their own state.
- **Multi-policy status still means full detail for each policy.** When the user asks for the status of **more than one governance setting** in a single request (for example *"What is the status of Facebook, Google, and Microsoft?"*), resolve each requested policy, then run the normal Fetch Env / Fetch Site status path **once per policy**. Each policy MUST render its **own complete** 5-column Unicode table with **every affected site row** and the site **Name, URL, Site ID, and State**. Never replace those per-policy tables with a condensed cross-policy summary matrix.

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

## 2. Entry point

The moment the skill is invoked:

1. **Go straight to the Phase 2.1 free-text intent prompt.** Do **NOT** show a
   top-level `AskUserQuestion` menu (no "Manage a Governance Setting" / "Done"
   choice list, and no numbered/multiple-choice entry menu of any kind). The
   very first user-facing prompt is the Phase 2.1 prose question — ask it
   directly.
2. **Do not pre-warm or cache the environment list.** When the workflow reaches
   an environment picker, call `list-envs.js` fresh and pipe that response
   directly into `render-env-table.js --markdown`. Never create or reuse
   `governance-envs.json`, and never apply a TTL cache to the environment list.

If the user replies that they are done (e.g. "done", "that's all", "exit",
"nothing"), exit cleanly without doing anything else.

## 2.1 Free-text intent prompt

<!-- not-a-gate: data-gathering — free-text intent capture; parsing the user's request shapes later phases but writes nothing on its own -->

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

The parser MUST recognize all twenty-one supported policy display names + their
shorthand variants. All policies share the **same** uniform Enable/Disable
experience — the auth `Enable*` family and the `PowerPages_*` Copilot /
site-control family below are configured exactly like
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
| "maker copilots for new sites" / "new sites copilot" / "maker copilot new sites" | `PowerPages_AllowMakerCopilotsForNewSites` |
| "maker copilots for existing sites" / "existing sites maker copilot" | `PowerPages_AllowMakerCopilotsForExistingSites` |
| "pro dev copilot for sites" / "prodev copilot sites" / "professional developer copilot for sites" | `PowerPages_AllowProDevCopilotsForSites` |
| "site copilot" / "site copilot for sites" / "portal copilot" | `PowerPages_AllowSiteCopilotForSites` |
| "search summary copilot" / "search summary" / "search summarization copilot" | `PowerPages_AllowSearchSummaryCopilotForSites` |
| "list summary copilot" / "list summary" / "list summarization copilot" | `PowerPages_AllowListSummaryCopilotForSites` |
| "intelligent forms copilot" / "intelligent forms" / "forms copilot" / "smart forms copilot" | `PowerPages_AllowIntelligentFormsCopilotForSites` |
| "summarization api copilot" / "summarization api" / "summarization copilot" | `PowerPages_AllowSummarizationAPICopilotForSites` |
| "pro dev copilot for environment" / "prodev copilot environment" / "professional developer copilot for environment" | `PowerPages_AllowProDevCopilotsForEnvironment` |
| "non-prod public sites" / "non production public sites" / "public non-prod sites" | `PowerPages_AllowNonProdPublicSites` |
| "external service calls from server logic" / "disable external service calls" / "server logic external calls" | `PowerPages_DisableExtSvcCallsFromServerLogic` |

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
| `policy` | "Which governance setting? For example OpenID Connect, SAML 2.0, Maker Copilot, a sign-in protocol (WS-Federation / OAuth), a social provider (Google / Facebook / Microsoft), local login, external providers, a Power Pages Copilot (site / pro-dev / search-summary / list-summary / intelligent-forms / summarization-API), non-production public sites, or external service calls from server logic?" | "I don't recognize '\<X\>' — supported settings are the twenty-one governance policies (Maker Copilot, the OpenID Connect / SAML 2.0 / WS-Federation / OAuth 2.0 protocols, Google / Facebook / Microsoft sign-in, local login, external providers, and the Power Pages Copilot / site-control policies). Try again." |
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
>
> **NEVER back-reference a prior message instead of re-emitting the rows.**
> Each env pick is a fresh message, and the full table MUST physically appear in
> that same message — every row, inline. It is a DEFECT to replace the rows with
> any pointer to an earlier message, such as *"(full 64-row list shown above)"*,
> *"(see the table above)"*, *"(list unchanged)"*, *"as shown previously"*, or a
> collapsed one-row excerpt that shows only the flagged/`keep` default. The fact
> that the same table appeared in a previous turn does NOT satisfy this rule —
> paste the complete `render-env-table.js --markdown` output verbatim every
> time. Likewise NEVER emit the `…` / ellipsis placeholder rows that appear in
> this document's *examples*: those abbreviations exist only to keep THIS spec
> short; a real reply must contain the actual environment rows the helper
> printed, never a placeholder. When in doubt, re-run the helper and paste its
> entire output — brevity is never a valid reason to shorten, summarize, or
> reference-instead-of-render the environment list.

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
   node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-envs.js" \
     | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-env-table.js" \
       --markdown [--current "<RECENT_ENV_ID>"]
   ```

   **Fresh API result only.** Run this pipeline for every environment picker.
   Do not render from `--envsFile`, a prior command's output, an in-memory TTL,
   or any other cache. The environment rows must reflect the latest API call.

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
   case-insensitive matches against the fresh list returned for this picker. To cancel the request
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
consent summary, resolve the **Current State** of each affected site with a
single parallel batch — `get-effective-status.js` (it reads the env value, the
membership lists, and any gating parents concurrently and returns each site's
effective state). **New State** is what that site becomes after the requested
operation
(enable → Enabled, disable → Disabled, for the sites in scope). Render both cells with the green/red convention (`🟢 Enabled` / `🔴 Disabled`)
from `governance-mapping.json` `stateColors`. This lets the user see the exact
transition before approving. If a live read fails, render Current State as
`Unknown` (never block the gate on a read error) and say so in a footnote.

Render it then ask for explicit go-ahead as a **2-option `AskUserQuestion`**
whose only choices are **Apply now** and **Cancel** (no free-text prompt, no
third option). After the impact summary, present the question *"Proceed with
this change?"* with exactly those two choices. Do
**NOT** prepend any lead-in line, heading, or label of any kind — e.g.
 "Impact summary:", "Here's the impact summary:", "SUMMARY of the change I'll
make:", "Impact summary:", or similar. Start the impact summary directly at the
`Action:` row.

The Sites table is a **GitHub-flavored Markdown table**, emitted un-fenced so
the chat client renders it. (It is intentionally NOT a fixed-width ASCII/Unicode
box: the double-width 🟢/🔴 State emoji misalign the box columns in chat.) A
row whose state actually flips is tagged `← CHANGED` in its New State cell:

Action:        🔴 Disable OpenID Connect sign-in
Environment:   Sachin-Jun-2nd  (202c4f04-2eb7-eef3-a26d-14c77c8c13c5)
Scope:         Every site in this environment
Sites in env:

| Portal Name | Portal URL | Portal ID | Current State | New State |
| --- | --- | --- | --- | --- |
| Site 1 | https://site-dmq4c.powerappsportals.com | 3e13d603-2607-43e0-90aa-d15bacaa8787 | 🟢 Enabled | 🔴 Disabled ← CHANGED |
| Site 2 | https://site-uo75u.powerappsportals.com | ea51fc54-94e0-47fc-ab13-d3db18567809 | 🟢 Enabled | 🔴 Disabled ← CHANGED |
| 8-june | https://site-pjpuy.powerappsportals.com | fe624c02-8793-4423-84f0-3546d80dee49 | 🔴 Disabled | 🔴 Disabled |

Effect:        OpenID Connect sign-in will be disabled on all portals in Sachin-Jun-2nd.
Policy value:  None

Then ask a **2-option `AskUserQuestion`** — question *"Proceed with this
change?"*, choices **Apply now** / **Cancel** (nothing else).

> **The CLI appends its own "Other (type your answer)" line to every question —
> this is a fixed Copilot CLI behavior the skill cannot suppress.** Do not try to
> remove it. Only a selected **Apply now** authorizes the POST; any freeform
> "Other" text is treated as non-authorizing (equivalent to Cancel unless it
> clearly says to apply).

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
| Allow Maker Copilots for new sites | `PowerPages_AllowMakerCopilotsForNewSites` |
| Allow Maker Copilots for existing sites | `PowerPages_AllowMakerCopilotsForExistingSites` |
| Allow pro-dev Copilots for sites | `PowerPages_AllowProDevCopilotsForSites` |
| Allow site Copilot for sites | `PowerPages_AllowSiteCopilotForSites` |
| Allow search summary Copilot for sites | `PowerPages_AllowSearchSummaryCopilotForSites` |
| Allow list summary Copilot for sites | `PowerPages_AllowListSummaryCopilotForSites` |
| Allow intelligent forms Copilot for sites | `PowerPages_AllowIntelligentFormsCopilotForSites` |
| Allow summarization API Copilot for sites | `PowerPages_AllowSummarizationAPICopilotForSites` |
| Allow pro-dev Copilots for the environment | `PowerPages_AllowProDevCopilotsForEnvironment` |
| Allow non-production public sites | `PowerPages_AllowNonProdPublicSites` |
| Disable external service calls from server-side logic | `PowerPages_DisableExtSvcCallsFromServerLogic` |

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

<!-- not-a-gate: data-gathering — resolving scope (all vs specific sites); no destructive action, the consent gate later guards the POST -->

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

### Parent/child availability (child auth policies)

Some auth policies are only meaningful on a portal when a **parent** policy is
already Enabled there. This is a different concept from the Phase 4.2.3 cascade
(what a parent *turns off* downstream). Availability is a **hard gate**: a portal
on which a required parent is **Disabled** is **not available** to configure the
child policy on — the child can be **neither enabled nor disabled** there, with
**no "force"/"anyway" override**. This gate is enforced on **both** apply paths:
the scope picker **always shows every portal with an explicit `Eligible` (Yes /
No) column** (the ineligible ones listed just below with the blocking parent
named, and if **no** portal is eligible it shows a single *"&lt;parent&gt; is
Disabled for this environment"* message instead of an all-No list) — but **only
the eligible portals may be selected** — and the **named-site fast path** (Phase
4.2.2b) hard-blocks any directly named ineligible site the same way.

The dependency tree (source of truth: `governance-mapping.json` →
`policies[].availabilityDependsOn` and top-level `policyAvailabilityDependencies`):

- **`EnableExternalAuthProviders`** (External Auth) is the root parent. When it
  is **Disabled** for a portal, that portal is **unavailable** for:
  - OpenID Connect (`EnableProtocolOpenIdConnect`)
  - SAML 2.0 (`EnableProtocolSAML20`)
  - WS-Federation (`EnableProtocolWsFederation`)
  - OAuth 2.0 (`EnableProtocolOpenAuth`)
- **`EnableProtocolOpenAuth`** (OAuth 2.0) *and* External Auth together gate the
  three OAuth-based social identity providers. When **either** is **Disabled**
  for a portal, that portal is **unavailable** for:
  - Facebook (`EnableIdpOAuthFacebook`)
  - Google (`EnableIdpOAuthGoogle`)
  - Microsoft (`EnableIdpOAuthMicrosoft`)

A child is **available** on a portal iff **every** parent in its
`availabilityDependsOn` list is Enabled there. Availability is computed by
`resolve-portal-availability.js`, which reads each parent's env value + its
inclusion/exclusion lists and partitions the portal list into `available` (all
parents Enabled) and `unavailable` (at least one parent Disabled, with
`blockingParents` naming which). Posture is **fail-open**: a parent whose state
can't be read never hides a portal.

The scope picker renders this partition with the default `--markdown` view
(Phase 4.2.1 Step B.1): it lists **every** portal — `available` first (marked
**✅ Yes**), then `unavailable` directly below (marked **🚫 No — blocked by
&lt;parent&gt;**) — with an explicit `Eligible` column, and

- only the **✅ Yes** portals may be selected (the **🚫 No** rows are shown for
  transparency, so the admin sees which sites are blocked and why — the
  requirement's *"always show the eligible portal with Status Eligible
  Yes/No"*);
- when `available` is empty (a parent is Disabled env-wide), it prints the single
  *"External authentication providers is Disabled for this environment"* message
  (for a **social IdP** it names both parents — *"External authentication
  providers **or** OAuth 2.0 sign-in is Disabled for this environment"*) and the
  orchestrator does **not** prompt for a scope or POST (the requirement's *"if
  there is no portal available, show 'External Auth or OAuth2 is Disabled'"*).

> **OAuth 2.0 is both a child and a parent.** `EnableProtocolOpenAuth` depends
> on `EnableExternalAuthProviders` (so it is filtered like the other protocols)
> **and** gates the three social providers. Only `EnableExternalAuthProviders`
> is a pure root with no `availabilityDependsOn`.

When the target policy has **no** `availabilityDependsOn` (Maker Copilot, local
login, External Auth itself), every portal is available and this pre-filter is a
no-op — render the site list normally.

> **The environment picker is never filtered.** This availability rule only
> applies to the per-portal **scope** picker (Phase 4.2.1). The **environment**
> list is always rendered in full via `render-env-table.js` — no environment is
> ever removed or moved into a separate list based on a parent's state.

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

**Always run the environment picker from a fresh API response**, regardless of
whether the request already named an environment:

- **Environment already provided** (the user named an env or gave an env id,
  e.g. *"disable OIDC in Contoso-Prod"*): fetch `list-envs.js` fresh, resolve the
  name/id against that response, pass the resolved id as `--current`, render the
  complete table, and require `keep` or a switch before proceeding.
- **Environment not provided**: fetch `list-envs.js` fresh, render the complete
  table, default to `<RECENT_ENV>` when set (or the tenant-default environment
  on the first request), and require `keep` / switch / `cancel`.

Never skip or reuse a prior environment-list result. Only the previously chosen
environment id may persist as the row-selection marker.

The env list always comes from a fresh `list-envs.js` call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-envs.js" \
  | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-env-table.js" --markdown
```

`list-envs.js` outputs `{ status: "ok", envs: [ { envId, displayName, envUrl, type, region } ] }`. Pipe that same fresh response directly through `render-env-table.js --markdown` and emit the Markdown table **verbatim** (as a rendered table, not inside a code fence). Resolve the user's row-number / name / id reply against that response (fuzzy, case-insensitive). Persist only the chosen `<ENV_ID>` / `<ENV_DISPLAY>` as `<RECENT_ENV>` for the selection marker; never persist or cache the environment list.

> **The environment list is never filtered.** Always render **every**
> environment via `render-env-table.js --markdown` — regardless of policy. Parent
> availability (External Auth / OAuth 2.0 state) is applied **only** later, at the
> per-portal scope picker (Phase 4.2.1), never to the environment list itself.

### 4.2 Apply the policy (`<OP>` = Set)

**Entry variants — skip any step the request already resolved.** Branch on
what the Phase 2.1 parse produced, then run only the remaining steps:

| What the request provided | Steps to run |
|---------------------------|--------------|
| **Nothing** (no env, no sites) | 4.1 pick env → 4.2.1 **eligible** sites (child auth policy → `resolve-portal-availability.js --markdown`, all portals with an Eligible Yes/No column; else plain list) + all/selected → (4.2.2 if selected) → **4.2.3 Impact Summary + consent** → 4.2.4 apply → 4.2.5 verify |
| **Environment only** | 4.1 fetches and renders the fresh env list with the named env selected → explicit confirmation → 4.2.1 **eligible** sites (child auth policy → `resolve-portal-availability.js --markdown`, all portals with an Eligible Yes/No column; else plain list) + all/selected → (4.2.2 if selected) → **4.2.3 Impact Summary + consent** → 4.2.4 apply → 4.2.5 verify |
| **Environment + site(s)** | 4.1 resolves env + resolve named site(s) to `<PORTAL_IDS>` (skip 4.2.1/4.2.2) → **4.2.2b availability gate (hard-block named sites whose parent is Disabled)** → **4.2.3 Impact Summary + consent** → 4.2.4 apply → 4.2.5 verify |

> **Mandatory eligibility filter for the seven child auth policies.** For any of
> the four sign-in protocols (OpenID Connect, SAML 2.0, WS-Federation, OAuth 2.0)
> or the three social providers (Facebook, Google, Microsoft), the **only**
> portals ever shown, offered, or POSTed in the scope step are the **eligible**
> ones — those whose gating parent is Enabled (External Auth for the protocols;
> External Auth **and** OAuth 2.0 for the social providers). The scope picker
> (4.2.1 Step B.1) and the named-site fast path (4.2.2b) both enforce this via
> `resolve-portal-availability.js`. There is **no** path — not "environment
> only", not "environment + sites", not a loop iteration — that shows the plain
> unfiltered `list-portals.js` table for these policies or lets an ineligible
> portal be selected. Never bypass it.

When sites are already named in the request, resolve them with
`parse-portal-input.js` (against `list-portals.js` output) to get
`<PORTAL_IDS>` / `<PORTAL_NAMES_LIST>` and set `<POLICY_VALUE>` = `Include`
(enable) or `Exclude` (disable). **Then — for a child auth policy (one with a
non-empty `availabilityDependsOn`) — you MUST run the Phase 4.2.2b availability
gate on the named sites BEFORE jumping to 4.2.3.** The named-site fast path does
**not** get to skip the parent-gate check just because it bypasses the scope
picker: a portal whose required parent is Disabled is **hard-blocked** for the
child policy — it can be neither enabled nor disabled there — and there is **no
"force"/"anyway" override.** Only after 4.2.2b confirms every named site is
eligible do you jump to **4.2.3**. The **Impact Summary is always shown before
the consent gate in every variant** — never POST without it.

#### 4.2.1 Pick the scope (site list + free-text input)

Do **NOT** use an `AskUserQuestion` for the scope. Instead, show the site
list and take a single **free-text** reply. The **verb** (Enable / Disable)
is already known from the parsed intent (`<INTENT_DIRECTION>`); this step only
resolves **scope** (all sites vs specific sites).

<!-- not-a-gate: data-gathering — enable/disable verb capture; no destructive action, the consent gate later guards the POST -->

**Step A — resolve the verb.** Use `<INTENT_DIRECTION>` from the NLP parse.
Only if it is genuinely missing, ask a single short **free-text** prompt (NOT an
`AskUserQuestion`): *"Do you want to **enable** or **disable** it? Reply
'enable' or 'disable'."* Map the reply to the verb, then continue.

**Step B — choose the correct site-list source (MANDATORY branch — NEVER skip).**
Before showing any site list, branch on whether `<POLICY>` is a **child auth
policy** (has a non-empty `availabilityDependsOn` in `governance-mapping.json`).
This branch decides which command produces the list — get it wrong and the admin
can pick an ineligible portal, which is a defect:

- **Child auth policy** — the four sign-in protocols **OpenID Connect /
  SAML 2.0 / WS-Federation / OAuth 2.0** and the three social providers
  **Facebook / Google / Microsoft**. You **MUST** build the site list from the
  availability resolver in **Step B.1** (`resolve-portal-availability.js
  --markdown`), which shows **every portal with an explicit `Eligible` (Yes /
  No) column** — eligible ones first, ineligible ones just below with the
  blocking parent named — and lets **only the eligible portals** be selected.
  **NEVER show the plain `list-portals.js` table for these policies**, and
  **NEVER prompt for scope or POST over an unfiltered list or an ineligible
  portal**. Skipping the eligibility filter, or listing/allowing a portal whose
  required parent is Disabled, is a hard defect with no exception. Go straight to
  **Step B.1** — do **not** render the plain table below first.
- **Root / independent policy** — `<POLICY>` has **no** `availabilityDependsOn`
  (Maker Copilot, local login, **External Auth** itself, and **OAuth 2.0** when
  it is the target policy — it is a root parent, not a child). Every portal is
  eligible, so show the plain full site list below.

**Plain site list — ROOT / INDEPENDENT policies only.** Show the site list so
the free-text input is safe (admins recognise site **names**, not GUIDs):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>"
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

**Step B.1 — eligibility view (child auth policies — MANDATORY, never
bypass).** When the target `<POLICY>` has an `availabilityDependsOn` list in
`governance-mapping.json` (the four sign-in protocols and the three social
providers — see the "Parent/child availability" section under Phase 2.3), this
step is **required** and **replaces** the plain Step B table entirely: run the
resolver **before** prompting for scope, and render the site list in the
**default `--markdown`** mode (do **NOT** pass `--available-only`) so the scope
picker **always shows EVERY portal with an explicit `Eligible` (Yes / No)
column** — the eligible sites first, the ineligible ones listed directly below
with the blocking parent named. This is the requirement *"always show the
eligible portal with Status Eligible Yes/No"*: the admin sees the full portal
list and which ones can/can't be targeted, not a silently-filtered subset. There
is **no** code path where a child auth policy skips this and shows the plain
unfiltered `list-portals.js` table — doing so is a defect:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
  | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/resolve-portal-availability.js" \
      --policy "<POLICY>" --envId "<ENV_ID>" --markdown
```

The helper reads each parent policy's env value + inclusion/exclusion lists and
then behaves as follows:

- **At least one site eligible** — it prints ONE table of **every** portal with
  columns `# | Portal Name | Portal URL | Portal ID | Eligible`. Eligible rows
  show **✅ Yes** and are listed first; ineligible rows show **🚫 No — blocked by
  &lt;parent&gt; (Disabled)** and are listed directly below (per *"Disabled
  Portal or Environment should be shown just below it"*). For a **social IdP**
  (two parents) an ineligible row names whichever parent(s) are off. Emit this
  output verbatim in place of the plain Step B table, then **always** prompt for
  scope (Step C). **Only the ✅ Yes (eligible) portals may actually be chosen**
  — the ineligible rows are shown for transparency only.
- **No site eligible** (a parent is Disabled env-wide, so `available` is
  empty) — the helper prints a single message. For a single-parent child:
  **"The External authentication providers Governance setting is off for this
  environment. No sites are available to configure &lt;child&gt; here — turn on
  the External authentication providers Governance setting first, then try
  again."** For a **social IdP** the message names **both** parents — **"The
  External authentication providers or OAuth 2.0 sign-in Governance setting is
  off for this environment. No sites are available to configure &lt;child&gt;
  here — turn on **both** the External authentication providers **and** OAuth
  2.0 sign-in Governance settings first, then try again."** In this case
  **do NOT prompt for a scope and do NOT POST**: surface that message and stop.

  **Offer ONLY the next parent in dependency order — never a flat OR.** The
  resolver's JSON output carries an ordered **`remediationChain`** (the
  currently-Disabled gating parents, **root-first**) and **`next`** (=
  `remediationChain[0]`). Read `next` from the resolver JSON (the same
  `resolve-portal-availability.js` call, default JSON mode — `remediationChain`
  and `next` are always present) and offer the admin **exactly one** enable
  action: **`next.subject`**. Do **NOT** present the two parents as parallel OR
  options (*"enable external auth **or** enable oauth"*). That old phrasing is a
  dead-end for a social IdP whose parents are both off: OAuth 2.0 is itself
  gated by External Auth, so *"enable oauth"* would immediately hit the same
  hard block. Because the chain is **root-first**, `next` is always the parent
  the admin **can** actually turn on right now (External Auth before OAuth 2.0).
  After that parent is enabled, re-running the resolver drops it from the chain,
  so `next` advances to the following parent (or the chain empties and the child
  becomes eligible) — see **Step B.2 (auto-resume)** below.

  Any follow-up you offer here MUST be a **free-text prose prompt — NOT an
  `AskUserQuestion` / button menu.** Ask the admin, in plain prose, for a
  free-text command naming **only `next`** — e.g. for a social IdP with both
  parents off: *"To turn Google sign-in on, the External authentication
  providers Governance setting has to be enabled first (OAuth 2.0 depends on it,
  so it comes next). Reply **enable External Auth** to turn it on now — I'll pick
  Google back up automatically once it's on — name a different setting or site,
  or reply **cancel** to stop."* Keep the offered actions limited to enabling
  **`next`** or cancelling — do **NOT** list a deeper parent (e.g. OAuth 2.0)
  as a co-equal choice, do **NOT** offer a diagnostic option such as *"Check
  which sites have which parent off"* (or any similar per-site parent-state
  breakdown), and do **NOT** wrap the follow-up in numbered / multiple-choice
  buttons. This is the requirement's *"if there is no portal available, show
  'External Auth or OAuth2 is Disabled' and ask a free-text command"* — refined
  so the one command offered is always the enable action that will actually
  succeed.

  **Remember the original request (`<PENDING_CHILD_INTENT>`).** Before you stop,
  persist the admin's original child intent — the parsed `{ policy, direction,
  env, scope, siteIds/siteNames }` for *"&lt;enable/disable&gt; &lt;child&gt;"* —
  as `<PENDING_CHILD_INTENT>`. This is what lets the flow **auto-resume** the
  child after the admin enables `next`, instead of making them re-type *"enable
  Google"*. See Step B.2.

Only the **eligible** (✅ Yes) portals may be chosen. If the admin names a site
that shows **🚫 No**, tell them the gating parent is Disabled on it and ask them
to pick one of the eligible sites (or enable the parent there first). This is a
**hard block** — the child policy can be neither enabled nor disabled on an
ineligible site, and there is **no "force"/"anyway" override** (see Phase
4.2.2b, which enforces the same rule on the named-site fast path). When
`<POLICY>` has no `availabilityDependsOn` (Maker Copilot, local login, External
Auth, OAuth 2.0), **skip this step** and use the plain table from Step B.

**Step B.2 — auto-resume the original child intent after a parent is enabled.**
This closes the loop the admin actually started from. When `<PENDING_CHILD_INTENT>`
is set (Step B.1 "No site eligible", or the named-site path Phase 4.2.2b) and the
admin's next reply is the offered **enable `next`** command, run the parent
enable as a **normal, fully-gated Apply** (Phase 4.2.3 Impact Summary + `Apply
now` consent gate + 4.2.4/4.2.5 — the parent has its **own** sign-out consent;
**never** auto-enable it silently). Then, the moment that parent Apply reaches its
success terminal state:

1. **Do NOT return to the generic Phase 5 loop and forget the child.** Instead,
   re-load `<PENDING_CHILD_INTENT>` and **re-run the availability resolver** for
   that child against the same env.
2. **Re-present automatically** based on the fresh resolver output:
   - `next` is still non-null (another parent is still Disabled — e.g. External
     Auth is now on but OAuth 2.0 is still off for a social IdP) → offer the
     **new** `next` the same way (Step B.1), keeping `<PENDING_CHILD_INTENT>`
     set. The chain advances one step per parent enabled.
   - `available` is now non-empty (every parent enabled → the child is eligible)
     → **resume the original child operation** exactly where it was blocked:
     re-enter Step B.1's eligibility view and Step C scope prompt (or, if the
     original intent already named a scope/sites, jump straight to the Phase
     4.2.3 Impact Summary for the child). Announce the resume in one line —
     *"External authentication providers is on now, so I'm picking your original
     request back up: enabling Google sign-in in &lt;env&gt;."* Then **clear**
     `<PENDING_CHILD_INTENT>`.
3. If the admin instead replies with a **different** request (a new policy/env,
   or `cancel`), discard `<PENDING_CHILD_INTENT>` and handle the new request
   normally — the resume is an offer, never a lock-in.

This is the single mechanism that fixes **both** review defects: offering only
the root-first `next` (never a dead-end OR), and remembering + auto-re-presenting
the original child so the admin never has to re-issue *"enable Google"*.

**Step C — prompt for scope (prose, free text — NOT an `AskUserQuestion`).**
Ask, using the known verb:

> *"Reply **all** to &lt;enable/disable&gt; the setting on **every** eligible
> site in &lt;ENV_DISPLAY&gt;, or reply with a **comma-separated** list of site
> names or IDs to &lt;enable/disable&gt; only those. Reply 'cancel' to stop."*

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
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>"
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

> **Eligibility view (child auth policies).** Same rule as Phase 4.2.1
> Step B.1 — when `<POLICY>` has an `availabilityDependsOn` list, render this
> site list via `resolve-portal-availability.js --markdown` so **every** portal
> is shown with an explicit `Eligible` (Yes / No) column (eligible first,
> ineligible just below with the blocking parent named). Only the **eligible**
> portals may be chosen; if the user names an ineligible one, tell them the
> gating parent is Disabled on it and reprompt. If no portal is eligible, show
> the *"External Auth is Disabled for this environment"* message and do not
> proceed.

If the list is empty, tell the user there are no portals in that environment and back the user up to **4.2.1**.

Then prompt the user (prose, not `AskUserQuestion` — the answer is free text).
Use plain language matching the 4.2.1 choice:

- When `<POLICY_VALUE>` is `Include`: *"Reply with a comma-separated list of the site names or IDs you want to **enable** the Governance Setting on. The others stay as-is."*
- When `<POLICY_VALUE>` is `Exclude`: *"Reply with a comma-separated list of the site names or IDs you want to **disable** the Governance Setting on. The others stay under the policy."*

Parse the user's reply with the helper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
  | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/parse-portal-input.js" \
      --portalsStdin --input "<USER_INPUT>"
```

Or call `parsePortalInput(input, { validIds: portals })` directly when integrating from JS. Output: `{ policyValue, portalIds[], resolvedNames[], errors[] }`.

When invoking the parser from this step the orchestrator should ignore the parser's `policyValue` field (it was decided in 4.2.1) and only use `portalIds` + `resolvedNames`. If `errors` is non-empty, surface each one to the user and reprompt.

Persist `<PORTAL_IDS>` (comma-joined) for downstream steps. Persist `<PORTAL_NAMES_LIST>` (the `resolvedNames` array joined with commas) for the consent gate.

#### 4.2.2b Availability gate for named sites (child auth policies — HARD BLOCK)

This gate runs on the **named-site fast path** (the "Environment + site(s)"
entry variant) — the path that skips the scope picker (4.2.1/4.2.2) and its
Step B.1 eligibility view. Because that view is skipped, the parent
dependency must be enforced **here** instead, so a directly-named ineligible
site can never slip through to a POST.

**When it applies.** Only when `<POLICY>` has a non-empty `availabilityDependsOn`
list in `governance-mapping.json` (the four sign-in protocols and the three
social providers). For a policy with **no** parents (Maker Copilot, local login,
`EnableExternalAuthProviders`, and — for availability purposes — any leaf), skip
this gate: every named site is eligible.

**The rule (hard block, both directions).** A child auth policy can be **neither
enabled nor disabled** on a portal where a required parent is **Disabled**:

- OAuth 2.0 / OpenID Connect / SAML 2.0 / WS-Federation → blocked on any portal
  where **External Auth** (`EnableExternalAuthProviders`) is Disabled.
- Facebook / Google / Microsoft → blocked on any portal where **External Auth**
  **or** **OAuth 2.0** (`EnableProtocolOpenAuth`) is Disabled.

There is **NO override.** Do **not** offer a "force-enable / force-disable
anyway", "toggle the own setting regardless", or any similar bypass — the parent
gate is absolute. (The child's own governance setting is meaningless while the
umbrella provider is off, so writing it is disallowed, not merely discouraged.)

**How to check.** Pipe the resolved named-site JSON directly to the resolver in
JSON mode. Do not create a temporary portal-list file:

```bash
echo '{ "portals": [ { "portalId": "<id>", "name": "<name>", "url": "<url>" }, ... ] }' \
  | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/resolve-portal-availability.js" \
      --policy "<POLICY>" --envId "<ENV_ID>"
```

The JSON output partitions the named sites into `available` and
`unavailable[{ portalId, name, blockingParents, blockedBy }]`. `blockedBy` names
the Disabled parent(s) in plain "Governance setting" language. It also carries
the ordered **`remediationChain`** (root-first Disabled gating parents) and
**`next`** (= `remediationChain[0]`, the one parent to offer enabling first) —
used by the "every named site unavailable" branch below.

**Act on the partition:**

- **Every named site unavailable** → **do NOT render the Impact Summary and do
  NOT POST.** Tell the admin the child can't be configured on the named site(s)
  because the gating parent is Disabled there, name the parent(s), and stop.
  **Offer only the root-first `next` parent** and **persist the original request
  as `<PENDING_CHILD_INTENT>`** exactly as in Phase 4.2.1 Step B.1 — read `next`
  from this resolver's JSON output, offer the single **enable `next`** free-text
  command (never a flat OR), and on the admin's enable reply run the parent Apply
  then **auto-resume** the named-site child per Step B.2. Do not make the admin
  re-type the original request.
- **Some named sites unavailable** → **drop the blocked sites from
  `<PORTAL_IDS>` / `<PORTAL_NAMES_LIST>`** and tell the admin exactly which were
  removed and why (naming the blocking parent). Proceed to 4.2.3 with **only the
  eligible** named sites. If that leaves zero eligible sites, treat it as the
  "every named site unavailable" case above.
- **All named sites available** → proceed to 4.2.3 unchanged.

Render the blocked sites so the admin sees *why* — one line per blocked site
naming the Disabled parent, e.g.:

- 🔴 Portal_1 — Facebook can't be configured here · blocked by: **External Auth is Disabled on Portal_1**

Fail-open on unread parents (a parent whose live state can't be read never
blocks a site — the resolver already applies this posture); note the unread
parent to the admin rather than silently blocking.

#### 4.2.3 Confirm before posting (Impact Summary + consent gate)

Confirm with a **2-option `AskUserQuestion`** (choices **Apply now** /
**Cancel** — never a free-text prompt, never a third option). First render the
**Impact Summary** deterministically
with the helper (do NOT hand-build it — the helper keeps the Action /
Environment / Scope / Sites / Effect / Side-effect rows consistent with the
committed spec and per-policy data), then ask for explicit go-ahead.

**Step 1 — resolve each affected site's Current State.** Read the live policy
state so the summary can show the exact transition with **one parallel batch** —
pipe `list-portals.js` into `get-effective-status.js` **once**
(`list-portals.js --envId <ENV_ID> | get-effective-status.js --policy <P>
--envId <ENV_ID>`). It fires the env value, the membership list, and (for
a gated child) every gating parent concurrently in a single `Promise.all` wave,
and returns each in-scope site's effective `state`. Do **NOT** hand-issue
`get-env.js` / `get-details.js` / `get-portal.js`, and never loop per portal. If
a live read fails, pass `currentState: "Unknown"` (never block the gate on a read
error).

**Step 1b — redundant-operation guard (already in the requested state).**
Before rendering the Impact Summary, compare each in-scope site's Current State
(from Step 1) to the state the request would set it to. When **every** site in
scope is **already** in the requested state — i.e. the operation is a no-op for
the sites the admin named — do **NOT** POST silently and do **NOT** skip ahead.
Stop and ask the admin how to proceed, because the two reasonable outcomes
diverge and one of them changes *other* sites.

This guard fires in exactly these situations:

| Op | Current env policy | In-scope site(s) already… | Guard fires |
|----|--------------------|---------------------------|-------------|
| **Enable** `<sites>` | `All` (or `Include` already containing them) | Enabled | yes |
| **Disable** `<sites>` | `None` (or `Exclude` already containing them) | Disabled | yes |

When it fires, ask a single **free-text** prompt (NOT an `AskUserQuestion`).
Do **not** use the old "Keep vs Enforce only" phrasing — instead present the
standard **eligible-portal scope prompt**, so the admin either leaves it as-is
(`All`, a no-op) or narrows it to specific portals. `<POLICY_SUBJECT>` is the
policy's plain-English `subject`; `<enable|disable>` is the requested verb;
`<enabled|disabled>` is its current-state adjective; "eligible portals" is the
availability-filtered set (for a child auth policy, only sites where the parent
is Enabled; for a policy with no `availabilityDependsOn`, every site):

> *"Since `<POLICY_SUBJECT>` is already `<enabled|disabled>` on every eligible
> portal in `<ENV_DISPLAY>`, how would you like to proceed?*
> *Reply **All** to `<enable|disable>` it on **all eligible portals** (no change
> — they are already `<enabled|disabled>`), or reply with a **comma-separated
> list of portals** to `<enable|disable>` only those. Reply **cancel** to stop."*

Map the reply:

- **All** (or "every site") → the env-wide operation is a genuine no-op. Make
  **no** API call. Report *"No change made — `<POLICY_SUBJECT>` is already
  `<enabled|disabled>` on every eligible portal in `<ENV_DISPLAY>`."* and go
  straight to the Phase 5 loop. Skip the consent gate and the POST entirely.
- **comma-separated portals** → set `<POLICY_VALUE>` = `Include` (enable) or
  `Exclude` (disable) with `<PORTAL_IDS>` = the named portal(s), then continue to
  Step 2 (render the Impact Summary) and the normal consent gate. **Do not POST
  yet** — the admin still approves at the gate.
- **cancel** → exit cleanly with *"No change made."*; do not POST.

> **Narrowing to specific portals changes other sites — surface it.** Switching
> the env-wide value to an explicit list re-scopes the policy for **every** site,
> not just the named one. When the current env value is `All` and the admin
> narrows an **enable** to specific portals (`Include`), the portals **not**
> listed flip from Enabled → Disabled. When the current env value is `None` and
> the admin narrows a **disable** to specific portals (`Exclude`), the portals
> **not** listed flip from Disabled → **Enabled** (because `Exclude` enables the
> policy everywhere except the listed sites). Either way, after the admin names
> specific portals, the Impact Summary / consent gate MUST make the collateral
> explicit: list the out-of-scope sites and their Current → New State so the
> admin sees the full blast radius before replying `Apply now`. Never let a
> narrowed-scope POST flip other sites without showing it.

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
the Current State → New State transition per site, marks changed rows, prints a
**Policy value** line just below Effect (the internal `policyValue` that will be
POSTed, plus the `ToBeAdded` portal-id list for `Include`/`Exclude`), and adds
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

**Step 3 — ask for consent.** After the summary, present a **2-option
`AskUserQuestion`** — question *"Proceed with this change?"*, choices
**Apply now** and **Cancel** (exactly those two, no free-text, no extra option).
Do not proceed without the user selecting **Apply now**. If the user selects
**Cancel**, exit
cleanly with *"No change made."* and do not POST.

#### 4.2.4 Apply and watch

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/set-governance.js" \
  --envId "<ENV_ID>" \
  --policy "<POLICY>" \
  --policyValue "<POLICY_VALUE>" \
  [--portalIds "<PORTAL_IDS>"]
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

- `policyValue` was `All` or `None` → run **`get-effective-status.js`** once (it parallel-reads the env value + membership in a single wave).
- `policyValue` was `Include` or `Exclude` → run **`get-effective-status.js`** once — it fires the env value **and** the inclusion/exclusion list (and, for a gated child, every gating parent) concurrently in **one** `Promise.all` batch, then returns each portal's effective `state`. Confirm every picked portal landed on the expected state. Do **NOT** hand-issue `get-env.js` / `get-details.js` / `get-portal.js`, and do **NOT** loop per portal. **Wait until `set-governance.js` reports the terminal state before this read** — Set is async, so reading mid-rollout can return stale membership.

**Render the verification as a state table (canonical structure).** After the
read confirms the new state, render a headline + table that lists **every site
the operation touched**. **Do NOT hand-build the table.** Instead render it with
the **`render-portal-table.js`** helper in **`--unicode`** mode (add
`--no-color`), piping the sites through it and emitting the output **verbatim
inside a fenced code block** — the Unicode box only aligns in monospace, so
STATUS renders are the one path that MUST be fenced:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
  | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-effective-status.js" \
      --policy "<POLICY>" --envId "<ENV_ID>" \
  | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-portal-table.js" --unicode --no-color
```

`get-effective-status.js` returns the `{ name, url, portalId, state }` array the
renderer consumes, with `state` already the effective boolean (`true` Enabled /
`false` Disabled) computed from the same parallel read — never hand-build the
JSON or recompute per-site state. **Governance STATUS is
ALWAYS the fixed-width Unicode box** (`┌─┬─┐ │ ├─┼─┤ └─┴─┘`, a rule between every
row), identical for every policy. It emits **exactly** the five columns
`# | Name | URL | Site ID | State` — never add, drop, reorder, or rename a
column (no parent columns, no Effective column, no paraphrase column). The
`--markdown` and legacy ASCII modes stay for other callers, but every STATUS
render (this post-Set verify, Fetch Env 4.3.1, Fetch Site 4.4.3) uses the
Unicode box.

**Final-delivery invariant.** The verification response itself MUST contain the
entire fenced stdout from `render-portal-table.js`, including the URL and Site
ID columns and every rendered site row. Do not replace it in the final answer
with a shorter hand-written table, omit columns, reorder rows, collapse rows,
use an ellipsis, or say that the full output appeared in tool output above.
Do not render a second compact table after it. A short headline or loop summary
may accompany the box, but the complete five-column box remains present
verbatim in the user-facing response.

**The State cell MUST show the status icon** — 🟢 for Enabled, 🔴 for Disabled.
The helper prepends these by default (pass `--no-icons` only if you explicitly
need them off). NEVER render a state table without the 🟢 / 🔴 icon.

Pick the headline + row set by scope:

- **`All` (env-wide enable)** — headline *"This Governance setting is 🟢 Enabled for these Sites:"*; list **all** sites in the env (from `list-portals.js`), every `state=true`.
- **`None` (env-wide disable)** — headline *"This Governance setting is 🔴 Disabled for these Sites:"*; list **all** sites in the env, every `state=false`.
- **`Include` / `Exclude`** — list only the sites the operation targeted; take each site's `state` from the `get-effective-status.js` output. Use the singular *"…for this Site:"* headline when exactly one site was targeted.

Env-wide (`None`) example — every site rendered via the helper as the Unicode
box (icons on), emitted **inside a fenced code block** so monospace preserves
the alignment:

This Governance setting is 🔴 Disabled for these Sites:

```
┌───┬──────────┬─────────────────────────────────────────┬──────────────────────────────────────┬─────────────┐
│ # │ Name     │ URL                                     │ Site ID                              │ State       │
├───┼──────────┼─────────────────────────────────────────┼──────────────────────────────────────┼─────────────┤
│ 1 │ Portal_1 │ https://site-3axiv.powerappsportals.com │ d1df518c-8e39-4bd5-8410-eb1c0c28e56c │ 🔴 Disabled │
├───┼──────────┼─────────────────────────────────────────┼──────────────────────────────────────┼─────────────┤
│ 2 │ Portal_2 │ https://site-37umu.powerappsportals.com │ bf8ead09-df94-488a-b78c-d4065899e1a4 │ 🔴 Disabled │
└───┴──────────┴─────────────────────────────────────────┴──────────────────────────────────────┴─────────────┘
```

Then give the one-line Phase 5 loop summary.

### 4.3 Check current state across an environment (`<OP>` = Fetch Env)

Fetch Env is driven entirely by the **single parallel batch** in Phase 4.3.1 —
`get-effective-status.js` reads the env-level value **and** the per-site
membership (and any gating parents) in one `Promise.all` wave. Do **NOT** make a
separate standalone `get-env.js` call first — that would be a redundant
sequential read. Derive the env-level plain-language summary from the same batch
result: all portals effectively 🟢 → "every site"; all 🔴 → "no sites"; a mix →
"some sites". (If you ever need the raw `All`/`None`/`Include`/`Exclude` value on
its own, it is available as `get-env.js` output, but the status flow never needs
a separate call.)

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

**When one request names multiple policies.** Treat that as a small batch of
independent Fetch Env reads against the same environment. Run this section once
per policy, in the user-mentioned order, and emit the full result for each
policy in sequence. Do **not** merge multiple policies into one compressed
"policy vs portal" summary; each policy still gets its own highlighted summary
and the full 5-column portal-details table from Phase 4.3.1.

#### 4.3.1 ALWAYS show the portal details table (every env value)

A bare summary leaves the user guessing which sites are affected. For **every**
env value (`All`, `None`, `Include`, `Exclude`), the orchestrator MUST also
fetch the env's full site list, compute each site's state, and render the
portal-details state table via **`render-portal-table.js`** (icons on) so the
user sees every portal's name, URL, Site ID, and 🟢/🔴 state.

Steps:

1. Fetch **everything in one parallel batch** with **`fetch-env-status.js`** —
   the single script that answers Fetch Env. It resolves the token once, then
   fires the env's **full site list** (`GET /websites`) **and** the env value +
   per-site membership for the policy **and every gating parent** all at once in
   one `Promise.all` wave, and classifies every portal's **effective** state
   locally:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/fetch-env-status.js" \
     --policy "<POLICY>" \
     --envId "<ENV_ID>"
   ```
   Total reads: `1 (websites) + policies × 2` — 3 for a leaf policy, 5 for a
   protocol, 7 for a social IdP — **all issued concurrently**. It returns
   `{ status, policy, envId, envValue, dependencies, apiCalls, portalCount,
   effectiveEnabledCount, headline, portals: [{ name, url, portalId, state, own,
   parents }] }` where `state` is the **effective** boolean (child own AND every
   gating parent) — exactly the shape `render-portal-table.js` consumes, and
   `headline` is the pre-computed Phase 4.3.1 headline.

   > **Never issue the reads yourself, and never issue them one after another.**
   > Do **NOT** call `list-portals.js`, `get-env.js`, `get-details.js`,
   > `get-portal.js`, or `get-effective-status.js` by hand (and never in a
   > per-policy or per-portal loop) to build this table — that re-creates the old
   > multi-step sequential flow this script exists to replace.
   > `fetch-env-status.js` is the **only** approved way to read the Fetch Env
   > status; a failed `get-details` inside it degrades to an empty list, and only
   > a failed site-list read or env read is fatal (surfaced as exit code 2 for
   > sign-in, 1 otherwise). An env with **zero sites** is not an error — it
   > returns an empty `portals` array; say so explicitly to the user.

2. Render the returned `portals` array through the helper in **`--unicode`**
   mode (add `--no-color`), emitting its output **verbatim inside a fenced code
   block** (the Unicode box needs monospace to align). Pipe the script straight
   into the renderer:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/fetch-env-status.js" \
     --policy "<POLICY>" --envId "<ENV_ID>" \
     | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-portal-table.js" --unicode --no-color
   ```
   The rendered box shows **exactly** the five columns `# | Name | URL | Site ID
   | State`, and the State cell MUST show the 🟢 / 🔴 icon (helper default).
   For a **gated child** this is still the same 5-column box — the `state` is the
   effective value, the parent chain is computed inside the script but **never**
   rendered as extra columns. Use the script's `headline` field verbatim (green
   when at least one site is effectively Enabled, red when off everywhere).

   If a policy-list id does NOT appear in the site list (e.g., the site was
   deleted after being added), still show it in the table with `(site not
   found)` for the name and an empty URL.

3. Finally, give the highlighted (bold + icon) one-line summary from Phase 4.3
   above. For a gated child you MAY explain in prose WHY a site is effectively
   off (using the script's `own` / `parents` fields, e.g. *"Facebook is on for
   Portal_2 but not active because External Auth is off there"*) — but the box
   itself always stays the five columns with the single effective `State`.

### 4.4 Check current state on one portal (`<OP>` = Fetch Portal)

After **4.1** runs, list every site in `<ENV_ID>` and let the user pick by **name** (preferred) or ID. Sites in this skill are referred to as "sites", not "portals", in user-facing prose.

#### 4.4.1 List sites and render the table

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>"
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
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
  | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/parse-portal-input.js" \
      --portalsStdin --input "<USER_REPLY>"
```

The reply must resolve to exactly one site. If the helper returns more than one (the user typed multiple), tell them this is a single-site read and ask again. If it returns zero or errors, surface the message and reprompt.

Persist as `<PORTAL_ID>` and `<PORTAL_NAME>` (for plain-language output).

#### 4.4.3 Run the read and render the result

Read the chosen site's state with the **same single parallel batch** used
everywhere else — build a one-site portals file (name / url / portalId for
`<PORTAL_ID>`) and run `get-effective-status.js` against it:

```bash
echo '{ "portals": [ { "portalId": "<PORTAL_ID>", "name": "<PORTAL_NAME>", "url": "<URL>" } ] }' \
  | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-effective-status.js" \
      --policy "<POLICY>" --envId "<ENV_ID>"
```

This fires the env value + membership list — **and, for a gated child, every
gating parent** — concurrently in one `Promise.all` wave, and returns the site's
effective `state`. Do **NOT** hand-issue `get-portal.js`, `get-env.js`, or
`get-details.js` (in any order). The script internally applies the same
site-state logic shown below (env value + inclusion/exclusion → Enabled /
Disabled), so this table is the **conceptual** reference for what `state` means,
not a set of calls to run yourself:

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

Then render the result as a one-line headline + **the Unicode box produced by
`render-portal-table.js --unicode --no-color`** (icons on) — **never** hand-build
it, and never multi-sentence prose. Pipe the `get-effective-status.js` output
straight through the helper (its `portals` array already carries the site's
`state`):

```bash
echo '{ "portals": [ { "portalId": "<PORTAL_ID>", "name": "<PORTAL_NAME>", "url": "<URL>" } ] }' \
  | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-effective-status.js" \
      --policy "<POLICY>" --envId "<ENV_ID>" \
  | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-portal-table.js" --unicode --no-color
```

`state` comes from the parallel batch — `true` Enabled / `false` Disabled (for a
gated child it is the effective value: own AND every parent). **The State cell
MUST show the icon** — 🟢 Enabled / 🔴 Disabled (the helper adds it by default).
Emit the helper output verbatim **inside a fenced code block** (the Unicode box
needs monospace to align).

> **Gated child policy?** When `<POLICY>` is one of the four protocols or three
> social IdPs (non-empty `availabilityDependsOn`), the site can show its own
> setting Enabled while the method is actually dark because a parent is off. Do
> NOT add columns for that — compute the **effective** state per **Phase 4.4.4**
> (own AND every gating parent) and put it in the single `State` column of the
> same 5-column Unicode box. Report that effective value as the site's status.

For **Enabled**:

This Governance setting is 🟢 Enabled for this Site:

```
┌───┬────────┬─────────────────────────────────────────┬──────────────────────────────────────┬────────────┐
│ # │ Name   │ URL                                     │ Site ID                              │ State      │
├───┼────────┼─────────────────────────────────────────┼──────────────────────────────────────┼────────────┤
│ 1 │ 8-june │ https://site-pjpuy.powerappsportals.com │ fe624c02-8793-4423-84f0-3546d80dee49 │ 🟢 Enabled │
└───┴────────┴─────────────────────────────────────────┴──────────────────────────────────────┴────────────┘
```

For **Disabled**:

This Governance setting is 🔴 Disabled for this Site:

```
┌───┬────────┬─────────────────────────────────────────┬──────────────────────────────────────┬─────────────┐
│ # │ Name   │ URL                                     │ Site ID                              │ State       │
├───┼────────┼─────────────────────────────────────────┼──────────────────────────────────────┼─────────────┤
│ 1 │ Site 1 │ https://site-dmq4c.powerappsportals.com │ 3e13d603-2607-43e0-90aa-d15bacaa8787 │ 🔴 Disabled │
└───┴────────┴─────────────────────────────────────────┴──────────────────────────────────────┴─────────────┘
```

Do not surface internal terms (`policyValue`, `InclusionList`, `ExclusionList`,
`Include`, `Exclude`) to the user. The single-table view is the source of
truth for whether the policy is on or off for that site.

#### 4.4.4 Effective status for gated child sign-in methods (single effective State column)

**When the policy being read is a *gated child*** — one that has a non-empty
`availabilityDependsOn` in `governance-mapping.json` (the four protocols
OAuth 2.0 / OpenID Connect / SAML 2.0 / WS-Federation, and the three social IdPs
Facebook / Google / Microsoft) — the site's OWN governance setting being Enabled
is **necessary but not sufficient**. The method only actually works on a portal
when **every gating parent is also Enabled** on that portal. So the status the
user cares about is the **effective** status = the child's own state **AND** all
its parents:

- **OAuth 2.0 / OpenID Connect / SAML 2.0 / WS-Federation** are effectively
  Enabled on a site only when that protocol **and External Auth** are Enabled.
- **Facebook / Google / Microsoft** are effectively Enabled on a site only when
  that provider **and OAuth 2.0 and External Auth** are all Enabled.

**Render it in the SAME 5-column Unicode box as every other status** — do NOT
add parent context columns and do NOT add an Effective column. Governance status
is always exactly `# | Name | URL | Site ID | State`; for a gated child the
single `State` cell carries the **effective** value (own AND all parents), and
the parent chain is used only to COMPUTE that value, never displayed. This holds
for the status-display paths — Fetch Env portal table in 4.3.1, Fetch Site in
4.4.3, and the post-Set verify table in 4.2.5.

**How to build it:**

1. Read the child's **own** state **and** every parent's state in **one
   parallel batch** with **`get-effective-status.js`** — never sequentially,
   never a per-policy or per-portal loop. Pipe `list-portals.js` directly into
   it; do not create a portal-list file:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
     | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-effective-status.js" \
         --policy "<POLICY>" --envId "<ENV_ID>"
   ```
   The script fires the env value + membership list for the child **and** for
   each gating parent (`EnableExternalAuthProviders`, plus
   `EnableProtocolOpenAuth` for the social IdPs) **all at once** in a single
   `Promise.all` wave — 4 reads for a protocol, 6 for a social IdP — turning the
   old 4–6 serial round-trips into one parallel wave (wall-clock ≈ a single
   round-trip). The parent list per policy is that policy's
   `availabilityDependsOn` (also mirrored in
   `effectiveStatusRules.parentColumnsByPolicy`); the script reads it from the
   mapping, so you never enumerate parents by hand. It returns
   `{ ..., portals: [{ name, url, portalId, state, own, parents }] }` where
   `state` is already the **effective** boolean (`own AND every parent`). A
   failed parent read degrades to Disabled/empty (fail-closed on the list);
   only a failed env read is fatal (exit 2 for sign-in, 1 otherwise). Do
   **NOT** call `get-env.js`, `get-details.js`, or `get-portal.js` yourself, and
   do **NOT** use the dummy-portalId trick (it 404s).

2. **The effective boolean is already computed** by the script as
   `effective = own AND (every parent state)` — a site whose own setting is
   Enabled but any gating parent is off comes back `state: false` (effectively
   Disabled). Use the returned `state` directly; the `own` / `parents` fields
   are available only to explain WHY in prose.

3. Render the returned `portals` array through
   **`render-portal-table.js --unicode --no-color`** (icons on) exactly like the
   non-gated paths — pipe the script straight into it. Emit the box **inside a
   fenced code block**. Do NOT use `render-status-table.js` for status display —
   the single-State Unicode box is the only status render.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
     | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-effective-status.js" \
         --policy "<POLICY>" --envId "<ENV_ID>" \
     | node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/render-portal-table.js" --unicode --no-color
   ```

4. Pick the **headline from the effective status**, not the child's own state:
   *"This Governance setting is 🟢 Enabled for these Sites:"* when at least one
   site is effectively Enabled. In the plain-language sentences around the box
   you MAY explain WHY a site is effectively off (e.g. *"Google is turned on for
   Portal_3 but is not active because OAuth 2.0 is off there"*) — but the box
   itself stays the five columns with the single effective `State`.

**Non-gated policies** (Maker Copilot, local login, and External Auth itself)
have no parents — their `availabilityDependsOn` is empty, so
`get-effective-status.js` fires just the child's env value + membership (2 reads,
still in parallel) and reports `state = own`. The exact same call and 5-column
Unicode box are used; the render is uniform across every policy.

### 4.5 Check the rollout status (`<OP>` = Fetch Status)

For when the user wants to verify that a recent Apply call actually landed,
or to confirm a rollout is still in flight.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-governance/scripts/get-status.js" \
  --envId "<ENV_ID>" \
  --policy "<POLICY>"
```

Endpoint hit (gateway transport):
`GET /powerpages/environments/<ENV_ID>/governance/status/<POLICY>`

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
do…"* prose with the examples.

> **Exception — pending child intent takes priority.** If the operation that
> just finished was a **parent enable** run to unblock a child (i.e.
> `<PENDING_CHILD_INTENT>` is set — Phase 4.2.1 Step B.2 / Phase 4.2.2b), do
> **NOT** fall through to this generic re-prompt. Instead follow **Step B.2**:
> re-run the availability resolver for the pending child and either offer the
> next `next` parent or auto-resume the original child operation, announcing the
> resume in one line. Only after the child is resumed (or the admin replies with
> a different request / `cancel`) do you return to this generic loop.

Do **NOT** present the old four-option menu
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
- **Explicit consent for Set** — never POST `/governance` without a Set-specific consent step: after the Impact Summary, present a **2-option `AskUserQuestion`** (choices **Apply now** / **Cancel** — exactly those two, no free-text prompt, no third option) that spells out which sign-in path / feature is being turned off and what happens to currently-signed-in users. Only a selected **Apply now** authorizes the POST.
- **Redundant-operation guard runs BEFORE the Impact Summary** — when the admin's requested operation is a no-op for the named site(s) (enable while the env is already `All`/`Include`-with-the-site, or disable while already `None`/`Exclude`-with-the-site), do **not** render the Impact Summary or POST yet. First stop and ask the standard **eligible-portal scope** free-text prompt (Phase 4.2.3 Step 1b): reply **All** to apply the requested verb to all eligible portals, or a **comma-separated list of portals** for specific sites. `All` → no API call (it is already in that state), report "no change" and loop. Specific portals → set `Include` (enable) / `Exclude` (disable) on the named site(s), THEN render the Impact Summary (surfacing the collateral flip on the other sites) and the normal `Apply now` consent gate.
- **Always verify after Set and deliver the complete result** — run the matching `get-*` call after the polling script exits, even when it reports success. Pipe the result through `render-portal-table.js --unicode --no-color`, then include that helper's entire five-column stdout verbatim in the final user-facing response. Never replace it with a shorter recap table, even when every row has the same state.
- **Parent-gated hard block (no override)** — a **child** auth policy can be **neither enabled nor disabled** on a portal whose required **parent** is Disabled: OpenID Connect / SAML 2.0 / WS-Federation / OAuth 2.0 are blocked wherever **External Auth** (`EnableExternalAuthProviders`) is off; Facebook / Google / Microsoft are blocked wherever **External Auth or OAuth 2.0** (`EnableProtocolOpenAuth`) is off. This applies **on every path**, including the **named-site fast path** (Phase 4.2.2b) where the site is named directly in the request — not only the scope picker's eligibility view (Phase 4.2.1 Step B.1). NEVER offer a "force-enable / force-disable anyway", "toggle the own setting regardless", or any similar bypass — the gate is absolute. If every named site is ineligible, do **not** render the Impact Summary or POST; name the Disabled parent and stop (offer to enable the parent first). If only some are ineligible, drop them (telling the admin why) and proceed with the eligible ones only. Fail-open only when a parent's live state can't be read.
- **Always show the env list** — for **every** new user request / operation
  (Apply, Fetch Env, Fetch Site — including each loop iteration and every new
  intent the user types), the orchestrator MUST render the **full** env-list
  table (via `render-env-table.js --markdown`, every row, as a rendered
  Markdown table) and let the user confirm `keep` or switch **before** running
  the site picker or any `get-*` / `set-*` call. Never silently reuse the
  previously-chosen env and skip the env list — the default env is only
  pre-flagged in the **Selected** column (the signed-in / tenant-default env on
  the first pick, or the previously-chosen env on later picks). The full table
  MUST be re-emitted inline in the SAME message that prompts the pick — NEVER
  back-reference an earlier message (e.g. *"(full list shown above)"*, *"(see
  table above)"*, *"as shown previously"*) and NEVER collapse it to just the
  flagged default row or `…` placeholder rows. Re-running the helper and pasting
  its entire output every time is mandatory; brevity is not a valid reason to
  shorten or reference-instead-of-render the list.
- **No auto-proceed on Set** — flagging a default env in the **Selected** column
  is allowed, but the pick is never applied automatically: the user must
  confirm explicitly by typing `keep` (to use the flagged env) or a row
  number / name / id (to switch). Never POST against a flagged env without that
  explicit confirmation. The portal pick is never defaulted.
- **Background polling** — run `set-governance.js` with `run_in_background: true`. Stream stderr to the user at most once every 30 seconds.
- **Policy strings are hard-coded** — only the twenty-one policies named in Phase 2.3 are valid (`EnableMakerCopilotForExistingSites`, `EnableProtocolOpenIdConnect`, `EnableProtocolSAML20`, `EnableProtocolWsFederation`, `EnableProtocolOpenAuth`, `EnableIdpOAuthFacebook`, `EnableIdpOAuthGoogle`, `EnableIdpOAuthMicrosoft`, `EnableAuthenticationLocalLogin`, `EnableExternalAuthProviders`, `PowerPages_AllowMakerCopilotsForNewSites`, `PowerPages_AllowMakerCopilotsForExistingSites`, `PowerPages_AllowProDevCopilotsForSites`, `PowerPages_AllowSiteCopilotForSites`, `PowerPages_AllowSearchSummaryCopilotForSites`, `PowerPages_AllowListSummaryCopilotForSites`, `PowerPages_AllowIntelligentFormsCopilotForSites`, `PowerPages_AllowSummarizationAPICopilotForSites`, `PowerPages_AllowProDevCopilotsForEnvironment`, `PowerPages_AllowNonProdPublicSites`, `PowerPages_DisableExtSvcCallsFromServerLogic`). This list is the frozen `SUPPORTED_POLICIES` array in `scripts/policies.js`. Reject any custom policy name with a clear "this skill only supports those twenty-one governance policies today" message.
- **Sign-in failures** — exit code `2` from any script means PAC or Azure CLI is signed out. Tell the user which command to run (`pac auth create` or `az login`) and stop.

## References

- **`references/governance-mapping.json`** — **single source of truth** for the uniform intent→policyValue table, per-policy display names + plain-English state paraphrases, side-effect callouts, scope picker labels, Effect-line templates, env-list rendering rules, and the consent-gate row requirements. The orchestrator MUST read mappings from this JSON rather than re-deriving them from the prose in this file. Updating a label here propagates to every render path (consent gate, verify table, loop summary, parser).
- `references/commands.md` — script flags, response shapes, assumed API contract, exit codes, polling semantics.
