---
name: add-table-to-offline-profile
description: Internal mobile-app workflow read and executed only by mobile orchestrators to add one Dataverse table to an existing Mobile Offline Profile.
user-invocable: false
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**References:**

- [dataverse-offline-api.md](${PLUGIN_ROOT}/shared/references/dataverse-offline-api.md) §4 + §7 — POST item + PATCH selectedcolumns
- [offline-profile-reconciliation.md](${PLUGIN_ROOT}/shared/references/offline-profile-reconciliation.md) — the `schemaColumns` baseline written in Step 7

# Add Table to Offline Profile

Add a single table to an existing Mobile Offline Profile. Most common flow: user ran `/add-dataverse` to add a new table to their app, now wants that table available offline too.

Equivalent to running `/setup-offline-profile` and seeing the existing profile (extend-mode), but skips the per-table questionnaire for the tables already in the profile — only configures the new one.

## Invocation context and root binding

This internal helper is always a **child invocation**. Before any project read or
command, execute [app-working-directory.md](${PLUGIN_ROOT}/shared/references/app-working-directory.md).
Require the owner's absolute `working_dir`; `--working-dir`, when supplied, must
identify that same native-canonical root. Missing, relative, or conflicting root
context returns `NEEDS_CONTEXT` before project access; an inaccessible directory
is `BLOCKED`. Never use the launch cwd or introduce another root resolver.

Receive `MOBILE_APP_ORCHESTRATING=1`, `orchestrator`, `working_dir`, `phase`,
`approved_scope`, and supplied answers from the owner. Keep the selected
environment ID/URL/tenant, profile ID, exact table allowlist, and approved
operations unchanged. Missing or conflicting scope returns `NEEDS_CONTEXT`;
do not substitute another environment, profile, or table. The marker is not
approval: schema approval alone does not authorize offline prerequisite changes,
profile items, relationships, columns, publication, deletion, or membership edits.
Reuse only the same current offline approvals; otherwise retain Steps 3–4's gates.
For `--plan-only` or a planning-phase handoff, return a proposal after permitted
read-only discovery, before any prerequisite update, profile mutation, publish,
or artifact write. A gate response cannot lift proposal-only mode.

Apply the canonical contract to **every shell call and file tool**, including
version/auth checks, row counts, screen greps, commands copied from references,
verification, recovery, and retries. Re-supply the absolute `PLUGIN_ROOT` and
required context on each call; no prior `cd`, export, or shell variable persists.
Use the canonical Bash guard below or its PowerShell equivalent. Replace
placeholders with validated, shell-quoted invocation values; missing values
return `NEEDS_CONTEXT`, never execute an unresolved placeholder.
File tools use absolute `<working_dir>/...` paths; plugin reads/scripts use
`${PLUGIN_ROOT}/...`. Resolve manifest location once within this root and keep
that absolute path; never search another app when a file is absent.

## Workflow

1. Verify project + locate profile → 2. Resolve target table → 3. Prereq check (auto-enable if needed) → 4. Scope picker (single question) → 5. POST item + PATCH selectedcolumns → 6. Publish → 7. Update artifacts → 8. Summary

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

Manifest path (dual-location, both within the bound root):

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
if [ -f .datamodel-manifest.json ]; then
  printf '%s\n' "<working_dir>/.datamodel-manifest.json"
elif [ -f docs/plan-artifacts/.datamodel-manifest.json ]; then
  printf '%s\n' "<working_dir>/docs/plan-artifacts/.datamodel-manifest.json"
else
  echo "NEEDS_CONTEXT: no manifest in working_dir" >&2
  exit 1
fi
```

Read the profile from `<working_dir>/offline-profile.json` or the owner's explicit
`--profile-id`, using `/edit-offline-profile`'s resolution rules inline. Verify it
matches the owner's profile and the live profile in the selected environment.
A conflicting snapshot/argument, 404, or permission failure is not permission to
pick a different profile; return `NEEDS_CONTEXT` for conflict or `BLOCKED` for
access failure. Do not execute the edit workflow just to locate a profile.

STOP if no profile exists. Recommend: `Run /setup-offline-profile first to create the profile.`

### Step 2 — Resolve target table

`$ARGUMENTS` parsing:

| Flag | Effect |
|---|---|
| `--table <logical-name>` | Explicit target |
| `--all-new` | Add missing manifest tables only within the owner's exact table allowlist (bulk mode); never widen to unrelated pending tables |
| (no flags) | Interactive: list allowed tables in the manifest NOT yet in the selected profile via `AskUserQuestion` (max 4); if more than 4 candidates, prompt user to specify by name in next message |

An explicit `--table` must match the owner's allowlist. Conflicting selection
returns `NEEDS_CONTEXT`. For bulk `--all-new` mode, loop through Steps 3–7 for
each approved missing table; each runs sequentially because Dataverse profile-item
POSTs serialize. Every iteration keeps the same root/environment/profile context.

### Step 3 — Prereq check (auto-enable if needed)

Query the target table's `EntityMetadata`:

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" GET \
  "EntityDefinitions(LogicalName='<table>')?\$select=IsAvailableOffline,ChangeTrackingEnabled,OwnershipType,IsCustomizable" \
  --tenant-id "<tenantId>"
```

