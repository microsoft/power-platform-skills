---
name: add-table-to-offline-profile
description: Use when the user wants to add ONE table (typically a newly-added Dataverse table) to an existing offline profile without re-running the full /setup-offline-profile wizard. Parallel to /add-dataverse — same single-table flow.
user-invocable: false
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

**References:**

- [dataverse-offline-api.md](${CLAUDE_SKILL_DIR}/../../shared/references/dataverse-offline-api.md) §4 + §7 — POST item + PATCH selectedcolumns
- [offline-profile-reconciliation.md](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-reconciliation.md) — the `schemaColumns` baseline written in Step 7

# Add Table to Offline Profile

Add a single table to an existing Mobile Offline Profile. Most common flow: user ran `/add-dataverse` to add a new table to their app, now wants that table available offline too.

Equivalent to running `/setup-offline-profile` and seeing the existing profile (extend-mode), but skips the per-table questionnaire for the tables already in the profile — only configures the new one.

## Workflow

1. Verify project + locate profile → 2. Resolve target table → 3. Prereq check (auto-enable if needed) → 4. Scope picker (single question) → 5. POST item + PATCH selectedcolumns → 6. Publish → 7. Update artifacts → 8. Summary

---

### Step 1 — Verify project + locate profile

```bash
test -f power.config.json
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$(node -e \"console.log(require('./power.config.json').environmentId)\")"
```

Manifest path (dual-location):

```bash
MANIFEST=$(test -f .datamodel-manifest.json && echo ".datamodel-manifest.json" || \
           (test -f docs/plan-artifacts/.datamodel-manifest.json && echo "docs/plan-artifacts/.datamodel-manifest.json"))
test -n "$MANIFEST" && echo "✓ manifest at $MANIFEST"
```

Profile ID resolution (same as `/edit-offline-profile`).

STOP if no profile exists. Recommend: `Run /setup-offline-profile first to create the profile.`

### Step 2 — Resolve target table

`$ARGUMENTS` parsing:

| Flag | Effect |
|---|---|
| `--table <logical-name>` | Explicit target |
| `--all-new` | Add ALL tables in the manifest that aren't already in the profile (bulk mode) |
| (no flags) | Interactive: list tables in manifest NOT yet in profile via `AskUserQuestion` (max 4); if more than 4 candidates, prompt user to specify by name in next message |

For bulk `--all-new` mode, loop through Steps 3-6 for each missing table; each runs sequentially because Dataverse profile-item POSTs serialize.

### Step 3 — Prereq check (auto-enable if needed)

Query the target table's `EntityMetadata`:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions(LogicalName='<table>')?\$select=IsAvailableOffline,ChangeTrackingEnabled,OwnershipType,IsCustomizable"
```

| Flags state | Action |
|---|---|
| Both already `true` | Skip to Step 4 |
| Either `false` AND IsCustomizable | Auto-enable via `update-entity-offline-flags.js` (no prompt — the user already opted into "offline this table" by invoking this skill) |
| `IsCustomizable.Value = false` | STOP with `BLOCKED: <table> is system-managed and cannot be flagged for offline. Use a different table or accept this row is read-only-offline.` |

After auto-enable, single `POST PublishAllXml`.

### Step 4 — Scope picker (single question)

Pull from manifest the target table's `lookups[]` to inform defaults. Run a quick row-count probe to inform reference-data classification.

`AskUserQuestion` with 4 options reflecting the architect's priority cascade:

| Option label | Maps to |
|---|---|
| `Organization rows — User's rows only (Recommended for most tables)` | `recorddistributioncriteria: 2`, `recordsownedbyme: true` |
| `All records (for small reference data)` | `recorddistributioncriteria: 1` |
| `Related rows only (for pure child tables)` | `recorddistributioncriteria: 0` |
| `Custom — specify exact flags in next message` | Prompt user with text |

Recommendation in the question body should be derived from the architect's heuristics for the table being added (use the same priority cascade from `offline-profile-architect.md` Step 4 inline). The user can override.

### Step 5 — POST item + associations + PATCH selectedcolumns

#### Step 5a — POST profile item

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "mobileofflineprofileitems" \
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

Recipe per [shared/references/dataverse-offline-api.md §5–§6](${CLAUDE_SKILL_DIR}/../../shared/references/dataverse-offline-api.md):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "mobileofflineprofileitemassociations" \
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

Build `selectedcolumns` using the deterministic union from [offline-profile-architect.md](${CLAUDE_SKILL_DIR}/../../agents/offline-profile-architect.md) Step 6 (always-include ∪ lookups ∪ screen-grep'd, dedupe, sort).

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> PATCH \
  "mobileofflineprofileitems(<itemId>)" \
  --body '{"selectedcolumns":"{\"Columns\":[...]}"}'
```

### Step 6 — Publish (targeted PublishXml)

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "PublishXml" --body '{
    "ParameterXml": "<publish><mobileofflineprofiles><mobileofflineprofile>'"$PROFILE_ID"'</mobileofflineprofile></mobileofflineprofiles></publish>"
  }'
```

Publishes only this profile, not the entire org's customizations. See [shared/references/dataverse-offline-api.md §9](${CLAUDE_SKILL_DIR}/../../shared/references/dataverse-offline-api.md) for `0x80071141` circular-relationship handling + `PublishAllXml` fallback.

### Step 7 — Update artifacts

Append the new table's entry to `offline-profile.json` `tables[]`. The entry MUST include a `schemaColumns` array — the added table's full set of schema column logical names from `.datamodel-manifest.json` at this moment. This is the schema-reconciliation baseline that `scripts/offline-profile-delta.js` diffs future manifest changes against; omitting it makes the lifecycle delta check report this table under `columnBaselineMissing` until it is re-reconciled. It is distinct from `selectedColumns` (the curated sync set) — see [offline-profile-reconciliation.md](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-reconciliation.md). Match the canonical entry shape in [`/setup-offline-profile` Step 9a](../setup-offline-profile/SKILL.md).

Append to `memory-bank.md` `## Offline profile` block:

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
