---
name: edit-offline-profile
description: Internal mobile-app workflow read and executed only by mobile orchestrators to change one table's scope, columns, or sync settings in a Mobile Offline Profile.
user-invocable: false
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**References:**

- [dataverse-offline-api.md](${PLUGIN_ROOT}/shared/references/dataverse-offline-api.md) §4 / §7 — POST item + PATCH selectedcolumns
- [offline-profile-reconciliation.md](${PLUGIN_ROOT}/shared/references/offline-profile-reconciliation.md) — refreshing the `schemaColumns` baseline after a column edit

# Edit Offline Profile

Re-run a single piece of an existing profile — change one table's row scope, update the column list, adjust sync frequency, or rename the profile. Avoids the cognitive cost of walking the full /setup-offline-profile wizard for a one-line change.

Scope: existing profile (read from `<working_dir>/offline-profile.json` or
`--profile-id`); edits at the table-item granularity. To ADD a new table return to
the owner for `/add-table-to-offline-profile`; deleting an entire profile is
outside this helper's scope, not an automatic recovery.

## Invocation context and root binding

This internal helper is always a **child invocation**. Before any project read or
command, execute [app-working-directory.md](${PLUGIN_ROOT}/shared/references/app-working-directory.md).
Require the owner's absolute `working_dir`; `--working-dir`, when supplied, must
identify that same native-canonical root. Missing, relative, or conflicting root
context returns `NEEDS_CONTEXT` before project access; an inaccessible directory
is `BLOCKED`. Never use the launch cwd or introduce another root resolver.

Receive `MOBILE_APP_ORCHESTRATING=1`, `orchestrator`, `working_dir`, `phase`,
`approved_scope`, and supplied answers from the owner. Preserve the selected
environment ID/URL/tenant, profile ID, table allowlist, item IDs, and exact
scope/column/sync/name/description changes. Missing or conflicting scope returns
`NEEDS_CONTEXT`, not another environment/profile/table selection. The marker is
not approval: schema approval alone does not authorize profile edits, publication,
deletion, or membership edits. Retain Step 3's single confirm unless supplied
answers already approve that same current offline change.
For `--plan-only` or a planning-phase handoff, return the current/proposed diff
after read-only discovery and STOP before Apply, PATCH, publication, or artifact
writes. A gate response cannot lift proposal-only mode.

Apply the canonical contract to **every shell call and file tool**, including
version/auth checks, manifest/screen reads, commands copied from references,
verification, recovery, and retries. Re-supply the absolute `PLUGIN_ROOT` and
required context on each call; no prior `cd`, export, or shell variable persists.
Use the canonical Bash guard below or its PowerShell equivalent. Replace
placeholders with validated, shell-quoted invocation values; missing values
return `NEEDS_CONTEXT`, never execute an unresolved placeholder.
File tools use absolute `<working_dir>/...` paths; plugin reads/scripts use
`${PLUGIN_ROOT}/...`. Never search another app when a file is absent.

## Workflow

1. Verify project + locate profile → 2. Resolve target (which table / what to change) → 3. Show current vs proposed → Single confirm → 4. PATCH → 5. Publish → 6. Update artifacts → 7. Summary

---

### Step 1 — Verify project + locate profile

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
if [ ! -f power.config.json ] || [ ! -f app.config.js ]; then
  echo "BLOCKED: working_dir is not an initialized app" >&2
  exit 1
fi
```

Read `<working_dir>/power.config.json` and require a nonempty `environmentId`
matching the owner's selected environment. Reuse matching complete environment
context, or perform this non-persisting lookup from the bound root:

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
environment_id=$(node -p "require('./power.config.json').environmentId || ''") || {
  echo "BLOCKED: unreadable power.config.json" >&2; exit 1;
}
if [ -z "$environment_id" ] || [ "$environment_id" != "<selected-environment-id>" ]; then
  echo "NEEDS_CONTEXT: selected environment does not match working_dir" >&2
  exit 1
fi
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$environment_id" --no-cache --require-tenant
```

Require the returned environment ID, HTTPS URL, and tenant to match the owner;
incomplete or conflicting context returns `NEEDS_CONTEXT`. Never drop
`--no-cache --require-tenant`, change configuration, or switch auth/environment
to recover a failure. Use that exact `<envUrl>` and `<tenantId>` for every request.