| Flags state | Action |
|---|---|
| Both already `true` | Skip to Step 4 |
| Either `false` AND IsCustomizable | Use `update-entity-offline-flags.js` only if the current offline approval covers these exact prerequisite changes and publication; otherwise show the changes and obtain owner/user approval first |
| `IsCustomizable.Value = false` | STOP with `BLOCKED: <table> is system-managed and cannot be flagged for offline. Use a different table or accept this row is read-only-offline.` |

After approval, execute the helper for this table only (it accepts tenant context
through environment variables, not a `--tenant-id` flag):

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
POWER_PLATFORM_TENANT_ID="<tenantId>" DATAVERSE_TENANT_ID="<tenantId>" \
node "${PLUGIN_ROOT}/scripts/update-entity-offline-flags.js" "<envUrl>" \
  --table "<table>" --offline true --tracking true
```

Check the returned HTTP status, not just process exit. A 403/`PrivilegeCheckFailed`
is `BLOCKED`; do not change identity or profile to bypass permissions.
After a successful change, issue the approved prerequisite publication:

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" POST \
  "PublishAllXml" --tenant-id "<tenantId>" --body '{}'
```

No prerequisite mutation or publication is allowed in proposal-only mode.

### Step 4 — Scope picker (single question)

Pull from the bound absolute manifest the target table's `lookups[]` to inform
defaults. Run a root-bound row-count probe in the selected environment for this
table only to inform reference-data classification.

`AskUserQuestion` with 4 options reflecting the architect's priority cascade:

| Option label | Maps to |
|---|---|
| `Organization rows — User's rows only (Recommended for most tables)` | `recorddistributioncriteria: 2`, `recordsownedbyme: true` |
| `All records (for small reference data)` | `recorddistributioncriteria: 1` |
| `Related rows only (for pure child tables)` | `recorddistributioncriteria: 0` |
| `Custom — specify exact flags in next message` | Prompt user with text |

Recommendation in the question body should be derived from the architect's heuristics for the table being added (use the same priority cascade from `offline-profile-architect.md` Step 4 inline). The user can override.

Show the proposed relationships, selected columns, and sync interval alongside
the scope choice. Reuse supplied answers only when they approve this exact
offline change; otherwise wait for the choice before Step 5. Cancel stops without
creating a profile item. Neither invocation nor the orchestration marker answers
this gate.

### Step 5 — POST item + associations + PATCH selectedcolumns

#### Step 5a — POST profile item

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" POST \
  "mobileofflineprofileitems" --tenant-id "<tenantId>" \
  --body '{
    "name": "<DisplayName>",
    "regardingobjectid@odata.bind": "/mobileofflineprofiles(<profileId>)",
    "selectedentitytypecode": "<table>",
    "recorddistributioncriteria": <0|1|2>,
    "recordsownedbyme": <bool>,
    "recordsownedbymyteam": false,
    "recordsownedbymybusinessunit": false,
    "getrelatedentityrecords": true,
    "syncintervalinminutes": 10
  }' \
  --include-headers
```

Capture `itemId` from `OData-EntityId` response header.

#### Step 5b — POST associations for the new table's relationships

After the new item is created, walk the new table's relationships (from the manifest's `lookups[]` + a `EntityDefinitions(LogicalName='<table>')/ManyToOneRelationships` query) and POST one `mobileofflineprofileitemassociation` per relationship whose target is ALREADY in the profile.

Recipe per [shared/references/dataverse-offline-api.md §5–§6](${PLUGIN_ROOT}/shared/references/dataverse-offline-api.md):

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" POST \
  "mobileofflineprofileitemassociations" --tenant-id "<tenantId>" \
  --body '{
    "name": "<relationshipSchemaName>",
    "relationshipdisplayname": "<relationshipSchemaName>",
    "relationshipid": "<MetadataId-from-EntityDefinitions>",
    "regardingobjectid@odata.bind": "/mobileofflineprofileitems(<newItemId>)"
  }' \
  --include-headers
```

**Critical**: do NOT include `selectedrelationshipsschema` in the body — server fills it in (empirical 2026-05-24).

For new tables that are `recorddistributioncriteria: 0` (Related rows only), at least ONE inbound relationship MUST be included or the table will sync zero rows. The skill should validate this and warn if no associations are being created for a Related-only-scoped table.

