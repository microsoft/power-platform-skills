# Apply procedures

Required for every SKILL.md Phase 4.2 operation, including prerequisite
parent changes. Read [selection.md](selection.md) and [status.md](status.md)
for shared selection, batched reads, and final output. The approval decision
itself stays at SKILL.md Phase 4.2.3; do not ask a second consent question here.

## Eligibility hard gate

Read the requested policy's `availabilityDependsOn` from
`governance-mapping.json`. A policy without dependencies needs no availability
filter; every site is eligible. Do not maintain a second dependency table.
OAuth is both a child of External Auth and a parent of social providers;
it is **not** a root-policy exception.

When dependencies exist, run:

```bash
node "${PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
  | node "${PLUGIN_ROOT}/skills/manage-governance/scripts/resolve-portal-availability.js" \
      --policy "<POLICY>" --envId "<ENV_ID>" --markdown
```

Emit the helper's table verbatim: **every** site, explicit `Eligible` Yes/No,
eligible first and blocked sites immediately below naming the blocking parent.
Never use `--available-only` for the picker. Only eligible sites may be selected.
A child can be **neither enabled nor disabled** where a parent is Disabled;
there is **no force/anyway override**.

The resolver fails open for unread parents: note the uncertainty explicitly,
but do not invent a block. This differs from effective status reads, which
fail closed for an unread parent. See `commands.md` for the resolver's JSON
fields and read/error behavior.

An unread Include/Exclude membership list is not a successful empty list.
The resolver preserves the known parent scope, records `membershipReadErrors`
and per-site `unreadParents`, and marks affected eligibility as unverified.
Display the helper's warning before selection and repeat the uncertainty
before final consent, including on the named-site path. Do not claim these
parents are Enabled or Disabled or offer remediation based on an unread list.
Known disabled parents still block; membership HTTP 401/403 or context errors
stop the operation instead of failing open.

If the environment has zero sites, follow the all-only site-selection prompt
in `selection.md`; an empty inventory is not a list of blocked sites. Preserve
the requested enable/disable direction and the normal impact/consent gates.

If the inventory is nonempty but no site is eligible, surface the helper's disabled-parent message instead
of an all-No table, do not prompt for scope, do not render an impact summary,
and do not POST. Follow the parent-remediation procedure below.

### Named-site path (Phase 4.2.2b)

The same gate applies when sites were named in the original request. Pipe
resolved site JSON directly to the resolver (default JSON mode, no temporary
site-list file):

```bash
echo '{ "portals": [ { "portalId": "<id>", "name": "<name>", "url": "<url>" } ] }' \
  | node "${PLUGIN_ROOT}/skills/manage-governance/scripts/resolve-portal-availability.js" \
      --policy "<POLICY>" --envId "<ENV_ID>"
```

Use `available` and `unavailable` to partition the named sites. If some are
blocked, remove them from the resolved IDs/names and explain each removal,
naming its blocking parent; proceed only with eligible sites. If all are
blocked, no summary or POST: save the original intent and offer remediation.
If all are available, proceed unchanged. Neither direct naming nor switching
enable/disable direction bypasses eligibility.

## Parent remediation and auto-resume

Read the resolver's JSON `remediationChain` (Disabled parents, root-first)
and `next` (`remediationChain[0]`). Offer **only `next.subject`** as an enable
action, in a free-text prompt, or cancel/different request. Never offer a flat
"External Auth OR OAuth" choice, a deeper parent as a co-equal action, or an
extra parent-diagnostics menu.

Before pausing, save `<PENDING_CHILD_INTENT>` with the original policy,
direction, environment, scope, site IDs/names. Tell the admin the original
child request will resume after the prerequisite is enabled.

If the admin replies with the offered enable command:

1. Run that parent as a normal Apply, with fresh environment validation under
   the selection procedure (no redundant picker for an exact supplied target), its own
   eligibility checks, impact summary, and separately selected **Apply now**.
   Never enable any parent silently using the child's request or approval.
2. After the parent completes **and verification succeeds**, re-run the
   availability resolver for the pending child in the same environment.
3. If another parent is still blocked, offer only the new `next` and retain the
   pending intent. If eligible, announce resumption in one line and continue
   the original child at its eligibility/scope step (or the summary preparation
   when scope/sites are already resolved). Recheck named sites as well; do not
   assume the parent rollout made every requested site eligible.
4. Clear pending intent when resuming the child. The child still needs its own
   impact summary and consent. Do not fall into the generic loop and forget it.

If the parent fails, times out, or verification mismatches, report it and do
not resume as if successful. A different request or cancel discards pending
intent. Auto-resume is an offer, not a lock-in.

## Impact preparation

### Batched current-state read

Before any summary, read the current effective states with **one** batch:

