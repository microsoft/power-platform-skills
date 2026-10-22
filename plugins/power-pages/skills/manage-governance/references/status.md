# Read, verification, and output procedures

Required for SKILL.md Phases 4.2.5, 4.3, 4.4, and 4.5.
Script flags, response fields, and error codes are defined in `commands.md`.

## Effective-state and output contract

Use helper-computed `state` directly. For a gated policy it is **own AND every
gating parent**; for an independent policy it equals own state. Dependencies
come from the mapping, not a hand-maintained policy list. Parent `own`/`parents`
fields can explain a disabled state in prose, never additional table columns.

Effective-status reads fail closed for unread parents; details failures degrade
to empty membership. A failed required environment read is fatal; Fetch Env
also treats a failed site-list read as fatal. Surface failures/uncertainty
explicitly, and stop for sign-in errors (exit `2`). Do not substitute a
success-shaped result. Zero sites is not a failed API call.

A 404 specifically from `GET /governance/{policy}` is the documented
unconfigured-policy state, not an unread-parent failure. The shared transport
marks it `settingPresent: false` and classifies its scope as `None` (Disabled).
For `get-env.js`, display its "No governance setting on record" message.
For batched reads, disclose every entry in `unconfiguredPolicies` in prose
before the table, including missing parent settings. Do not describe these
as explicitly configured `None` policies. Other 404s remain errors.

Every Fetch Env, Fetch Site, and post-Apply status result uses:

```bash
... | node "${PLUGIN_ROOT}/skills/manage-governance/scripts/render-portal-table.js" --markdown --no-color
```

Emit **all stdout verbatim as an unfenced Markdown table**, in the delivered
response itself, not merely tool output. Leave a blank line before and after
the table. Keep each row on one physical line: do not insert hard line breaks
into URLs, IDs, or state cells to fit a terminal width. Exactly five columns:
`# | Name | URL | Site ID | State`. Keep icons on (Enabled/Disabled markers).
Never truncate rows, reorder/rename/drop/add columns, add parent/Effective
columns or paraphrases inside cells, insert ellipses, hand-build a recap,
switch to a Unicode/ASCII box or ANSI rendering, or use `render-status-table.js` instead.
Brevity preferences never override full delivery.

If requesting follow-up input, display the status table in an assistant
message before calling the question tool. Never embed the table in the
form's message, question, or field/option descriptions; those can show
Markdown literally rather than render it.

Use mapping-owned state paraphrases and scope labels only in surrounding prose.
The fixed helper output takes precedence over legacy alternative examples.

For multiple requested policies, run the appropriate read once **per policy in
user order** and emit each policy's complete independent result. Never replace
them with a condensed cross-policy matrix.

## Fetch Env

After the shared environment/site selection, use `fetch-env-status.js` as the
**single batched reader**:

```bash
node "${PLUGIN_ROOT}/skills/manage-governance/scripts/fetch-env-status.js" \
  --policy "<POLICY>" --envId "<ENV_ID>" \
  | node "${PLUGIN_ROOT}/skills/manage-governance/scripts/render-portal-table.js" --markdown --no-color
```

It fetches the site list and environment/membership for the policy and its
parents concurrently with shared context. Do not substitute a sequential
`list-portals.js | get-effective-status.js` status read or preliminary
standalone `get-env.js`/`get-details.js`/`get-portal.js` calls.
The earlier picker does not replace this fresh batched status read.

Use returned `headline` and `effectiveEnabledCount` for the effective status
headline (enabled when at least one site is effectively enabled). Render every
returned site, even if blocked for Apply. Add a **bold, icon-led** plain-language
environment summary from the same result's `envValue` and mapping-owned scope
labels; distinguish the policy's own scope from effective state.
If zero sites, say so and still report the environment result. Preserve helper
placeholders for unresolved membership sites, including missing name/URL.

## Fetch Site

Resolve exactly one site through the shared picker. Pipe one-site JSON
directly into the batch, without a temporary site-list file:

```bash
echo '{ "portals": [ { "portalId": "<PORTAL_ID>", "name": "<PORTAL_NAME>", "url": "<URL>" } ] }' \
  | node "${PLUGIN_ROOT}/skills/manage-governance/scripts/get-effective-status.js" \
      --policy "<POLICY>" --envId "<ENV_ID>" \
  | node "${PLUGIN_ROOT}/skills/manage-governance/scripts/render-portal-table.js" --markdown --no-color
```

The batch reads environment/membership and parents concurrently. Do not call
`get-portal.js` separately or use a dummy ID. Use the effective state for a
one-line "This governance setting is Enabled/Disabled for this site" headline,
then the complete unfenced Markdown status table.

## Post-Apply verification

Wait for `set-governance.js` terminal completion before reading (mid-rollout
membership can be stale). Poll success alone is insufficient: re-read the
same scope once with `get-effective-status.js`:

```bash
node "${PLUGIN_ROOT}/skills/manage-governance/scripts/list-portals.js" --envId "<ENV_ID>" \
  | node "${PLUGIN_ROOT}/skills/manage-governance/scripts/get-effective-status.js" \
      --policy "<POLICY>" --envId "<ENV_ID>"
```

Compare the intended environment scope/membership and every targeted site's
expected state with the batch result, including removals and collateral
changes disclosed at consent. Never hand-sequence per-site/policy `get-*` calls.
Render through the canonical helper: all environment sites for `All`/`None`,
or the operation's targeted sites for `Include`/`Exclude`, with the actual
returned states (not fabricated expected values).

A mismatch is not verified success: report "The operation was sent, but the
environment still reports the previous value. Re-check shortly." Surface read
errors rather than claiming verification. Do not automatically retry the POST.
Only a successful, verified prerequisite-parent enable triggers child resume.
Report helper failures/timeouts as such, not as a successful rollout.

## Internal rollout status

Use `get-status.js --envId "<ENV_ID>" --policy "<POLICY>"` only as an internal
last-rollout snapshot. Classification comes from `scripts/policies.js` and
`commands.md`; do not maintain another inline terminal-state table.
Explain whether the last rollout finished, failed, or is still in flight
according to that shared contract. A last-rollout snapshot does **not** prove
that the current request landed; use post-Apply verification for that.