#### Step 5c — PATCH selectedcolumns

Build `selectedcolumns` using the deterministic union from [offline-profile-architect.md](${PLUGIN_ROOT}/agents/offline-profile-architect.md) Step 6 (always-include ∪ lookups ∪ screen-grep'd, dedupe, sort). Scope file-tool greps to absolute `<working_dir>/app/` and `<working_dir>/src/` paths and the selected table; use the same proposed columns approved in Step 4.

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" PATCH \
  "mobileofflineprofileitems(<itemId>)" --tenant-id "<tenantId>" \
  --body '{"selectedcolumns":"{\"Columns\":[...]}"}'
```

### Step 6 — Publish (targeted PublishXml)

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" POST \
  "PublishXml" --tenant-id "<tenantId>" --body '{
    "ParameterXml": "<publish><mobileofflineprofiles><mobileofflineprofile><profileId></mobileofflineprofile></mobileofflineprofiles></publish>"
  }'
```

Publishes only this profile, not the entire org's customizations. See [shared/references/dataverse-offline-api.md §9](${PLUGIN_ROOT}/shared/references/dataverse-offline-api.md) for `0x80071141` circular-relationship handling + `PublishAllXml` fallback.

All linked recovery commands, re-GET verification, and retries must bind the
same root and pass the same environment/tenant/profile/table/item context.
Removing a cycle association requires the explicit user decision in that recipe.
An org-wide `PublishAllXml` fallback needs approval for that broader publication;
do not silently escalate a profile-scoped approval. Never retry on a different
profile or bypass a permission failure. Confirm publication before Step 7.

If a linked recovery recipe requires another offline helper, return the proposed
change to the owner for approval first, then read the helper at its absolute
`${PLUGIN_ROOT}/skills/<helper>/SKILL.md` path. Forward:

```text
Arguments: --working-dir "<working_dir>" --profile-id "<profileId>" --table "<table>" <exact-approved-change-flags>
Context: MOBILE_APP_ORCHESTRATING=1, orchestrator, working_dir, phase, approved_scope,
         selected environment ID/URL/tenant, profile ID, table allowlist, item ID,
         supplied answers, --plan-only (if present)
```

The recipient must enforce the same canonical root contract. Missing context
returns `NEEDS_CONTEXT`; do not fall back to direct invocation or rediscovery.

### Step 7 — Update artifacts

Append the new table's entry to `<working_dir>/offline-profile.json` `tables[]`.
The entry MUST include a `schemaColumns` array — the added table's full set of
schema column logical names from the bound absolute manifest at this moment.
This is the schema-reconciliation baseline that
`${PLUGIN_ROOT}/scripts/offline-profile-delta.js` diffs future manifest changes
against; omitting it reports `columnBaselineMissing` until re-reconciled. It is
distinct from `selectedColumns` (the curated sync set) — see
[offline-profile-reconciliation.md](${PLUGIN_ROOT}/shared/references/offline-profile-reconciliation.md).
Match the canonical entry shape in
[`/setup-offline-profile` Step 9a](${PLUGIN_ROOT}/skills/setup-offline-profile/SKILL.md)
without executing that workflow. Any delta check uses
`--project-root "<working_dir>"` in its own guarded call.

Append to `<working_dir>/memory-bank.md` `## Offline profile` block:

```yaml
addedTables:
  - { at: 2026-05-19T..., table: <name>, itemId: <guid>, scope: <criterion> }
```

### Step 8 — Summary

```
✓ Added <table> to profile.

  Profile      : <name>
  New item ID  : <guid>
  Scope        : <human-readable>
  Sync         : <minutes> min
  Columns      : <N> selected
  Published    : <ISO timestamp>

Total tables in profile now: <N>

Users who already have this profile assigned will receive the new table on their
next sign-in sync. To force-refresh, sign out and back in on the device.
```

## Status code (final line)

- `DONE` — table added, profile published, artifacts updated
- `DONE_WITH_CONCERNS: <list>` — added with caveats (auto-enabled prereqs, publish timeout-then-success)
- `NEEDS_CONTEXT: <missing>` — no profile to add to, or no target table
- `BLOCKED: <reason>` — IsCustomizable=false on target, auth failure, POST/PATCH failure

## What this skill does NOT do

- Add **N:N (ManyToMany) relationships** to a profile item — uncommon, not covered by v0.1's recipe (which assumes N:1 / 1:N via the `regardingobjectid` lookup). If the user has an M:N use case, point them at the maker portal.
- Re-architect existing tables in the profile — that's `/edit-offline-profile`.
- Remove a table from the profile — manual `DELETE /mobileofflineprofileitems(<itemId>)` (no current skill).
