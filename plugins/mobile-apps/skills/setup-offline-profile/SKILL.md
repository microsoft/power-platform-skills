---
name: setup-offline-profile
description: Use when the user wants to enable offline mode for a Power Apps mobile app and create a Mobile Offline Profile in Dataverse — designs per-table row scope, relationships, columns, and sync frequency through a 3-gate approval flow.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, EnterPlanMode, ExitPlanMode, Task
model: opus
---

**Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

**References:**

- [offline-profile-schema.md](${CLAUDE_SKILL_DIR}/../../shared/references/offline-profile-schema.md) — Dataverse entity field map
- [dataverse-offline-api.md](${CLAUDE_SKILL_DIR}/../../shared/references/dataverse-offline-api.md) — Web API recipes for profile / item / association POSTs

# Setup Offline Profile

End-to-end wizard for creating a Dataverse Mobile Offline Profile that the app (and any other compatible Power Apps client) can use to download data for offline access.

**Scope of v0**: authoring only. This skill creates the Dataverse entities (`mobileofflineprofile`, `mobileofflineprofileitem`, `mobileofflineprofileitemassociation`) and writes the full app-level offline config — profile metadata, per-table scope, and the temporary SDK-workaround fields — to `offline-profile.json`. **This skill does NOT modify `power.config.json`** (that file is owned by `npx power-apps init` and its schema is controlled upstream). It also does NOT scaffold an offline runtime (SQLite store, sync engine, write queue) in the generated app — that's gated on upstream `@microsoft/power-apps-native-host` runtime support.

**Out of scope for v0**:
- Custom filter mode (`recorddistributioncriteria=3`, savedquery picker) — defer to v0.5
- User/team membership assignment — split into `/assign-offline-profile`
- Row-count download estimation — split into `/preview-offline-scope`

## Workflow

1. Verify project & auth → 2. Resolve mode (create vs extend) → 3. Spawn architect agent → **Gate 1** (table prerequisites) → 4. Run `/enable-tables-offline` if needed → 5. POST profile shell → **Gate 2** (per-table row scope) → 6. POST profile items → **Gate 3** (relationships + columns + sync) → 7. POST associations → 8. Validate + publish → 9. Persist artifacts → 10. Summary

---

### Step 1 — Verify project & auth

```bash
test -f power.config.json && test -f app.config.js
# Manifest lives at either root (legacy) or docs/plan-artifacts/ (newer scaffolds)
MANIFEST=$(test -f .datamodel-manifest.json && echo ".datamodel-manifest.json" || \
           (test -f docs/plan-artifacts/.datamodel-manifest.json && echo "docs/plan-artifacts/.datamodel-manifest.json"))
test -n "$MANIFEST" && echo "✓ manifest at $MANIFEST"
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$(node -e \"console.log(require('./power.config.json').environmentId)\")"
```

Capture **Environment URL** for `<envUrl>` and **manifest path** for the architect spawn (Step 3) and the artifacts write (Step 9).

**Web-only target detection** — Mobile Offline Profiles only apply to native targets (iOS/Android). If the project is web-only, the profile will be created in Dataverse but **the generated app will never use it**:

```bash
# Inspect platforms declared in app.config.js
node -e "
const c = require('$(pwd)/app.config.js');
const platforms = c?.expo?.platforms ?? [];
const hasNative = platforms.includes('ios') || platforms.includes('android');
console.log(JSON.stringify({ platforms, hasNative }));
" 2>/dev/null
```