Profile ID resolution (same priority as `/assign-offline-profile` Step 1):

| Source | Used when |
|---|---|
| `$ARGUMENTS` `--profile-id <guid>` | Explicit selection matching the owner's profile context |
| `<working_dir>/offline-profile.json` top-level `profileId` | Default for `/setup-offline-profile`-created projects, matching the owner's profile context |
| Otherwise | Return `NEEDS_CONTEXT` to the owner to select the intended profile; never pick another profile silently |

STOP if no profile found: "Run `/setup-offline-profile` first."

Verify the selected live profile belongs to the selected environment. A conflicting
snapshot/argument returns `NEEDS_CONTEXT`; a 404 or permission failure is
`BLOCKED`, not permission to discover a substitute. Resolve each `<itemId>` only
within this profile and verify its table matches the exact requested logical name.

> **`<working_dir>/power.config.json` is intentionally NOT consulted for the profile ID.**
> That file is owned by `npx power-apps init`. The local profile ID lives in
> `<working_dir>/offline-profile.json` only.

### Step 2 — Resolve target (what to edit)

Parse `$ARGUMENTS`:

| Flag pattern | Effect |
|---|---|
| `--rename <new-name>` | Update profile `name` |
| `--describe <text>` | Update profile `description` |
| `--table <logical-name> --scope <0\|1\|2>` | Change one table's `recorddistributioncriteria`. Combine with `--me`, `--team`, `--bu` to set sub-flags when scope=2. |
| `--table <logical-name> --sync <minutes>` | Change one table's `syncintervalinminutes` (range 5–1440) |
| `--table <logical-name> --columns add:col1,col2 remove:col3` | Add or remove logical names from `selectedcolumns`. Comma-separated, both add/remove optional. |
| `--table <logical-name> --columns reset` | Replace selectedcolumns with union of always-include + manifest lookups + screen-grep'd (re-runs the architect's Step 6 union for this table) |

If no flags → interactive picker. `AskUserQuestion` with up-to-4 most likely edits:
- "Rename profile"
- "Change a table's scope" → next message asks which table
- "Change a table's sync frequency" → next message asks which table + value
- "Edit a table's column list" → next message asks which table + add/remove

Restrict the picker and explicit flags to the owner's exact current scope.
`--columns reset` reads the selected table from
`<working_dir>/.datamodel-manifest.json` or
`<working_dir>/docs/plan-artifacts/.datamodel-manifest.json` and greps only
absolute `<working_dir>/app/` and `<working_dir>/src/` paths. Keep the chosen
absolute manifest path for the whole invocation; no other-app fallback.
Changing the table, profile, or operation requires returning `NEEDS_CONTEXT`
to the owner, not expanding an existing approval.

### Step 3 — Show current vs proposed (single gate)

GET the current item state from Dataverse for any tables being edited:

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" GET \
  "mobileofflineprofileitems(<itemId>)?\$select=name,recorddistributioncriteria,recordsownedbyme,recordsownedbymyteam,recordsownedbymybusinessunit,syncintervalinminutes,selectedcolumns" \
  --tenant-id "<tenantId>"
```

Render a current/proposed diff:

```
Profile  : <name> (<id>)
Editing  : <table-logical-name> item

                Current     →    Proposed
Scope         : Org+me     →    All records
Sync (min)    : 10         →    30
Columns       : 14         →    16  (add: chnl_notes, chnl_actual_visit_date)
```

`AskUserQuestion`: "Apply this change? [Apply / Cancel]"

If `Apply` → continue. If `Cancel` → STOP.

### Step 4 — PATCH

Build the PATCH body with only the fields that changed:

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" PATCH \
  "mobileofflineprofileitems(<itemId>)" --tenant-id "<tenantId>" \
  --body '{
    "recorddistributioncriteria": <new>,
    "recordsownedbyme": <new-bool>,
    "syncintervalinminutes": <new>,
    "selectedcolumns": "{\"Columns\":[...]}"
  }'
```

For profile-level edits (name / description):

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" PATCH \
  "mobileofflineprofiles(<profileId>)" --tenant-id "<tenantId>" \
  --body '{"name": "...", "description": "..."}'
