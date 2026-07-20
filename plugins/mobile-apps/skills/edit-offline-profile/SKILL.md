---
name: edit-offline-profile
description: Use when the user wants to change ONE aspect of an existing offline profile (row scope for a table, column list, sync frequency) without re-running the full /setup-offline-profile wizard. Mirrors the /edit-app gated edit pattern.
user-invocable: false
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

**References:**

- [dataverse-offline-api.md](${CLAUDE_SKILL_DIR}/../../shared/references/dataverse-offline-api.md) §4 / §7 — POST item + PATCH selectedcolumns
- [offline-profile-reconciliation.md](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-reconciliation.md) — refreshing the `schemaColumns` baseline after a column edit

# Edit Offline Profile

Re-run a single piece of an existing profile — change one table's row scope, update the column list, adjust sync frequency, or rename the profile. Avoids the cognitive cost of walking the full /setup-offline-profile wizard for a one-line change.

Scope: existing profile (read from `offline-profile.json` or `--profile-id`); edits at the table-item granularity. To ADD a new table see `/add-table-to-offline-profile`; to delete the entire profile see [dataverse-offline-api.md §11](${CLAUDE_SKILL_DIR}/../../shared/references/dataverse-offline-api.md).

## Workflow

1. Verify project + locate profile → 2. Resolve target (which table / what to change) → 3. Show current vs proposed → Single confirm → 4. PATCH → 5. Publish → 6. Update artifacts → 7. Summary

---

### Step 1 — Verify project + locate profile

```bash
test -f power.config.json
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$(node -e \"console.log(require('./power.config.json').environmentId)\")"
```

Profile ID resolution (same priority as `/assign-offline-profile` Step 1):

| Source | Used when |
|---|---|
| `$ARGUMENTS` `--profile-id <guid>` | Explicit override |
| `offline-profile.json` top-level `profileId` in cwd | Default for `/setup-offline-profile`-created projects |
| Otherwise | `AskUserQuestion` with list from `GET /mobileofflineprofiles` |

STOP if no profile found: "Run `/setup-offline-profile` first."

> **`power.config.json` is intentionally NOT consulted here.** That file is owned by `npx power-apps init`. The profile ID lives in `offline-profile.json` only.

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

### Step 3 — Show current vs proposed (single gate)

GET the current item state from Dataverse for any tables being edited:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "mobileofflineprofileitems(<itemId>)?\$select=name,recorddistributioncriteria,recordsownedbyme,recordsownedbymyteam,recordsownedbymybusinessunit,syncintervalinminutes,selectedcolumns"
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
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> PATCH \
  "mobileofflineprofileitems(<itemId>)" \
  --body '{
    "recorddistributioncriteria": <new>,
    "recordsownedbyme": <new-bool>,
    "syncintervalinminutes": <new>,
    "selectedcolumns": "{\"Columns\":[...]}"
  }'
```

For profile-level edits (name / description):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> PATCH \
  "mobileofflineprofiles(<profileId>)" \
  --body '{"name": "...", "description": "..."}'
```

### Step 5 — Publish

Use the **targeted `PublishXml`** recipe from [shared/references/dataverse-offline-api.md §9](${CLAUDE_SKILL_DIR}/../../shared/references/dataverse-offline-api.md):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "PublishXml" --body '{
    "ParameterXml": "<publish><mobileofflineprofiles><mobileofflineprofile>'"$PROFILE_ID"'</mobileofflineprofile></mobileofflineprofiles></publish>"
  }'
```

Publishes only this profile, not the entire org's customizations. Avoids the 429 rate-limit storms on shared envs that the legacy `PublishAllXml` triggered.

On `400 / 0x80071141` "circular relationship" — same handling as `/setup-offline-profile` Step 8 (parse cycle path, prompt user to drop one association, retry). Fallback to `PublishAllXml` only if `PublishXml` returns an unexpected error other than the cycle case.

### Step 6 — Update artifacts

Re-read the changed item(s) and rewrite the matching entry in `offline-profile.json`. When the edit changed a table's **columns** (`--columns add:/remove:/reset`), also refresh that table entry's `schemaColumns` to the table's current full column set from `.datamodel-manifest.json` (root or `docs/plan-artifacts/`). This re-baselines the schema-reconciliation marker so a delta that was just reconciled clears on the next `scripts/offline-profile-delta.js` run; leave `schemaColumns` untouched for scope/sync/rename-only edits. See [offline-profile-reconciliation.md](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-reconciliation.md).

Append a one-line entry to `memory-bank.md` `## Offline profile` block:

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
- Delete the whole profile → manual `DELETE /mobileofflineprofiles(<id>)` (cascade-deletes items + associations); see [dataverse-offline-api.md §11](${CLAUDE_SKILL_DIR}/../../shared/references/dataverse-offline-api.md)
- Migrate the profile between environments → use `CloneMobileOfflineProfile` action (v0.5 work)
