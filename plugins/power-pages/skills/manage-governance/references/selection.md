# Intent and selection procedures

Required for SKILL.md Phases 2.1, 2.2, 4.1, and 4.2.2. Script paths below
are under `${PLUGIN_ROOT}/skills/manage-governance/scripts/`.

## Intent resolution

Parse the free-text request into these fields:

| Field | Values / meaning |
|-------|------------------|
| `intent` | `apply`, `fetchEnv`, or `fetchSite` |
| `policy`, `policyDisplayName` | Exact supported name and mapping-owned display name |
| `intentDirection` | `enable`, `disable`, or `view` |
| `envId`, `envDisplayName` | Chosen environment ID/name |
| `scope` | Canonical `All`, `None`, `Include`, `Exclude`, or unresolved |
| `siteIds`, `siteNames` | Resolved ID/name arrays |
| `confidence`, `ambiguities` | Confidence and unresolved interpretation questions |

Read `governance-mapping.json`: use each policy's `userShorthands`, `subject`,
and display metadata. "OpenID Connect"/"OIDC" and "SAML" select their protocol
toggles; do not use removed legacy authentication block rules. "Block" means
disable the governance setting, not an inversion based on its internal name.

Resolve direction plus scope through `intentToPolicyValue` and
`policyValueSemantics`, uniformly across policies. Scope qualifiers such as
"all sites", "across the environment", "live sites", or "running sites" mean
every site in that environment, not a lifecycle-state filter. Read
`ambiguousPhrasings`: ask users to restate "everywhere except X" as enable or
disable for X; do not auto-invert.

Ask only for missing/ambiguous policy, operation, direction, environment, scope, or site.
Reject unsupported policies explicitly and suggest mapping-owned examples.
An unknown environment/site is an error to surface and reprompt, not a reason
to pick a default silently. A clear initial intent avoids redundant questions
about those fields. A supplied environment must pass fresh validation below;
it does not bypass the visible site/scope exchange, eligibility, or consent.

## Environment picker

For every new request/operation, including each loop iteration, fetch the
complete fresh environment inventory:

```bash
node "${PLUGIN_ROOT}/skills/manage-governance/scripts/list-envs.js"
```

### Supplied environment name or ID

Resolve the supplied value against that fresh inventory before showing a
picker. Trim surrounding whitespace and compare IDs and display names
case-insensitively, using **exact matches only** for automatic resolution.

- **Exact environment ID:** accept only an ID present in the fresh inventory.
- **Unique exact environment name:** accept only when exactly one environment
  has that display name.
- **Duplicate exact names, conflicting name and ID, or only partial/fuzzy
  matches:** explain the ambiguity and ask the user to choose explicitly.
  Never auto-select a fuzzy match or prefer one conflicting identifier.
- **Unknown name or ID:** report that it was not found in the accessible
  environment inventory, then ask for a valid selection. Never silently fall
  back to PAC's environment, the recent environment, or a default.

For a single unambiguous exact match, say "Using <display name> (<envId>)"
in the assistant message, persist the resolved values, and continue directly
to site/scope selection. **Do not show the environment picker or ask the user
to select or confirm the same environment again.** This applies to Apply,
Fetch Env, Fetch Site, and explicit targets supplied in loop requests.
An explicitly resolved environment is not consent to a governance write;
the impact summary and **Apply now / Cancel** gate remain mandatory.

### Missing or unresolved environment

If no environment was supplied, or resolution above requires user input,
pass the fresh inventory JSON to `render-env-table.js` via stdin with
`--markdown [--current "<RECENT_ENV_ID>"]`. Do not fetch the list again just
to render it; reuse only this operation's fresh result, never a prior request's
inventory.

Emit the **complete fresh output verbatim as an unfenced Markdown table**,
with every row, in an **assistant message before the selection form**. Never filter
environments by policy eligibility, truncate them, collapse to a default row,
insert ellipses, or refer back to a previous table. If the user cannot see it,
re-run and re-display it. Do not use `--envsFile`, an earlier response, an
in-memory cache, a TTL, or `governance-envs.json`.

With no recent environment, omit `--current`; the renderer flags `type: Default`
without another PAC call. Otherwise flag the recent ID. The flag is only a
suggestion: require explicit `keep`, row number, environment name, or ID.
Never auto-proceed on an empty reply or say "press Enter".

