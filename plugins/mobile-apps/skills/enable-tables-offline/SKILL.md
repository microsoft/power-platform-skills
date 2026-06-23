---
name: enable-tables-offline
description: Use when the user needs to enable the per-table prerequisites (Can be taken offline, Track changes) before a Dataverse table can be added to a Mobile Offline Profile. Pre-flight pass for /setup-offline-profile.
user-invocable: false
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, EnterPlanMode, ExitPlanMode
model: sonnet
---

**Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

**References:**

- [offline-profile-schema.md](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-schema.md) — entity field map (`IsAvailableOffline`, `ChangeTrackingEnabled`)

# Enable Tables Offline

Flip `IsAvailableOffline=true` AND `ChangeTrackingEnabled=true` on the `EntityMetadata` of one or more Dataverse tables, then publish customizations. This is the prerequisite shown in Image 4 of the maker portal ("Can be taken offline" + "Track changes") — without both, a table CANNOT be added to a Mobile Offline Profile.

Sequential (Dataverse metadata lock) and idempotent: re-running on an already-enabled table is a no-op.

## Workflow

1. Verify project & auth → 2. Resolve table list → 3. Inspect current state → Gate → 4. PUT EntityMetadata per table → 5. Publish → 6. Verify → 7. Summary

---

### Step 1 — Verify project & auth

```bash
test -f power.config.json && test -f app.config.js
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$(node -e \"console.log(require('./power.config.json').environmentId)\")"
```

Capture the **Environment URL** from the resolver for `<envUrl>`. STOP if not authenticated.

### Step 2 — Resolve table list

Tables to enable come from one of (in order):

| Source | Used when |
|---|---|
| `$ARGUMENTS` | User passed a comma- or space-separated list of logical names (e.g. `/enable-tables-offline cr123_note,cr123_visit`) |
| `.datamodel-manifest.json` | Default — read `tables[].logicalName` for every Dataverse-backed table in the app |
| `AskUserQuestion` | Only if both above are absent. Show the table list from `src/generated/services/*Service.ts` filenames and let the user pick. |

If the resolved list is empty, STOP with: "No Dataverse tables found in this project. Run `/add-dataverse` first."

### Step 3 — Inspect current state

**Print before starting:**
> "→ Querying current IsAvailableOffline + ChangeTrackingEnabled for <N> table(s)…"

For each table, in sequence:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions(LogicalName='<table>')?\$select=LogicalName,DisplayName,IsAvailableOffline,ChangeTrackingEnabled,IsCustomizable"
```

Build a status table:

```text
| Table              | IsAvailableOffline | ChangeTrackingEnabled | IsCustomizable | Needs change? |
|--------------------|--------------------|-----------------------|----------------|---------------|
| cr123_note         | false              | false                 | true           | YES (both)    |
| cr123_visit        | true               | false                 | true           | YES (track)   |
| contact            | true               | true                  | true           | NO            |
```

**Hard rule:** if `IsCustomizable.Value=false` on any table, that table CANNOT be modified. Drop it from the change set and flag in `DONE_WITH_CONCERNS` — system-managed tables (most OOB) require an admin solution patch path the skill does not handle.

### Gate — Approval before mutation

Enter plan mode with the status table from Step 3 plus the planned operation per table. Wait for user `ExitPlanMode` before proceeding.

Plan body:

```text
The following EntityMetadata changes will be PUT in sequence:

cr123_note   → set IsAvailableOffline=true, ChangeTrackingEnabled=true
cr123_visit  → set ChangeTrackingEnabled=true (IsAvailableOffline already true)

After all updates, a single PublishAllXml request will commit the changes.

Tables already in the desired state are skipped (no API call).
```

If the user rejects, STOP. If they approve, proceed.

### Step 4 — PUT EntityMetadata per table

**Print before starting:**
> "→ Updating EntityMetadata for <N> table(s) sequentially (Dataverse serializes metadata writes)…"

> **⚠️ Concurrency rule — do not violate.** Metadata writes hold an exclusive lock per org. Issue one PUT, wait for 2xx, then the next. No batching, no parallel calls. Same rule as `/add-dataverse` Step 5.

For each table needing change (skip ones already in target state):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/update-entity-offline-flags.js" <envUrl> \
  --table <table> \
  --offline true \
  --tracking true
```

