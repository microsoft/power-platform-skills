---
name: preview-offline-scope
description: Use when the user wants to estimate the download size + sync frequency cost of an offline profile BEFORE pushing to users. Read-only. Wraps verify-offline-profile.js with per-table row-count estimates.
user-invocable: false
allowed-tools: Read, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

# Preview Offline Scope

Read-only diagnostic. Tells you "if you pushed this profile to users right now, here's what their devices would download and how often it would re-sync." No mutations.

Useful before:
- `/setup-offline-profile` for a final sanity check
- `/assign-offline-profile` (so users don't get surprised by data caps)
- `/edit-offline-profile` to gauge impact of a column-list change

## Workflow

1. Verify project + locate profile → 2. Run verify (drift check) → 3. Per-table row counts → 4. Cache-size estimate → 5. Report

---

### Step 1 — Verify project + locate profile

Same as `/edit-offline-profile` Step 1. Read profileId from `offline-profile.json` or `$ARGUMENTS --profile-id`. Do not read profile metadata from `power.config.json`; it is owned by `npx power-apps init`.

```bash
test -f power.config.json
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$(node -e \"console.log(require('./power.config.json').environmentId)\")"
```

### Step 2 — Run verify

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/verify-offline-profile.js" <envUrl> \
  --project-root "$(pwd)"
```

If `status: drift`, surface the drift list verbatim. The estimate that follows is still meaningful but flag that the live profile diverges from `offline-profile.json` — recommend re-running `/setup-offline-profile` or `/edit-offline-profile` to reconcile.

### Step 3 — Per-table row counts (with scope-applied filter)

For each table in the profile, run a `count` query that applies the same filter the runtime would use:

| `recorddistributioncriteria` | `recordsownedby*` flag | Effective filter |
|---|---|---|
| 1 (All records) | n/a | `?$count=true&$top=0` (whole table) |
| 2 + me | recordsownedbyme=true | `?$count=true&$top=0&$filter=_ownerid_value eq <current-user-id>` |
| 2 + team | recordsownedbymyteam=true | Approx: `_ownerid_value` in (current user's team-owned IDs); for estimate, use team count from `teamroles_association` |
| 2 + bu | recordsownedbymybusinessunit=true | `?$count=true&$top=0&$filter=_owningbusinessunit_value eq <current-bu-id>` |
| 0 (Related only) | n/a | Can't estimate independently — depends on parents. Report `~depends on parent counts`. |

For current-user/current-BU filters, resolve identity only inside this skill by calling Dataverse `WhoAmI` through `scripts/dataverse-request.js` against the resolved `<envUrl>`. If that call fails, report the affected scope as `unknown — current user/BU unavailable` instead of blocking the whole preview. Do not expect `scripts/resolve-environment.js` or `auth.config.json.environment` to provide `UserId` / `BusinessUnitId`.

For each table:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "<entitysetname>?\$count=true&\$top=0&<scope-filter>"
```

Cap at 5000 (Dataverse non-aggregate count cap). When the result is exactly 5000, prefix with `≥` in the report.

### Step 4 — Cache-size estimate

Rough byte-per-row heuristics (configurable; replace with measured values once we have a real sync benchmark):

| Column type | Bytes |
|---|---|
| Uniqueidentifier | 40 |
| String (avg 80 chars) | 100 |
| Integer / Decimal | 12 |
| DateTime | 28 |
| Boolean / State / Status | 4 |
| Picklist (option value only) | 8 |
| Memo (avg 500 chars) | 600 |
| Lookup (FK only) | 40 |
| Image (URL + thumbnail metadata only — see note below for full-image bytes) | 200 |
| File (URL + name metadata) | 200 |

For each table, compute: `estimatedBytesPerRow = sum(bytesForEach column in selectedcolumns)`. Then `tableTotalBytes = rows × estimatedBytesPerRow`.

Per-table sync overhead: each `syncintervalinminutes` interval triggers a delta query → assume ~20% of total rows touched on a typical day. `dailyTransferBytes = (totalBytes × 0.20 × intervalsPerDay)`.

### Step 5 — Report

```
═════════════════════════════════════════════════════════════
  Offline Scope Preview — <profileName>
═════════════════════════════════════════════════════════════

Drift status: ok | drift (see verify output)

Per-table breakdown:

| Table              | Scope          | Rows     | Cols | Est. bytes | Sync (min) |
|--------------------|----------------|----------|------|------------|------------|
| chnl_region        | All records    | 12       | 7    | 4 KB       | 60         |
| chnl_product       | All records    | 312      | 13   | 280 KB     | 60         |
| chnl_rmprofile     | Org+me         | 1        | 10   | 1 KB       | 10         |
| chnl_store         | Org+me         | 84       | 17   | 112 KB     | 10         |
| chnl_storevisit    | Org+me         | 412      | 13   | 220 KB     | 5          |
| chnl_order         | Org+me         | 156      | 14   | 95 KB      | 10         |
| chnl_orderline     | Related only   | ~depends | 11   | ~150 KB    | 10         |

Total initial download : ~860 KB (5000-rows cap not hit)
Daily transfer estimate: ~12 MB / device / day (assuming 20% delta rate)

Sync intervals per day:
  chnl_storevisit (5 min)  → 288 syncs/day  ⚠ high
  chnl_store      (10 min) → 144 syncs/day
  chnl_order      (10 min) → 144 syncs/day
  chnl_rmprofile  (10 min) → 144 syncs/day
  chnl_region     (60 min) → 24  syncs/day
  chnl_product    (60 min) → 24  syncs/day

Concerns:
  - chnl_storevisit at 5 min could exceed mobile data caps in low-signal areas
    (battery drain too). Consider 10 min unless 5 min is mission-critical.

Image / File bytes NOT counted by these heuristics. The metadata (URL +
thumbnail size) IS counted at 200 bytes/row, but the JPEG/file payload
itself transfers separately at runtime sync time. To estimate image
storage, multiply expected non-empty image rows × average JPEG size
(typically 10–500 KB per thumbnail).
```

## Status code (final line)

- `DONE` — estimate produced, no concerns
- `DONE_WITH_CONCERNS: <list>` — estimate produced but flagged items (high sync rates, near-cap row counts, drift detected, etc.)
- `NEEDS_CONTEXT: <missing>` — no profile to estimate against
- `BLOCKED: <reason>` — auth or query failures

## Notes

This skill is intentionally **estimate-grade, not precise**. The byte heuristics are rule-of-thumb; real cache size depends on Dataverse's storage layout + JSON serialization + per-device cache compression. The numbers are useful for **comparative** decisions (one scope vs another, one column list vs another), not for absolute capacity planning.

For precise figures, the only source of truth is the runtime sync log itself — only available once the app is deployed and an RM has signed in.