```bash
node "${PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
  | node "${PLUGIN_ROOT}/skills/manage-governance/scripts/get-effective-status.js" \
      --policy "<POLICY>" --envId "<ENV_ID>"
```

Do not loop per site or manually sequence `get-env.js`, `get-details.js`, or
`get-portal.js`. Use returned effective `state` for each affected site.
If a live state cannot be read, pass `currentState: "Unknown"` and disclose
that uncertainty in a footnote; a current-state read error alone does not
block consent. Sign-in failures still stop the skill.

### Redundant-operation guard

Before the Impact Summary, if every named site is already in the requested
state (enable under `All`/existing `Include`, or disable under `None`/existing
`Exclude`), do not silently POST. Ask in **free text**, not an option menu:

> "The setting is already <enabled/disabled> on the eligible sites. Reply
> **All** for no change, a comma-separated list of sites to <enable/disable>
> only those, or **cancel**."

`All` reports no change, skips consent/POST, and returns to the loop.
Cancel also makes no change. A specific list re-scopes to `Include` (enable)
or `Exclude` (disable), then proceeds to impact preparation and consent.

**Disclose collateral changes before approval.** Narrowing `All` to `Include`
turns unlisted sites off; changing `None` to `Exclude` turns unlisted sites on.
List those out-of-scope sites and their Current → New states alongside the
helper-rendered summary. Never imply that only the named sites can change.

### Membership deltas

`ToBeAdded` is additive, not replacement membership. A shorter Include/Exclude
list does not remove existing members. When narrowing/shrinking an existing
list, compare current membership from the batched read, explicitly pass removed
IDs through `--removePortalIds` (`ToBeRemoved`), and disclose those removals
before approval. Never claim replacement semantics from `ToBeAdded` alone.

### Deterministic summary

Pipe the resolved request to the renderer:

```bash
echo '{
  "policy": "<POLICY>",
  "direction": "<enable|disable>",
  "scope": "<all|specific>",
  "policyValue": "<POLICY_VALUE>",
  "env": { "displayName": "<ENV_DISPLAY>", "envId": "<ENV_ID>" },
  "sites": [ { "name": "<name>", "url": "<url>", "portalId": "<id>", "currentState": "Enabled|Disabled|Unknown" } ]
}' | node "${PLUGIN_ROOT}/skills/manage-governance/scripts/render-impact-summary.js"
```

Use `scope: all` for `All`/`None`, with every environment site, or `specific`
for `Include`/`Exclude`, with the selected sites. Use real values, not the
placeholder alternatives shown above.

The helper owns Action, Environment, Scope, the unfenced Markdown site table
(name, URL, ID, Current/New State and CHANGED markers), Effect, Policy value
and `ToBeAdded`, side effects, state icons, and nested cascades. Read its data
from the mapping rather than copying policy-specific text into this procedure.
Disabling authentication can sign out existing users; preserve that warning.
Enable cascades describe availability, not forced child enablement.

Emit its full output verbatim in an **assistant message**, starting at
`**Action:**`, without a preamble or code fence. Preserve paragraph/table/list
blank lines. Each site must stay on one physical Markdown row; visual wrapping
is fine, hard line breaks within a row are not.
Do not invent a cascade, explain its absence, or replace the Markdown impact
table with a text box. Additional collateral-state/removal disclosures go
after the helper output and before consent, without editing the helper output.
Display that assistant message before calling the approval tool in the same
turn. Do not put the summary or its disclosures in the form's message,
question, or field/option descriptions: the approval form can display
Markdown literally rather than render a table. Tool output alone is not a
user-facing summary. Return to SKILL.md Phase 4.2.3 for the single approval
decision, with only "Proceed with this change?" in the form and **Apply now**
/ **Cancel** options. Do not add a separate acknowledgement prompt.

## Submit and watch

Only after selected **Apply now** at Phase 4.2.3:

```bash
node "${PLUGIN_ROOT}/skills/manage-governance/scripts/set-governance.js" \
  --envId "<ENV_ID>" --policy "<POLICY>" --policyValue "<POLICY_VALUE>" \
  [--portalIds "<PORTAL_IDS>"] [--removePortalIds "<REMOVED_PORTAL_IDS>"]
```

For `All`/`None`, omit site-list flags. For selected-site scopes, `--portalIds`
accepts comma/whitespace-separated IDs; singular `--portalId` is legacy only.

Run in the background and relay stderr progress at most once every 30 seconds.
The helper POSTs `/governance` and polls the environment-scoped
`/governance/status/{policy}`; default timeout is 15 minutes. Terminal
classification and exit codes live in `scripts/policies.js` and `commands.md`,
not a separate status table here. Surface errors and timeouts explicitly.
Wait for completion, then perform [post-Apply verification](status.md#post-apply-verification).