The helper:
- Re-reads `EntityMetadata` to pick up the current `MetadataId` + `SchemaName` (both required in the PUT body — Dataverse rejects PUT without them).
- Sends `MSCRM.MergeLabels: true` so display labels are preserved (the alternative wipes labels — never use `false`).
- Returns `{ "status": 200, "noop": true, ... }` if the table is already in the target state (skip silently).
- Returns `{ "status": 200, "skipped": "uncustomizable", ... }` for tables whose `IsCustomizable.Value=false` (system-managed; you must surface as `DONE_WITH_CONCERNS`).
- Returns `{ "status": 204, ... }` on successful update.
- Handles 401 token refresh and 429 back-off automatically.

**If the helper returns status 403 `PrivilegeCheckFailed`:** the user lacks "Customize System" privilege. Print the table name and which privilege is missing, then STOP.

**If status 400 with `ChangeTrackingEnabled cannot be disabled`:** ignore — that path only triggers when going from true to false, which we never do.

Print `✓ <table>` after each 204; print `↷ <table> (already enabled)` for no-ops; print `⚠ <table> (uncustomizable)` for skips.

### Step 5 — Publish customizations (targeted PublishXml, with PublishAllXml fallback)

**Print before starting:**
> "→ Publishing customizations (targeted PublishXml on the entities just edited)…"

**Use targeted `PublishXml`** scoped to the entities that were actually modified — avoids the org-wide rate-limit storms (`0x80071151` "concurrent PublishAll already running") observed on shared envs. Empirical 2026-05-25.

```bash
# Build the <entities> XML body from the list of tables modified in Step 4
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "PublishXml" --body '{
    "ParameterXml": "<importexportxml><entities><entity>cr720_fcbflag</entity><entity>cr720_rolloutevent</entity></entities></importexportxml>"
  }'
```

Substitute `<entity>...</entity>` lines for every table the helper PUT'd flags on in Step 4. Tables that were no-ops or uncustomizable are omitted.

**On 204**: success — continue to Step 6.

**On 429 / 0x80071151 ("concurrent publish already running")**: back off automatically via `dataverse-request.js`'s retry logic. If still failing after 4 retries, return `DONE_WITH_CONCERNS: publish bottlenecked on shared env; metadata changes are committed but maker portal will not refresh until next publish`. The downstream skill (`/setup-offline-profile`) can proceed — metadata-level writes are durable.

**Fallback to `PublishAllXml`** (only when the targeted call returns a non-rate-limit error like `0x80048d19` malformed body):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "PublishAllXml" --body '{}'
```

Same timeout-but-success handling as `/setup-offline-profile` Step 8: if the client times out but a follow-up GET on the table's EntityMetadata shows the flags are set, treat as success.

### Step 6 — Verify

**Print before starting:**
> "→ Re-querying EntityMetadata to confirm flags are set…"

Re-run the Step 3 query for each modified table. Assert `IsAvailableOffline=true` and `ChangeTrackingEnabled=true` on every changed row. If any disagree, BLOCKED — something rejected the PUT silently (extremely unlikely; usually an indication of a managed-solution layer that's masking the unmanaged change).

### Step 7 — Summary

Print:

```text
✓ Offline prerequisites enabled on <N> table(s):
  - cr123_note    (IsAvailableOffline + ChangeTrackingEnabled set)
  - cr123_visit   (ChangeTrackingEnabled set; IsAvailableOffline already on)

Skipped (already enabled): contact

Next: run /setup-offline-profile to design the offline profile that uses these tables.
```

Update `memory-bank.md` under `## Offline profile` with the timestamp and table list.

## Status code

Final line of the skill's response is one of:
- `DONE` — all requested tables now have both flags set
- `DONE_WITH_CONCERNS: <list>` — some tables skipped (uncustomizable, publish warning, etc.)
- `NEEDS_CONTEXT: <missing>` — couldn't resolve table list and user didn't provide
- `BLOCKED: <reason>` — auth failure, privilege check failed, or post-PUT verification disagreed