After displaying the table, use the question tool with a short plain-text
message: "Reply 'keep' to continue with <flagged name>, or a row number,
environment name, or ID to switch. Reply 'cancel' to stop." Collect a free-text
environment value, not an option menu. Do not put the environment table in
the form's message, question, or field/option descriptions.
Resolve the reply against this fresh list using the same exact-match rules,
or its displayed row number; clarify ambiguous/partial/fuzzy matches rather
than guessing. `keep` explicitly selects the flagged environment.
Cancel makes no governance change.

### Continue with the resolved environment

Persist `<ENV_ID>`, `<ENV_DISPLAY>`, and `<RECENT_ENV>` after an exact supplied
match or a valid picker reply.
Immediately show the site picker below, then take the scope/site reply before
any Apply summary or status operation. This applies to Apply, Fetch Env,
and Fetch Site; do not skip it because the environment or sites were named
in the original request.

## Site picker and parser

Fetch sites for the chosen environment:

```bash
node "${PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>"
```

Show a table containing site name, URL, and site ID; retain row numbers for
selection. For a **plain picker**, show all sites when there are at most 10.
Above 10, use `orderPortalsForDisplay()` from `list-portals.js`: Production
first, then `StateConfigured`, then oldest `createdOn`. Say "Showing 10 of
<total> - type any site name or ID (including ones not listed), or 'all'."
The parser always validates against the **full** list, never only visible rows.
This cap applies neither to environments nor to final status output.

Emit Markdown tables in an **assistant message**, unfenced with a blank line
before and after them. Preserve each complete row on one physical line,
including long URLs and IDs; do not manually wrap cells or paste a table as
quoted/code-formatted text. The same display rule applies to the eligibility
view below. Tool output alone does not display the table to the user.

For a **child-policy Apply**, replace the plain table with the resolver's
eligibility view from [apply.md](apply.md#eligibility-hard-gate): all sites,
eligible first, blocked sites immediately below with reasons. Do not apply
the plain-picker 10-row cap to that view. Reads do not filter sites by
eligibility; an effectively disabled site is still a status result.

After displaying the table, use the question tool with a short plain-text
message requesting `all` for every eligible site or comma-separated names/IDs
for specific sites, plus `cancel`. Collect a free-text scope value, not an
option menu. Do not put the site/eligibility table or eligibility explanation
in the form's message, question, or field/option descriptions. Send the table
and any eligibility explanation before calling the tool in the same turn.
Use the known
enable/disable verb for Apply; map the reply with the JSON intent rules.
Fetch Env uses `all`; a request to read one named site routes to Fetch Site.
Fetch Site must resolve exactly one site, not `all` or multiple sites.

If there are zero sites, say so explicitly and skip the empty picker table.
For Apply, ask: "This environment has no sites. Enter all for environment-wide
site selection, or cancel." Accept only `all` as the site-selection value;
do not offer specific names/IDs, exclusions, or `none`. Do not silently choose
`all`. Use the existing enable/disable intent mapping for the policy value:
the user's `all` selects the environment-wide scope, not the action direction.
Continue through the normal impact summary and explicit Apply now / Cancel
approval; an empty inventory does not authorize a POST. Fetch Site stops, and
Fetch Env may still report its empty environment result (zero sites is not an
API failure).

Resolve site input with:

```bash
node "${PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
  | node "${PLUGIN_ROOT}/skills/manage-governance/scripts/parse-portal-input.js" \
      --portalsStdin --input "<USER_INPUT>"
```

The output has `policyValue`, `portalIds`, `resolvedNames`, and `errors`.
When scope is already resolved, ignore the parser's `policyValue`; use only
IDs/names. Surface every error and reprompt.

When a name is ambiguous, display every matching site's name, URL, and site ID
from the full inventory in an assistant message, then ask for the exact site
ID or cancel using a short plain-text form. Never choose the first or last
match automatically. Resolve the reply through the same parser and do not
retain a partial selection from the failed input.

Persist `<PORTAL_IDS>` and
`<PORTAL_NAMES_LIST>` for Apply, or `<PORTAL_ID>` / `<PORTAL_NAME>` for Fetch
Site. Use `/websites` IDs throughout, never Dataverse record IDs.