| `hasNative` | Action |
|---|---|
| `true` (has `ios` and/or `android`) | Continue normally |
| `false` (web-only or no platforms) | Print: `⚠ This project only targets web — Mobile Offline Profiles don't apply (they require iOS/Android). Continuing will create the profile in Dataverse but no app will use it.` Ask via `AskUserQuestion`: "Continue anyway?" Default No. |
| Parse error / app.config.js missing key | Warn, but assume native (don't block on a parser quirk) |

STOP conditions:
- No `power.config.json` → "Run `/create-mobile-app` first."
- Neither `.datamodel-manifest.json` nor `docs/plan-artifacts/.datamodel-manifest.json` → "Run `/add-dataverse` first — offline profiles require a data model."
- Environment resolution failure → standard auth recovery (`az login --tenant <env-tenant>` or provide environment URL directly; see [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)).
- Web-only + user declines override → STOP. Print: `Offline profile creation skipped — no native target.`

#### Step 1a — Environment consistency check

Same as `/add-dataverse` Step 3a — verify `power.config.json` resolves and `az` can token for the target tenant. STOP if it cannot; user must re-auth with `az login --tenant <env-tenant>`.

#### Step 1b — Resume check

Read `memory-bank.md` `## Offline profile` block. Decide based on `status`:

| `status` value | Action |
|---|---|
| (section absent) OR `status: none` | First-time run. Continue to Step 2. |
| `status: not-applicable` | User previously opted out via `/create-mobile-app` Step 6.85 ("doesn't need offline support"). Re-confirm: "Memory-bank says this app doesn't need offline. Override and proceed? (y/N)". Default N stops here. |
| `status: done` AND a profile matching `profileId` still exists in env | Already complete. Print summary from the memory-bank block; ask user if they want to `/edit-offline-profile` (v0.2) or just exit. |
| `status: done` BUT `GET /mobileofflineprofiles(<profileId>)` returns 404 | Profile was deleted externally (maker portal or another env). Treat as `none`; clear the section; continue to Step 2. |
| `status: in-progress` AND profile exists in env | **Resume flow** — see below. |
| `status: in-progress` BUT profile doesn't exist in env | Memory-bank stale. Auto-clean: clear the section, log `recovered from stale in-progress state`, continue to Step 2 as a fresh run. |

**Resume flow** — when memory-bank has `status: in-progress` AND the profile still exists:

1. `GET /mobileofflineprofiles(<profileId>)?$expand=MobileOfflineProfile_MobileOfflineProfileItem` to compute what's actually been committed:
   - 0 items → profile shell exists, items not yet POSTed. Resume from Step 6.
   - 1+ items, missing some from manifest → resume from Step 6, skipping items already present.
   - All items present, `selectedcolumns` empty on ≥1 → resume from Step 7 (PATCH).
   - All items present, all have `selectedcolumns` → resume from Step 8 (Publish).
   - `componentstate=0` (Published) → memory-bank lies; treat as `done`.

2. Ask the user one consolidated AskUserQuestion (NOT a per-step approval):

   ```
   Resume from <computed step> on profile "<name>" (<profileId>)?

   Items already committed: <N> of <M>
   PATCHes already applied: <K>
   Published:               <yes|no>

   Options:
   - Resume from where it left off (recommended)
   - Start fresh — delete the half-built profile and re-run from Step 5
   - Cancel
   ```

3. On `Resume` → jump to the computed step. Skip already-committed items by matching `selectedentitytypecode`.
4. On `Start fresh` → `DELETE /mobileofflineprofiles(<profileId>)` (cascade-deletes items + associations), clear memory-bank section, continue to Step 2 as new.
5. On `Cancel` → STOP, leave memory-bank untouched.

**Memory-bank checkpoint contract:** the skill writes `status: in-progress` + `profileId` immediately after Step 5 (profile shell POST). Each subsequent step updates a `lastSuccessfulStep:` field so resume knows where to pick up. On `BLOCKED:` from any step, the skill leaves `status: in-progress`; on `DONE`, it writes `status: done` in Step 9c.

**Idempotency on POST retries:** if Step 6 re-POSTs an item with the same `selectedentitytypecode` against the same parent profile, Dataverse may return `409 Conflict` ("duplicate"). The wrapper `dataverse-request.js` treats this as silent success via its `looksLikeDuplicate` logic — safe to re-attempt.

### Step 2 — Resolve mode (create vs extend vs reconcile)

**Print before starting:**
> "→ Checking for existing offline profiles in the environment…"

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "mobileofflineprofiles?\$select=mobileofflineprofileid,name,description,publishedon"
```

Decision tree — evaluate in order:

| # | Condition | Action |
|---|---|---|
| 1 | Step 1b already detected `status: in-progress` in memory-bank | Resume flow (handled in Step 1b). Do not re-evaluate here. |
| 2 | `offline-profile.json` has top-level `profileId: <X>` AND profile `<X>` still exists in env | **Collision case — ASK USER.** AskUserQuestion: (a) Extend the pinned profile (re-architect against current data model + add/PATCH items as needed), (b) Delete the pinned profile and create fresh (irreversible — cascade-deletes items + associations + memberships), (c) Cancel. Default = (a) extend. NEVER silently delete. |
| 3 | `offline-profile.json` has top-level `profileId: <X>` AND profile `<X>` does NOT exist (404 from GET) | `offline-profile.json` is stale (env reset, profile manually deleted). Delete the local file, continue to row #4. |
| 4 | Any existing profile in env has `name` matching this app's name (case-insensitive substring match on `power.config.appDisplayName` or directory name) | **ASK USER.** AskUserQuestion: (a) Extend the name-matching profile, (b) Create a new profile (the name-matching one may belong to another app — your call), (c) Cancel. No default — both are legitimate. |
| 5 | Zero profiles in env | Mode = `create-new`. Continue to Step 3. |
| 6 | 1+ profiles in env but no name match + no pin | Mode = `create-new` (the env has unrelated profiles). Continue to Step 3. Print one-line note: `↷ <N> unrelated profiles exist in env; not extending — see /edit-offline-profile to manage them.` |

> **Why row #2 is critical (empirical 2026-05-25)**: the chanel-rm and FCB Tracker test runs hit this case. Without this check, the skill cascade-deleted the pinned profile silently. After this patch, the user gets a clear three-way choice and `delete` is always an explicit action.

> **Extend mode (rows #2a, #4a) implementation**: re-spawn the architect with `Mode: extend, existingProfileId: <X>`. The architect compares its current proposal to the on-server items + associations and outputs three lists: (i) items to ADD, (ii) items to PATCH (scope/columns/sync diffs), (iii) items to DELETE (in-server but not in current data model). Surface to the user at Gate 2. After approval, the skill issues incremental writes — no profile-shell POST.

### Step 3 — Spawn architect agent

**Print before starting:**
> "→ Spawning mobile-app:offline-profile-architect agent (read-only) to design the profile…"

Spawn via `Task`:

```text
agent: mobile-app:offline-profile-architect
prompt:
  Working directory: <workdir>
  Plugin root: ${PLUGIN_ROOT}
  Environment URL: <envUrl>
  Publisher prefix: <prefix>
  Mode: default
```

The agent returns `_offline_section.md` in the working directory. Read it. Parse its first-line status code:

- `DONE` → continue
- `DONE_WITH_CONCERNS: <list>` → surface concerns at Gate 2 / Gate 3 where relevant; continue
- `NEEDS_CONTEXT: <missing>` → resolve the missing context (most often: data model file absent), re-spawn once (cap: 2 retries). If still failing, STOP with the agent's reason.
- `BLOCKED: <reason>` → STOP, surface to user, do not silently retry.

### Step 3.5 — Configuration review (interactive AskUserQuestion flow)

**Print before starting:**
> "→ Presenting the proposed offline profile configuration. You'll tap an option to accept, adjust, or cancel — no need to type."

The skill renders the proposal as a one-screen summary (read-only context) and then drives the decision through structured `AskUserQuestion` prompts — the same click-style pattern `/create-mobile-app` uses for its 4 plan gates. This replaces the older "type `accept` / plain-English edits / `cancel`" reply flow, which was hit-or-miss when users typed something the parser didn't recognize.

#### Step 3.5a — Print the summary (informational only)

Substitute real values from `_offline_section.md` and the architect output:

```text
══════════════════════════════════════════════════════════════════════
 Mobile Offline Profile — Proposed Configuration
══════════════════════════════════════════════════════════════════════

PROFILE METADATA
  Name        : <proposed name>
  Description : <proposed description, or "(none)">
  Mode        : create-new | extend existing (<profileId>)

TABLE PREREQUISITES (IsAvailableOffline + ChangeTrackingEnabled)
  cr123_note   ❌/❌  → will be enabled
  cr123_visit  ✅/❌  → ChangeTracking will be enabled
  contact      ✅/✅  → no change

PER-TABLE CONFIG

  ▸ cr123_note (Organization rows, User's rows)
      Sync     : every 10 min
      Columns  : 12 (cr123_title, cr123_body, cr123_visitid, …, modifiedon, createdon)

  ▸ cr123_visit (Related rows only)
      Sync     : every 10 min
      Columns  : 8 (cr123_name, cr123_date, …, modifiedon)

  ▸ contact (All records)
      Sync     : every 60 min
      Columns  : 5 (fullname, emailaddress1, …, modifiedon)

RELATIONSHIPS (will be POSTed as mobileofflineprofileitemassociation rows)
  cr123_note   → cr123_note_visit   (links to cr123_visit)
  cr123_note   → cr123_note_image   (includes image bytes)
══════════════════════════════════════════════════════════════════════
```

No prompt is shown alongside this text — it's informational context, immediately followed by the interactive prompt below.

#### Step 3.5b — Top-level decision (single `AskUserQuestion`)

```text
header   : Offline profile
question : "Accept the proposed offline profile configuration and publish to Dataverse?"
options  :
  - Accept and publish (Recommended)
  - Adjust before publishing
  - Cancel — abort, nothing is mutated
```

Outcomes:

| User picks | Action |
|---|---|
| **Accept and publish** | Write memory bank checkpoint (see below), continue to Step 4 (enable prereqs if needed) → Step 5 (POST shell) → Step 6 (POST items) → Step 7 (PATCH selectedcolumns) → Step 8 (publish) → Step 9 (persist) → Step 9.5 (verify) → Step 10 (summary). **No further prompts** unless something fails. |
| **Cancel** | STOP. No Dataverse mutations. No artifacts written. Update `memory-bank.md` with `status: cancelled-at-config-review`. |
| **Adjust before publishing** | Continue to Step 3.5c. |

#### Step 3.5c — Pick the areas to adjust (single `AskUserQuestion`, multiSelect)

```text
header     : Adjust which
question   : "Which sections of the proposal do you want to change?"
multiSelect: true
options    :
  - Profile name or description
  - Per-table row scope (who's rows get synced)
  - Per-table sync interval
  - Per-table column selection
```

Whatever the user picks drives Step 3.5d. If they pick nothing (closing the dialog), treat that as a no-op and loop back to Step 3.5b.

#### Step 3.5d — Drill-down per area

For each area the user picked in 3.5c, run the corresponding sub-flow. Apply edits to an in-memory config copy as you go; nothing hits Dataverse until Step 3.5e.

**Profile name or description** — text prompt (free-form input, no enumeration possible):

> "Type the new profile name, or `skip` to keep `<current name>`."
>
> Then: "Type the new description, or `skip` to keep `<current description>`."

Validate name ≤ 100 chars; trim whitespace; reject empty.

**Per-table row scope** — one `AskUserQuestion` per table (batch up to 4 tables per call; 5+ tables → multiple calls):

```text
header   : Scope <table>
question : "Row scope for `<table-logical-name>`?"
options  :
  - Related rows only (child of a parent table; default for pure children)
  - All records (default for shared catalogs like product / contact)
  - User's own rows (Organization-scoped + recordsownedbyme=true; default for personal transactional data)
  - Organization's rows (Organization-scoped, all owners — broadest non-All)
```

Map answers → `recordDistributionCriteria` (0=Related, 1=All, 2=Organization) + the `recordsownedby*` sub-flags. If the user picks "User's own rows" set `recordsownedbyme=true`; if "Organization's rows" leave all three sub-flags false.

**Per-table sync interval** — one `AskUserQuestion` per table:

```text
header   : Sync <table>
question : "How often should `<table-logical-name>` sync?"
options  :
  - Every 5 min — hot transactional data (Recommended for tables users edit live)
  - Every 15 min — typical
  - Every 30 min — slower-moving
  - Every 60 min — static catalogs (lowest battery cost)
```

(Range is 5–1440 min server-side; custom values outside these four come via the `Other` free-text option that `AskUserQuestion` always provides — validate 5 ≤ N ≤ 1440.)

**Per-table column selection** — text fallback (column lists are too varied for multi-choice):

> "For `<table>`, type column changes one per line:
>   `exclude <column>` to drop a column from sync
>   `include <column>` to add one that's currently excluded
>   `all` to reset to every column from the manifest
>   `skip` to leave columns unchanged"

Validate every named column exists in `.datamodel-manifest.json`; reject typos with the closest-match column suggestion.

#### Step 3.5e — Re-confirm

After all picked sub-flows complete, **re-render the summary** (Step 3.5a format) with the changed rows marked `→ updated` in a different colour or with a leading `*`. Then re-run Step 3.5b — same three-option `AskUserQuestion`. The user can adjust again, accept, or cancel.

This loop is bounded by user patience, not a hard limit. If they pick "Adjust" repeatedly without ever choosing "Accept" or "Cancel", that's their prerogative — every loop is reversible and nothing has hit Dataverse yet.

#### Step 3.5f — Memory bank checkpoint (after `Accept and publish`)

```yaml
## Offline profile
status: in-progress
profileName: <name>
mode: create-new | extend
configReview: accepted
```

> **Design rationale.** The original Step 3.5 used free-text replies ("type `accept` or describe edits in English") to keep things conversational. In practice users typed responses the regex parsers didn't recognise — `change scope of contact to teamonly`, `set sync to 10`, etc. — and the skill either silently dropped the edit or asked a clarifying question that drove additional confusion. The `AskUserQuestion` flow above eliminates parsing risk for the enumerable fields (scope, sync interval, top-level decision) while preserving the free-text path for the genuinely free-form fields (name, description, column lists). Net result: zero ambiguous interactions for the common adjustments, fewer typing-induced errors, parity with `/create-mobile-app`'s plan-gate UX.

### Step 4 — Run `/enable-tables-offline` if needed

If Gate 1 identified any table needing change, invoke `/enable-tables-offline` as a sub-skill with the list:

```text
/enable-tables-offline cr123_note,cr123_visit
```

Wait for it to return. Expected final line: `DONE` or `DONE_WITH_CONCERNS:`.

If `BLOCKED`, propagate the block up — STOP.

If all tables were already enabled, skip this step.

### Step 5 — POST profile shell

**Print before starting:**
> "→ Creating MobileOfflineProfile record (Name + Description only)…"

For `create-new` mode:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "mobileofflineprofiles" \
  --body '{
    "name": "<app name> Offline Profile",
    "description": "<auto-generated description referencing app name + scope summary>"
  }' \
  --include-headers
```

Capture `mobileofflineprofileid` from the `OData-EntityId` response header (matches the pattern in `/add-dataverse` Step 5b).

For `extend` mode: re-use the existing `mobileofflineprofileid` from Step 2.

Write to `memory-bank.md`:

```yaml
## Offline profile
status: in-progress
profileId: <guid>
profileName: <name>
mode: create-new | extend
gate1: approved
```

### (Gate 2 — REMOVED, consolidated into Step 3.5)

### Step 6 — POST profile items

**Print before starting:**
> "→ Creating <N> MobileOfflineProfileItem records (one per table, sequential)…"

> **⚠️ Concurrency rule.** Profile items reference each other implicitly via the parent profile. Issue POSTs sequentially, one at a time. The mobileofflineprofileitem entity does NOT hold the metadata lock that EntityMetadata does, but the validation pass on each POST reads neighboring items — parallel POSTs occasionally return 412 PreconditionFailed. Sequential is the safe path.

For each table, in sequence:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "mobileofflineprofileitems" \
  --body '{
    "name": "<table display name>",
    "regardingobjectid@odata.bind": "/mobileofflineprofiles(<profileId>)",
    "selectedentitytypecode": "<table-logicalname>",
    "recorddistributioncriteria": <0|1|2>,
    "recordsownedbyme": <bool>,
    "recordsownedbymyteam": <bool>,
    "recordsownedbymybusinessunit": <bool>,
    "getrelatedentityrecords": true,
    "syncintervalinminutes": 10
  }' \
  --include-headers
```

Capture each `mobileofflineprofileitemid` from the response header. Store in a local map `tableLogicalName → itemId` — needed for Step 7 (associations) and Step 9 (offline-profile.json).

`selectedcolumns` is NOT set here — added at Gate 3 / Step 7 once the user confirms the column subset.

Print `✓ <table>` after each 2xx.

### (Gate 3 — REMOVED, consolidated into Step 3.5)

### Step 7 — POST associations + PATCH selectedcolumns

**Print before starting:**
> "→ Creating association rows + PATCHing selectedcolumns on each profile item…"

#### Step 7a — POST `mobileofflineprofileitemassociation` rows

Empirical 2026-05-24 + 2026-05-25 capture from maker portal **unblocked** association creation. Recipe (no `selectedrelationshipsschema` field — server fills it):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "mobileofflineprofileitemassociations" \
  --body '{
    "name": "<relationshipSchemaName>",
    "relationshipdisplayname": "<relationshipSchemaName>",
    "relationshipid": "<MetadataId-of-1:N-relationship-from-architect>",
    "regardingobjectid@odata.bind": "/mobileofflineprofileitems(<PARENT-item-id>)"
  }' \
  --include-headers
```

> **⚠️ Critical direction rule.** `regardingobjectid` is the **parent (1-side)** profile item. For an `account → orderline` 1:N relationship, the association lives on the `account` profile item with the relationship `account_orderline` (read from `EntityDefinitions(LogicalName='account')/OneToManyRelationships`). POSTing on the `orderline` (child) side fails `PublishXml` with `0x80071140 — no relationships are specified for this Related-only table`. This is the canonical bug — architect's Step 5 now explicitly walks parents' `OneToManyRelationships` to produce parent-keyed output.

For each (PARENT-item, 1:N-relationship-to-child) pair from the architect's proposal:

1. Resolve `relationshipid` (MetadataId GUID) via `EntityDefinitions(LogicalName='<PARENT-table>')/OneToManyRelationships` filtering by `SchemaName === <relationshipSchemaName>`. Cache the lookup per parent table.
2. POST the association (sequential — parallel POSTs occasionally return 412 PreconditionFailed).
3. Capture the new `mobileofflineprofileitemassociationid` from the `OData-EntityId` response header.

> **Skip-when-redundant rule.** If the parent profile item has `recorddistributioncriteria=1` (All records), the architect should have pruned associations on it (per Step 5 pruning rule). Defensively: if any propagate through, SKIP them at POST time. Print: `↷ Skipping <association> on All-records parent <table> — redundant, all rows download anyway`.

> **Pre-publish cycle detection.** Before Step 8 publish, build the relationship graph from the just-created associations and DFS for cycles. If a cycle exists (e.g. `account → task → account`), prompt the user to remove ONE association and re-do this step for the affected pair — otherwise Step 8 will return `0x80071141`. See [shared/references/dataverse-offline-api.md §6b](${CLAUDE_SKILL_DIR}/../../shared/references/dataverse-offline-api.md).

> **Idempotency.** Re-POSTing an existing (item, relationship) pair returns `409 Conflict`; the `dataverse-request.js` `looksLikeDuplicate` rescue treats this as success. Re-runs after a partial failure are safe.

Skip Step 7a entirely if the architect's proposal includes zero relationships (rare — usually fixture-grade single-table profiles).

#### Step 7b — PATCH `selectedcolumns` on each item

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> PATCH \
  "mobileofflineprofileitems(<itemId>)" \
  --body '{
    "selectedcolumns": "<JSON string — see below>"
  }'
```

`selectedcolumns` shape (verified by inspecting an existing profile created by maker portal — see [§10 known blocker in plan](#) for caveat):

```json
{
  "Columns": ["cr123_title","cr123_body","cr123_visitid","modifiedon","createdon","statecode"]
}
```

Wrap as a stringified JSON in the memo field.

If syncintervalinminutes was edited at Gate 3, include it in the same PATCH.

### Step 8 — Publish

**Print before starting:**
> "→ Publishing profile (targeted PublishXml)…"

> **Validate step intentionally skipped.** Empirical 2026-05-17: the `Validate` action's documented body shape is rejected by the server. The maker portal does NOT call Validate either (confirmed via 2026-05-24 capture) — publish-time validation runs server-side as part of PublishXml. `isvalidated=true` is set by the publish call itself, not by a separate Validate.

**Targeted PublishXml — the maker portal's pattern** (empirical 2026-05-24):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "PublishXml" --body '{
    "ParameterXml": "<publish><mobileofflineprofiles><mobileofflineprofile>'"$PROFILE_ID"'</mobileofflineprofile></mobileofflineprofiles></publish>"
  }'
```

Publishes ONLY this profile, not the entire org's customizations. Empirically much faster + less rate-limit-prone than `PublishAllXml` on shared envs.

**On `400 / 0x80071141` "circular relationship":** the profile's association graph has a cycle (e.g. `account → task → account`). Parse the path from the error message, prompt the user to drop ONE of the offending associations, re-DELETE that association row via DELETE `/mobileofflineprofileitemassociations(<id>)`, then re-attempt publish. See [shared/references/dataverse-offline-api.md §6b](${CLAUDE_SKILL_DIR}/../../shared/references/dataverse-offline-api.md).

**On `400 / 0x80071140` "no relationships are specified" for a Related-only table:** a profile item has `recorddistributioncriteria=0` but no associations point at it. Parse the table name from the error message and prompt the user with two choices:
1. `/add-table-to-offline-profile --table <name> --add-associations` — re-runs the architect for relationship discovery, POSTs missing associations.
2. `/edit-offline-profile --table <name> --scope 2 --me` — changes scope to Organization rows + User's rows (the architect's fallback).

