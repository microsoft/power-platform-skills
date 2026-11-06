---
name: enable-tables-offline
description: Internal mobile-app workflow read and executed only by /setup-offline-profile to enable Dataverse table prerequisites for a Mobile Offline Profile.
user-invocable: false
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, EnterPlanMode, ExitPlanMode
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**References:**

- [offline-profile-schema.md](${PLUGIN_ROOT}/shared/references/offline-profile-schema.md) — entity field map (`IsAvailableOffline`, `ChangeTrackingEnabled`)

# Enable Tables Offline

Flip `IsAvailableOffline=true` AND `ChangeTrackingEnabled=true` on the `EntityMetadata` of one or more Dataverse tables, then publish customizations. This is the prerequisite shown in Image 4 of the maker portal ("Can be taken offline" + "Track changes") — without both, a table CANNOT be added to a Mobile Offline Profile.

Sequential (Dataverse metadata lock) and idempotent: re-running on an already-enabled table is a no-op.

## Invocation context and root binding

This internal helper is always a **child invocation**. Before any project read or
command, execute [app-working-directory.md](${PLUGIN_ROOT}/shared/references/app-working-directory.md).
Require the owner's absolute `working_dir`; `--working-dir`, when supplied, must
identify that same native-canonical root. Missing, relative, or conflicting root
context returns `NEEDS_CONTEXT` before project access; an inaccessible directory
is `BLOCKED`. Never use the launch cwd or introduce another root resolver.

Receive `MOBILE_APP_ORCHESTRATING=1`, `orchestrator: setup-offline-profile`,
`working_dir`, `phase`, `approved_scope`, and supplied answers. Preserve the
selected environment ID/URL/tenant and exact table/prerequisite/publication
allowlist. The marker is not approval. Reuse only matching current offline
approval; a missing or changed scope returns `NEEDS_CONTEXT` to the owner.
For `--plan-only` or a planning-phase handoff, return the proposed prerequisite
changes after permitted read-only inspection, before PUT, publication, or
artifact writes. A gate response cannot lift proposal-only mode.

Apply the canonical root contract to **every shell call and file tool**.
Re-supply the absolute `PLUGIN_ROOT` and invocation context on each call; no
prior `cd`, export, or shell variable persists. Missing values return
`NEEDS_CONTEXT`; never execute an unresolved placeholder.
All linked recovery commands, re-GET verification, and retries use the same
root, environment, and explicit tenant. Read only absolute app-local paths,
including `<working_dir>/power.config.json`, `<working_dir>/memory-bank.md`,
and the manifest locations below.

## Workflow

1. Verify project & auth → 2. Resolve table list → 3. Inspect current state → Gate → 4. PUT EntityMetadata per table → 5. Publish → 6. Verify → 7. Summary

---

### Step 1 — Verify project & auth

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
if [ ! -f power.config.json ] || [ ! -f app.config.js ]; then
  echo "BLOCKED: working_dir is not an initialized app" >&2
  exit 1
fi
```

Require the app's `environmentId` to match the owner's selected environment
before any discovery or mutation. Use this non-persisting lookup from the same root:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
environment_id=$(node -p "require('./power.config.json').environmentId || ''") || {
  echo "BLOCKED: unreadable power.config.json" >&2; exit 1;
}
if [ -z "$environment_id" ] || [ "$environment_id" != "<selected-environment-id>" ]; then
  echo "NEEDS_CONTEXT: selected environment does not match working_dir" >&2
  exit 1
fi
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$environment_id" --no-cache --require-tenant
```

Capture the **Environment URL** and **Tenant ID** from the resolver for
`<envUrl>` and `<tenantId>`. Pass this tenant explicitly on every helper call
and retry below; missing or conflicting tenant context is `NEEDS_CONTEXT`.
Require the ID, URL, and tenant to match the owner; never switch accounts or
environments to recover. STOP if not authenticated.

### Step 2 — Resolve table list