```

Check returned HTTP statuses as well as process exit. A
403/`PrivilegeCheckFailed` is `BLOCKED`; do not change identity or profile to
bypass permissions. Preserve every field and table outside the approved delta.

### Step 5 — Publish

Use the **targeted `PublishXml`** recipe from [shared/references/dataverse-offline-api.md §9](${PLUGIN_ROOT}/shared/references/dataverse-offline-api.md):

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" POST \
  "PublishXml" --tenant-id "<tenantId>" --body '{
    "ParameterXml": "<publish><mobileofflineprofiles><mobileofflineprofile><profileId></mobileofflineprofile></mobileofflineprofiles></publish>"
  }'
```

Publishes only this profile, not the entire org's customizations. Avoids the 429 rate-limit storms on shared envs that the legacy `PublishAllXml` triggered.

On `400 / 0x80071141` "circular relationship" — same handling as
`/setup-offline-profile` Step 8 (parse cycle path, prompt user to drop one
association, retry). Fallback to `PublishAllXml` only if `PublishXml` returns an
unexpected error other than the cycle case **and** the owner/user approves that
broader publication; a profile-scoped approval does not cover it.

All linked recovery commands, re-GET verification, and retries must bind the
same root and pass the same environment/tenant/profile/table/item context.
Never retry on a different profile or bypass a permission failure. Confirm
publication before Step 6.

If a linked recipe requires another offline helper, return the proposed change
to the owner for approval first, then read the helper at its absolute
`${PLUGIN_ROOT}/skills/<helper>/SKILL.md` path. Forward:

```text
Arguments: --working-dir "<working_dir>" --profile-id "<profileId>" --table "<table>" <exact-approved-change-flags>
Context: MOBILE_APP_ORCHESTRATING=1, orchestrator, working_dir, phase, approved_scope,
         selected environment ID/URL/tenant, profile ID, table allowlist, item ID,
         supplied answers, --plan-only (if present)
```

The recipient must enforce the same canonical root contract. Missing context
returns `NEEDS_CONTEXT`; do not fall back to direct invocation or rediscovery.

### Step 6 — Update artifacts

Re-read the changed item(s) in the same profile/environment and rewrite the
matching entry in `<working_dir>/offline-profile.json`. When the edit changed a
table's **columns** (`--columns add:/remove:/reset`), also refresh that entry's
`schemaColumns` to the table's current full column set from the bound absolute
manifest. This re-baselines the schema-reconciliation marker for the next
`${PLUGIN_ROOT}/scripts/offline-profile-delta.js` run; leave `schemaColumns`
untouched for scope/sync/rename-only edits. Any delta check uses
`--project-root "<working_dir>"` in its own guarded call. See
[offline-profile-reconciliation.md](${PLUGIN_ROOT}/shared/references/offline-profile-reconciliation.md).

Append a one-line entry to `<working_dir>/memory-bank.md` `## Offline profile` block:

```yaml
edits:
  - { at: 2026-05-19T..., field: 'chnl_storevisit.syncintervalinminutes', from: 5, to: 10 }
```

### Step 7 — Summary

```
✓ Edited profile.

  Field : chnl_storevisit.syncintervalinminutes
  From  : 5 min
  To    : 10 min
  Published: 2026-05-19T...

offline-profile.json + memory-bank.md updated.
```

## Status code (final line)

- `DONE` — change applied and published
- `DONE_WITH_CONCERNS: <list>` — change applied but with caveats (publish timeout-then-success, etc.)
- `NEEDS_CONTEXT: <missing>` — couldn't resolve target table or profile
- `BLOCKED: <reason>` — auth or PATCH failure

## What this skill does NOT do

- Add a NEW table to the profile → use `/add-table-to-offline-profile`
- Add a new association (relationship inclusion) → blocked on v0.2 `selectedrelationshipsschema` work; use maker portal in the meantime
- Delete the whole profile → manual `DELETE /mobileofflineprofiles(<id>)` (cascade-deletes items + associations); see [dataverse-offline-api.md §11](${PLUGIN_ROOT}/shared/references/dataverse-offline-api.md)
- Migrate the profile between environments → use `CloneMobileOfflineProfile` action (v0.5 work)