For fresh `/setup-offline-profile` runs this error should never fire because Step 7a POSTs associations before Step 8 publish. But it CAN fire on retrofit scenarios where a profile published under v0.1's old "no associations" recipe is later edited — Dataverse's publish-validator appears to compare against the previously-published snapshot, not the current uncommitted state. Empirically observed 2026-05-24 on chanel-rm.

**Fallback — `PublishAllXml`:** if the targeted publish fails with anything other than the circular-relationship error, try the broad publish. This was the v0.1 default and works correctly but rate-limits aggressively on shared envs:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "PublishAllXml" --body '{}'
```

**Handle the timeout-but-success pattern** — empirically observed on shared envs (CRM527116 + chanel-rm demos): `PublishAllXml` triggers a 4-retry 429 backoff, `dataverse-request.js` times out client-side after ~2 min, but the publish **DID** commit server-side. The targeted `PublishXml` should avoid this in most cases, but the fallback path still needs to handle it.

Protocol after the POST call returns:

1. If status `204` → publish succeeded, continue.
2. If status `0` AND error contains `Request timed out` OR `429 rate-limited` → DO NOT treat as failure. Run the verification GET below:

   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
     "mobileofflineprofiles(<profileId>)?\$select=componentstate,publishedon" 2>&1
   ```

   - `componentstate == 0` AND `publishedon` is a non-null ISO8601 timestamp within the last 5 minutes → treat as success. Print: `↷ PublishAllXml client timed out but committed server-side (componentstate=0, publishedon=<ts>).` Continue.
   - `componentstate == 1` (Unpublished) → publish genuinely didn't land. Retry once with a 30s pre-wait (let any in-flight env publishes drain). On second failure, return `DONE_WITH_CONCERNS: publish timed out twice; profile saved but unpublished — re-run /setup-offline-profile or PublishAllXml manually`.