Use only the exact table allowlist in the owner's `approved_scope`. The comma-
or space-separated table list in `$ARGUMENTS` must match it; `--working-dir` is
root context, not a table name. Missing or conflicting table selection returns
`NEEDS_CONTEXT`; an explicitly empty approved list is a verified no-op.

Inspect `<working_dir>/.datamodel-manifest.json`, or
`<working_dir>/docs/plan-artifacts/.datamodel-manifest.json` for newer apps, only
to verify those selected tables. The manifest is not permission to enable every
row. Do not discover another app's manifest or expand the allowlist silently.

### Step 3 — Inspect current state

**Print before starting:**
> "→ Querying current IsAvailableOffline + ChangeTrackingEnabled for <N> table(s)…"

For each table, in sequence:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" GET \
  "EntityDefinitions(LogicalName='<table>')?\$select=LogicalName,DisplayName,IsAvailableOffline,ChangeTrackingEnabled,IsCustomizable" \
  --tenant-id "<tenantId>"
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

Compare the status table from Step 3 with the owner's approved prerequisite and
publication delta. Matching current Gate 1 approval is reused without a duplicate
prompt. Otherwise return the status table and `NEEDS_CONTEXT: offline prerequisite
approval` to `/setup-offline-profile`, which owns the approval gate. Do not widen
scope or override proposal-only mode.

Plan body:

```text
The following EntityMetadata changes will be PUT in sequence:

cr123_note   → set IsAvailableOffline=true, ChangeTrackingEnabled=true
cr123_visit  → set ChangeTrackingEnabled=true (IsAvailableOffline already true)

After all updates, targeted PublishXml will publish only the changed tables.

Tables already in the desired state are skipped (no API call).
```

If the user rejects, STOP. Proceed only with the exact approved delta.

### Step 4 — PUT EntityMetadata per table

**Print before starting:**
> "→ Updating EntityMetadata for <N> table(s) sequentially (Dataverse serializes metadata writes)…"

> **⚠️ Concurrency rule — do not violate.** Metadata writes hold an exclusive lock per org. Issue one PUT, wait for 2xx, then the next. No batching, no parallel calls. Same rule as `/add-dataverse` Step 5.

For each table needing change (skip ones already in target state):

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/update-entity-offline-flags.js" "<envUrl>" \
  --table "<table>" \
  --offline true \
  --tracking true \
  --tenant-id "<tenantId>"
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
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
# Build the <entities> XML body from the list of tables modified in Step 4
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" POST \
  "PublishXml" --tenant-id "<tenantId>" --body '{
    "ParameterXml": "<importexportxml><entities><entity><table></entity></entities></importexportxml>"
  }'
```

Substitute `<entity>...</entity>` lines for every table the helper PUT'd flags on in Step 4. Tables that were no-ops or uncustomizable are omitted.

**On 204**: success — continue to Step 6.

**On 429 / 0x80071151 ("concurrent publish already running")**: back off automatically via `dataverse-request.js`'s retry logic. If still failing after 4 retries, return `DONE_WITH_CONCERNS: publish bottlenecked on shared env; metadata changes are committed but maker portal will not refresh until next publish`. The downstream skill (`/setup-offline-profile`) can proceed — metadata-level writes are durable.

**Fallback to `PublishAllXml`** only when the targeted call returns a non-rate-limit
error such as `0x80048d19` and the owner separately approves the broader publication.
Table-only approval does not authorize publishing unrelated changes.

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<envUrl>" POST \
  "PublishAllXml" --tenant-id "<tenantId>" --body '{}'
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

Next: return to the current /setup-offline-profile workflow.
```

Update `<working_dir>/memory-bank.md` under `## Offline profile` with the timestamp
and verified table list. Return the results to the current owner; do not launch
another offline setup workflow.

## Status code

The literal first line of the skill's response is one of:
- `DONE` — all requested tables now have both flags set
- `DONE_WITH_CONCERNS: <list>` — some tables skipped (uncustomizable, publish warning, etc.)
- `NEEDS_CONTEXT: <missing>` — couldn't resolve table list and user didn't provide
- `BLOCKED: <reason>` — auth failure, privilege check failed, or post-PUT verification disagreed
