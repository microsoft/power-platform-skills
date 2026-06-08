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

## 2. Pick a policy

Use `AskUserQuestion` to let the user pick. The user-facing label is the
**Policy Display Name** and the `description` is the **Display Summary**.
Keep the internal `PolicyName` string out of both — stash it internally and
persist as `<POLICY>` after the user picks.

| Policy Display Name | Display Summary (description on the question) | Internal `PolicyName` |
|---------------------|-----------------------------------------------|-----------------------|
| Enable Maker Copilot for Existing site | Controls whether makers can use the maker copilot on existing Power Pages sites. | `PowerPages_AllowMakerCopilotsForExistingSites` |
| Disable the OpenId Connect Protocol | Disabling the OpenIdConnect protocol will prevent users from logging in using an OpenId Connect configured Identity Provider. | `PowerPages_DisableAuthenticationOpenIdConnect` |
| Disable the SAML_2.0 Protocol | Disabling the SAML 2.0 protocol will prevent users from logging in using a SAML configured Identity Provider. | `PowerPages_DisableAuthenticationSAML20` |

Persist the chosen `PolicyName` as `<POLICY>` and the display name as
`<POLICY_DISPLAY_NAME>` for use in user-facing summaries throughout the rest
of the run.

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

Output is `{ status: "ok", envs: [ { envId, displayName, envUrl, type, region } ] }`. Present the list via `AskUserQuestion` (one option per env, up to 4 — if more than 4, group by region or first letter and ask the user to narrow before the picker; or fall back to a free-text prompt and validate against the list). Persist the choice as `<ENV_ID>` and `<ENV_DISPLAY>`.

### 4.2 Apply the policy (`<OP>` = Set)

#### 4.2.1 Pick the scope (4 plain-language options)

Use `AskUserQuestion` with exactly four options. The labels and descriptions
shown to the user MUST be the plain-language variants in the "User-facing label"
column; map them to the internal `policyValue` strings on the right purely for
the API call.

`Include` and `Exclude` are **internal-only** terms — they must never appear in
any `AskUserQuestion` label, description, or summary the user reads.

| User-facing label | Internal `policyValue` | Trigger portal picker? |
|-------------------|------------------------|------------------------|
| **All Sites in this environment** | `All` | No |
| **None of Sites of this environment** | `None` | No |
| **Specific Sites in this environment** | `Include` | Yes |
| **All Sites except specific sites** | `Exclude` | Yes |

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

- When `<POLICY_VALUE>` is `Include`: *"Reply with a comma-separated list of the site names or IDs you want to apply the policy to."*
- When `<POLICY_VALUE>` is `Exclude`: *"Reply with a comma-separated list of the site names or IDs you want to leave OUT of the policy."*

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

For Disable policies, also call out the user-facing consequence:
- For OIDC: *"Any users currently signed in via OpenID Connect will be signed out and won't be able to sign back in via this method."*
- For SAML: *"Any users currently signed in via SAML will be signed out and won't be able to sign back in via this method."*

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
| Enable Maker Copilot for Existing site | "maker-copilot" |
| Disable the OpenId Connect Protocol | "OpenID Connect disable" |
| Disable the SAML_2.0 Protocol | "SAML 2.0 disable" |

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
- **Policy strings are hard-coded** — only the two strings above are valid. Reject any custom policy name with a clear "this skill only supports the two PowerPages_DisableAuthentication* policies today" message.
- **Sign-in failures** — exit code `2` from any script means PAC or Azure CLI is signed out. Tell the user which command to run (`pac auth create` or `az login`) and stop.

## References

- `references/commands.md` — script flags, response shapes, assumed API contract, exit codes, polling semantics.