3. If status is any other non-204 → return `BLOCKED: publish failed with <status>`.

After confirmed success, re-GET the profile and check `publishedon` for the artifacts step.

### Step 9 — Persist artifacts

**Print before starting:**
> "→ Writing offline-profile.json + memory-bank.md…"

> **Important: this skill must NOT modify `power.config.json`.** That file is owned by `npx power-apps init` and its schema is controlled by the upstream tool — adding custom fields there risks being overwritten on re-init and breaks when the upstream schema changes. All app-level offline config goes into `offline-profile.json` (which we own) under an `appConfig` block.

9a — Write `offline-profile.json` to the project root. **Canonical schema** (must match `scripts/verify-offline-profile.js`'s expectations; the script compares associations by `relationshipId`):

```json
{
  "profileId": "<guid>",
  "name": "<name>",
  "publishedOn": "<iso8601>",
  "mode": "create-new | extend",
  "appConfig": {
    "enabled": true,
    "serverRowLimit": 2000,
    "/* BEGIN OFFLINE-CONFIG-WORKAROUND */": "remove when SDK gaps are fixed upstream — tracked in pa-wrap-tools (instanceUrl) + PowerApps-Client (useDda + entitiesIncluded). Bracket exists so the future cleanup diff is mechanical.",
    "useDda": false,
    "entitiesIncluded": ["<logicalName-1>", "<logicalName-2>", "..."],
    "instanceUrl": "<envUrl>",
    "/* END OFFLINE-CONFIG-WORKAROUND */": ""
  },
  "tables": [
    {
      "logicalName": "cr123_order",
      "itemId": "<guid>",
      "recordDistributionCriteria": 2,
      "recordsOwnedByMe": true,
      "recordsOwnedByMyTeam": false,
      "recordsOwnedByMyBusinessUnit": false,
      "syncIntervalInMinutes": 10,
      "selectedColumns": ["cr123_ordernumber", "cr123_total", "..."],
      "relationships": [
        {
          "schemaName": "cr123_order_cr123_orderline",
          "relationshipId": "<MetadataId-guid-of-the-1:N-relationship>",
          "targetEntity": "cr123_orderline",
          "associationId": "<mobileofflineprofileitemassociationid-guid>"
        }
      ]
    }
  ]
}
```

**Schema invariants** (enforced by the verify script):
- `profileId` is the source of truth for the published `mobileofflineprofileid` — runtime + `/edit-offline-profile` + `/assign-offline-profile` read it from here. **Do NOT also write it to `power.config.json`.**
- `appConfig` carries every app-level offline setting the runtime consumes at boot. The three `OFFLINE-CONFIG-WORKAROUND`-bracketed fields are temporary and tracked for upstream removal — keep them contiguous so a future `git diff` showing the cleanup is scoped to that block.
- `relationships[]` lives on the **PARENT** table entry (the table on the 1-side of the 1:N relationship). Pure-child tables (e.g. `cr123_orderline`) have empty `relationships: []`.
- Each `relationships[]` entry has `schemaName` (the relationship's `SchemaName` from EntityDefinitions metadata), `relationshipId` (the relationship's `MetadataId` GUID — **this is the canonical comparison key**, stable across server-side relationshipname formatting), `targetEntity` (child entity logical name), and `associationId` (the created `mobileofflineprofileitemassociationid`).
- `recordDistributionCriteria=1` (All records) parents always have `relationships: []` — associations would be redundant (see architect Step 5 pruning rule).
- JSON doesn't support comments — the `/* BEGIN/END OFFLINE-CONFIG-WORKAROUND */` keys above are illustrative bracketing for the SKILL author. **Do NOT write those literal keys to `offline-profile.json`.** When the skill actually patches the file, emit only the real fields (`useDda`, `entitiesIncluded`, `instanceUrl`) inside `appConfig` and keep them contiguous.

Example node script (writes the file in one shot — no read-modify-write against `power.config.json`):

```bash
node -e '
  const fs = require("fs");

  // Genuine app-level offline config (always written)
  const appConfig = {
    enabled: true,
    serverRowLimit: 2000,
  };

  // BEGIN OFFLINE-CONFIG-WORKAROUND (remove when underlying SDK gaps are fixed
  // upstream — tracked separately in pa-wrap-tools and PowerApps-Client).
  appConfig.useDda = false;
  appConfig.entitiesIncluded = [/* logicalName for each table in the profile */];
  appConfig.instanceUrl = "<envUrl>";
  // END OFFLINE-CONFIG-WORKAROUND

  const profile = {
    profileId: "<guid-from-step-5>",
    name: "<name>",
    publishedOn: "<iso8601>",
    mode: "create-new", // or "extend"
    appConfig,
    tables: [/* one entry per profile item — see schema above */],
  };

  fs.writeFileSync("offline-profile.json", JSON.stringify(profile, null, 2) + "\n");
'
```

Field rationale:

| Field | Layer | Why |
|---|---|---|
| `profileId` | A (genuine) | The published `mobileofflineprofileid` from Dataverse — runtime fetches this profile's manifest. `offline-profile.json` is the single source of truth for this value. |
| `appConfig.enabled` | A (genuine) | Marks the project as offline-enabled; consumed by runtime at boot. |
| `appConfig.serverRowLimit` | A (genuine) | Mirrors Image 2's "Data row limit" field (2000 default). For v0 it's a config-only value — runtime enforcement is a Layer B concern. |
| `appConfig.useDda` | **OFFLINE-CONFIG-WORKAROUND** | Forces the SDK off its broken `shouldUseDda` gate (entity-set vs logical-name mismatch). Remove when that gate is reconciled in `@microsoft/react-native-dataverse-offline` (tracked in PowerApps-Client). |
| `appConfig.entitiesIncluded` | **OFFLINE-CONFIG-WORKAROUND** | The SDK's offline bootstrap reads this list to know which entity logical names participate in the profile. Currently required because the SDK doesn't derive it from the published profile manifest at runtime. Populate with one logical name per table in the profile (i.e. the `logicalName` field of each `tables[]` entry below). |
| `appConfig.instanceUrl` | **OFFLINE-CONFIG-WORKAROUND** | Enables offline cold-start by giving the SDK a static org name without needing an `api.powerplatform.com` round-trip while offline. Value is the same `<envUrl>` captured in Step 1 (e.g. `https://orgXXX.crm.dynamics.com`). Was previously written into `power.config.json.databaseReferences[*].databaseDetails.linkedEnvironmentMetadata.instanceUrl`; runtime now reads from `appConfig.instanceUrl` here. Tracked upstream in pa-wrap-tools. |

> **Do NOT touch `power.config.json` from this skill.** Earlier drafts wrote the same fields into `power.config.json.offline.*` and `databaseReferences[*].databaseDetails.linkedEnvironmentMetadata.instanceUrl`. That was reverted because `power.config.json` is generated by `npx power-apps init`, whose schema we don't control — adding custom fields there means re-init can wipe them and upstream schema changes can break this skill. If you find a code path here that still mutates `power.config.json`, treat it as a bug.

9c — Update `memory-bank.md` `## Offline profile`:

```yaml
status: done
profileId: <guid>
profileName: <name>
mode: create-new | extend
publishedOn: <iso8601>
gate1: approved
gate2: approved
gate3: approved
tablesCount: <N>
associationsCount: <M>
```

9d — Append a `## Offline Profile` section to `native-app-plan.md` summarizing the final state (mirrors the data-model section pattern).

### Step 9.5 — Verify

**Print before starting:**
> "→ Verifying the on-server profile matches offline-profile.json…"

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/verify-offline-profile.js" <envUrl>
```

Read the JSON output:

| `status` | Action |
|---|---|
| `ok` | All checks passed. Continue to Step 10. |
| `drift` | Surface the `drift[]` array to the user. The most common drift after a fresh creation is `unpublished` (publish race) — re-run §9 publish once and re-verify. Other drift types indicate a serious bug; do NOT silently mask — return `DONE_WITH_CONCERNS` listing every drift entry. |
| `missing` | `offline-profile.json` wasn't written. Step 9a failed silently — STOP and ask user to re-run. |
| `error` | Auth or network — surface and STOP. |

The verify script is also the canonical implementation behind `/preview-offline-scope` (v0.2) — keeping it as a step here means it's exercised on every fresh creation.

### Step 10 — Summary

Print:

```text
✓ Mobile Offline Profile created.

  Profile name : <name>
  Profile ID   : <guid>
  Tables       : <N> (<M> required prereq enablement)
  Relationships: <K> associations
  Published    : <iso8601>

Saved to project:
  - offline-profile.json  (profile metadata + appConfig + tables)
  - memory-bank.md        (## Offline profile section)
  - native-app-plan.md    (## Offline Profile section)

Note: power.config.json was NOT modified (owned by npx power-apps init).

Next steps:
  - /assign-offline-profile        → assign users / teams to this profile (not yet implemented — v0.3)
  - /preview-offline-scope         → estimate download size before pushing the app (not yet implemented — v0.2)
  - /edit-offline-profile <table>  → re-scope one table (not yet implemented — v0.2)

Note: The Expo runtime does not yet consume this profile automatically. The profile is now
authored in Dataverse and any compatible Power Apps client (canvas, model-driven) will use it.
Native runtime support remains deferred until upstream host support is confirmed.
```

## Status code (final line)

- `DONE` — profile created and published, artifacts written
- `DONE_WITH_CONCERNS: <list>` — created but with caveats (validate skipped, some columns flagged, some tables uncustomizable)
- `NEEDS_CONTEXT: <missing>` — data model missing, env URL unresolvable, etc.
- `BLOCKED: <reason>` — auth failed, PrivilegeCheckFailed, env URL unreachable, or sub-skill `/enable-tables-offline` returned BLOCKED

## Failure recovery

Every step writes a checkpoint to `memory-bank.md`. On failure mid-flow:

| Failure at | Recovery |
|---|---|
| Gate 1 / Step 4 | Re-run `/setup-offline-profile` — Step 1b resume kicks in |
| Step 5 | Soft-delete partial profile, retry from Step 5 |
| Step 6 (item N of M) | Resume from item N+1; previous items already committed |
| Step 7 (associations) | Resume — associations are additive, re-POSTing existing pairs returns 409 (ignore) |
| Step 8 (publish) | Re-run publish; profile is functional without it, but won't appear in maker portal |

Never leave a profile half-committed in `memory-bank.md` with `status: in-progress` past a session — the next session's Step 1b will prompt to resume or delete it.
