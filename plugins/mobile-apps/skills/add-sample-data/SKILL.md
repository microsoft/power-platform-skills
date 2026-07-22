---
name: add-sample-data
description: Use when the user wants to seed Dataverse tables with realistic sample records so a freshly-scaffolded code app shows real-looking data on first launch. Generates contextually appropriate rows from each table's schema and inserts them in dependency order. Mirrors microsoft/power-platform-skills/power-pages/add-sample-data, adapted for mobile apps.
pps.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

# Add Sample Data

Populate Dataverse tables with realistic sample records so a freshly-scaffolded code app shows real-looking data on first launch. Generates rows from each table's schema and inserts them in dependency order. Use after `/add-dataverse` (or `/setup-datamodel`) has created the tables.

## Core principles

- **Coverage over volume — every table in the manifest gets seeded.** The #1 failure mode of a freshly-scaffolded code app is a home / dashboard / list screen that renders an empty state on first launch because its source table has zero rows. An empty downstream table is **worse than a 3-row table.** Default to minimal-but-complete: small counts everywhere, no table left empty. Volume is a secondary knob — coverage is the contract.
- **Insertion order matters.** Parent / referenced tables must be inserted before child / referencing tables so lookup IDs are available.
- **Contextual data, not Lorem Ipsum.** Generate values that match column names + types. A `cr3e9_sitename` column in an inspection app gets "Westside Construction Site", not "Sample Name 1".
- **Scenario-aware rows.** Read `native-app-plan.md` and, when present, `### Shared Conventions` / `Scenario archetype` from [power-apps-scenario-archetypes.md](${CLAUDE_SKILL_DIR}/../../shared/references/power-apps-scenario-archetypes.md). Seed rows should exercise the app's actual workflow: statuses, dates, relationships, priority/severity, media metadata, and edge cases that make the planned first viewport light up.
- **Fail gracefully.** On insertion failure, log the error and continue with remaining records — never auto-rollback. The user can re-run after fixing the issue.
- **Idempotent re-runs.** If a previous run partially completed, the second run reads `memory-bank.md`'s seeded-data table and skips records already inserted.
- **Solution-scoped inserts.** Always pass `--solution <uniqueName>` so records land in our solution, not the default.

## Workflow

1. Verify project + auth → 2. Discover tables → 3. Select tables + count → 4. Generate + preview → 5. Insert → 6. Summary

## Prototype Seed Reuse

`--from-seed` is used by `/prototype-to-real-app` after a mock prototype is converted to Dataverse. In this mode, prefer existing prototype seed files before generating new rows:

```text
src/generated/services/*/*.seed.json
src/generated/services/*.seed.json
```

Map seed objects to Dataverse payloads using `.datamodel-manifest.json`:

- Keep values only for real manifest columns.
- Translate lookup references into exact `<schemaName>@odata.bind` keys from the manifest.
- Keep picklist integers from the manifest; do not invent values from labels.
- Skip local-only prototype fields that have no Dataverse column.
- Preserve dependency-tier insertion order.

If a seed file cannot be mapped safely, fall back to generated contextual sample rows for that table and record `DONE_WITH_CONCERNS` in the summary. `--from-seed` is a preference, not permission to insert malformed data.

---

### Step 1 — Verify project & auth

```bash
test -f power.config.json && test -f app.config.js
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$(node -e \"console.log(require('./power.config.json').environmentId)\")"
```

Capture the **environment URL** for subsequent script calls. If resolution fails, instruct `az login --tenant <env-tenant>` or ask for the environment URL directly, then stop.

Verify Azure CLI auth (the script needs an Azure CLI token):

```bash
az account show --query "user.name" -o tsv
```

If empty, instruct `az login` and stop.

### Step 2 — Discover tables

#### Step 2a — Path A: read `.datamodel-manifest.json` (preferred)

```bash
test -f .datamodel-manifest.json
```

If present, parse the JSON. It already contains `logicalName`, `displayName`, `status` (`new` / `extended` / `reused`), and `columns` for every table the project uses. **This is the preferred path** — fast, no API calls.

```bash
cat .datamodel-manifest.json | jq '.tables[] | { logicalName, displayName, columnCount: (.columns | length) }'
```

Skip Step 2b.

#### Step 2b — Path B: query OData (fallback)

If `.datamodel-manifest.json` is missing, discover custom tables via the script:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions?\$select=LogicalName,DisplayName,EntitySetName&\$filter=IsCustomEntity eq true"
```

For each table the project uses, fetch its custom columns:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions(LogicalName='<table>')/Attributes?\$select=LogicalName,DisplayName,AttributeType,RequiredLevel&\$filter=IsCustomAttribute eq true"
```

Build the same `{ logicalName, displayName, columns: [...] }` shape the manifest provides.

### Step 3 — Select tables + count

All tables from the manifest are evaluated — including reused ones — because a mobile app that surfaces data from a shared table still needs rows to render on first launch. The only exception is standard system tables (e.g. `contact`, `account`, `systemuser`) where seeding is risky in shared production environments.

**Pre-seeding row-count check (HARD — runs for every table before generating any rows):**

For each table, query its current record count using the entity set name from the manifest (or derive it by appending `s` to the logical name as a fallback):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "<entitySetName>?\$top=5&\$select=<primaryKeyColumn>"
```

Count the rows returned in the `value` array.

| Existing record count | Action |
|---|---|
| **≥5** | **Skip this table entirely.** Log: `↷ <table> (≥5 records exist, skipping)`. Do not generate or insert any rows. |
| **<5** | Seed enough new rows to reach the per-class target count. If some records already exist (e.g. 2), generate only the gap (e.g. 3 more to reach 5). |

If all tables already have ≥5 records, print `→ All tables already have ≥5 records. Nothing to seed.` and stop.

**Per-table count by class** (classify each table from manifest signals before generating; this beats a uniform `5` because reference tables don't need volume and transactional tables need state spread):

  | Class | Heuristic | Default count | Rationale |
  |---|---|---|---|
  | **Reference** | No `status` / `state` column; columns are descriptive (name, address, phone). Often Tier 0. | **3** | Stores, customers, sites, products. Small stable set. |
  | **Junction** | Two-or-more lookups, no other meaningful columns. Often Tier 1. | **3 × parent count, capped at 9** | Store-Assignment, Project-User. Needs to span the join. |
  | **Transactional** | Has a `status` / `state` / `phase` choice column AND a date column (`createdon`, `submittedat`, `completedat`). | **5** | Audits, inspections, orders, tickets. Need state mix to make tiles light up. |
  | **Detail / line-item** | Lookup back to a transactional parent, no own state column. | **2-3 per parent** | Audit zones, order line items, inspection findings. |
  | **Issue / finding** | Lookup back to a transactional parent + has `status` (Open / Resolved) AND severity (Critical / Moderate / Minor). | **3-4 per transactional parent** | Issues, defects, observations. Mix severities + statuses (see Step 4a). |
  | **Evidence / attachment** | Has a File / Image column + lookup to issue/inspection. | **1 per ~30% of parents** | Photo evidence, document uploads. Seed metadata rows by default; seed file/image bytes only when `brand/media-policy.md` or the user's request says sample media is needed. |
  | **Log / event / audit-trail** | Append-only with `eventtype` enum + timestamp + actor lookup. | **2 per transactional parent** | Audit log events, activity stream. Mix at least 2 event types per parent. |
  | **Override / approval** | Lookup to transactional parent + status (Pending / Approved / Rejected). | **1 per ~20% of parents** | Override requests, approval queue. At least 1 row in `Pending` so queue tab shows content. |

  Counts are intentionally minimal. Goal: every screen has SOMETHING to render, not a demo dataset.

Print a one-line summary and continue:

> `→ Seeding <total> records into <N> tables (coverage-first; counts auto-tuned per class).`

#### Step 3b — Determine insertion order

For the selected tables, build a dependency graph from lookup columns:

1. Tables with no lookups out → Tier 0 (insert first)
2. Tables with lookups only to Tier 0 → Tier 1
3. Continue until all selected tables are tiered

If a selected table references an UNSELECTED parent, ask the user whether to add the parent to the selection or skip the lookup field. Don't silently insert null lookups.

### Step 4 — Generate sample data + preview

#### Step 4a — Generate contextual rows

For each selected table, generate N rows. Match values to column names + types:

| Column type | Generation approach |
|---|---|
| **String** | Match the column name's semantic. `*name`, `*title` → realistic names from the requirements brief context. `*email` → `firstname.lastname@example.com`. `*phone` → `(555) 123-NNNN`. `*address` → realistic street + city. Otherwise: short context-appropriate text. |
| **Memo (multi-line text)** | 1-3 sentences relevant to the column name (e.g. `*notes`, `*description`). |
| **Integer / Decimal / Currency** | Reasonable range based on column name. `*amount`, `*price` → realistic dollars. `*count`, `*quantity` → small integers (1-100). |
| **DateTime / DateOnly** | Recent ISO dates spanning past 30 days to next 14 days. Vary across rows. |
| **Boolean** | Mix true/false (~70/30 favoring true for `is_active` style names). |
| **Choice (Picklist)** | **Query options first** (Step 4b), then pick from valid integer values. |
| **MultiSelect Choice** | Pick 1-3 valid values per row from the option set. |
| **Lookup** | Reference a record from the parent table that was (or will be) inserted in this run. Track parent GUIDs from Step 5's POST responses. |
| **Image / File** | Default: skip — leave null. If media seeding is enabled and the column is business data (product image, inspection evidence, NC proof), use generated/synthetic local files from `assets/sample-*` and record provenance. Never upload decorative UI hero assets to Dataverse. |

**Media seeding policy (business data only, only if needed):**

- Default: do not seed binary media. Seed metadata rows and leave Image/File columns null unless the screen plan or user request requires visible sample media.
- Seed Dataverse images/files only when the image belongs to a record users inspect in list/detail screens: product photos, evidence, attachments, signatures, issue proof. Do NOT seed Home hero, splash, app icon, empty-state art, or decorative detail backgrounds.
- Prefer generated/synthetic assets with no logos, no real product labels, no faces, no watermarks, and no competitor branding. If the user supplies approved assets, use those and record their source.
- CDN URLs are valid only for explicit URL/Text columns (e.g. `imageurl`, `photourl`). Do not put CDN URLs into File/Image columns.
- Dataverse Image columns receive base64 in the row payload or generated service shape. Dataverse File columns require a second upload step after the metadata row exists.
- For product/channel apps, product images are core sample data when product list/detail screens are visual, but they are capped. Generate and upload only a representative subset; use local placeholders or null image fields for the rest.
- Maintain `assets/images/asset-manifest.json` or `assets/sample-media/asset-manifest.json` with file, purpose, source/license, and safety notes.

**Media volume limits (HARD):**

- Product/catalog tables: upload images for at most **min(6, record count)** records by default. If records are category-based, choose 1-2 per category until the cap is reached. All remaining records rely on local placeholder thumbnails or empty-state fallback.
- Evidence/attachment tables: upload sample files for at most **30% of parent records**, capped at **5 files total per table**. Metadata rows can still exist without file bytes.
- User/avatar/equipment/site images: upload at most **3 per table** unless the user explicitly asks for a larger visual demo.
- Never create more than **10 generated media files total** in one `/add-sample-data` run without explicit user approval.
- If the calculated sample row count exceeds the media cap, prefer diverse coverage over volume: one hero product, one secondary product, one edge/status example, then placeholders.

**How sample images are inserted:**

1. Generate the normal record body first (name, lookup fields, status, etc.).
2. For **Image columns**, attach a compact base64 payload in the create/PATCH body only if the generated model/service expects base64 for that column. Keep the image small enough for mobile thumbnails.
3. For **File columns**, do NOT put bytes/base64/URLs in the create body. Insert the metadata row first, capture the GUID from Step 5's `BATCH-RECORDS` result, then upload the generated file to `(recordId, columnName)` in Step 5d.
4. Stop once the media cap is reached. Remaining records keep null Image/File columns and use local placeholders in the app UI.
5. If no upload helper exists for File columns, leave the column null and report `sample media skipped — upload helper missing`. Never fake File/Image data with a URL string.

**Pull context from the requirements brief.** The user described what the app does (e.g. "HVAC inspection app for field technicians"); use that to flavor the data — sites named after streets typical for the user's industry, statuses in the right vocabulary. Generic Lorem Ipsum is the failure mode.

**Per-parent fanout floor (HARD).** For every child table in Tier K+, generate AT LEAST 1 row per parent row from Tier K-1 unless the relationship is explicitly optional (`RequiredLevel: None` in the manifest AND the column name doesn't imply 1-to-many like `*audit*`, `*inspection*`, `*order*`). Without this floor, random lookup distribution leaves some parents with zero children and the parent's detail screen renders empty. Concrete rule: if generating `audit_zones` and there are 5 audits, generate AT LEAST 5 zones (one per audit), then add 0-2 more per audit until you hit the per-class count target. Never the reverse — never generate `N` total and let chance decide which parent each row picks.

**State / status distribution (HARD for transactional, issue, override classes).** If a table has a `status` / `state` / `phase` / `severity` / `priority` choice column, **distribute rows across at least 2 distinct values** — never all-`Open`, never all-`InProgress`. Concrete rules:

- **Transactional** (`audit`, `inspection`, `order`): mix at least 3 lifecycle states from the option set if available — typically 1 row in an early state (`Draft` / `InProgress`), 1 in a mid state (`Submitted` / `PendingReview`), and the rest in a terminal state (`Signed` / `Completed` / `Closed`). If only 2 states exist, split ~60/40.
- **Issue / finding**: mix severity AND status independently. If 5 issues across 3 severities × 2 statuses, aim for ≥1 of each severity AND ≥1 `Open` AND ≥1 `Resolved`.
- **Override / approval**: at least 1 row in the queue-driving state (`Pending`) so the queue/inbox tab shows content; remainder distributed across `Approved` / `Rejected`.
- **Log / event**: at least 2 distinct `eventtype` values per parent (e.g. `Created` + `StatusChanged`).

**Date distribution (transactional / log only).** If the table has a `createdon` / `submittedat` / `completedat` / `eventtimestamp` column, spread rows across **today + last 14 days** (not all today, not all 30 days ago). Distribution: ~30% today/yesterday (drives "Recent activity" tiles), ~50% last 7 days, ~20% 8-14 days. Reference and detail tables can use any reasonable date — only transactional/log need temporal spread.

**Scenario archetype edge coverage (HARD when detectable).** Use the selected Power Apps scenario archetype to ensure at least one row exercises each critical state the app UI promises:

- Field inspection / audit: one blocked or evidence-missing audit, one in-progress audit, one completed/signed audit.
- Asset maintenance: one overdue/high-priority work order, one awaiting-parts order, one completed order.
- Inventory scan-first: one variance, one zero/low-stock item, one resolved count/transfer.
- Approvals: one pending item in the approval inbox, one approved, one rejected/changes-requested.
- CRM: one at-risk relationship, one upcoming follow-up, one healthy/won relationship.
- Retail catalog/order: one visual product, one low-stock/backordered example, one order with multiple lines.
- Case management: one escalated/SLA-risk case, one waiting-on-customer case, one resolved case.
- Onboarding/training: one overdue required module, one in-progress module, one completed/certified module.
- Expense/request intake: one missing-receipt draft, one pending approval, one approved/paid request.
- Health/wellness/care: one due-today care task, one missed/follow-up task, one completed/on-track goal.

#### Step 4b — Discover Choice options

For every choice column in the selected tables, query its option set before generating rows:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions(LogicalName='<table>')/Attributes(LogicalName='<column>')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?\$expand=OptionSet"
```

Use the actual `Value` integers from the response. Don't hardcode `100000000`-style values — they vary per environment.

#### Step 4c — Preview to user

For each table, show a markdown table previewing the rows directly in the conversation:

```markdown
### Job Site (cr3e9_jobsite) — 5 records

| Site Name | Address | Square Feet | Active |
|---|---|---|---|
| Westside Construction Site | 4521 Industrial Pkwy | 12500 | true |
| Downtown Office Building   | 188 Main St           |  3200 | true |
| Eastgate Warehouse         | 9047 Logistics Way    | 28000 | false |
| Riverside Retail Plaza     | 320 River Rd          |  6800 | true |
| North Hills Distribution   | 1612 Highland Ave     | 18900 | true |
```

For tables with lookups, also show which parent record each child references:

> `cr3e9_inspection rows reference cr3e9_jobsite records by SiteName above.`

#### Step 4d — Proceed to insert

After the preview is shown, proceed directly to Step 5. No confirmation prompt — the row-count pre-check (Step 3) already ensures no existing data is overwritten.

### Step 5 — Insert sample data

**Print before starting:**
> "→ Inserting <total> records across <N> tables in dependency-tier order (parallel within each tier, cap 5 concurrent)…"

Insert in the tier order from Step 3c. **Within a tier, parallelize across both tables and rows** via the script's `BATCH-RECORDS` mode — single Node process, `Promise.all` with concurrency cap of 5. Across tiers stays sequential (children need parent GUIDs from prior tier's responses).

> **⚠️ Parallelism applies ONLY to record inserts.** Schema operations (table / column / relationship creation) MUST stay sequential — see [`/add-dataverse` Step 5 concurrency rule](../add-dataverse/SKILL.md#step-5--create--extend-tables). Records have no metadata lock; metadata writes do. Mixing them up returns 429 / `MetadataLockHeldException`.

#### Step 5a — Get entity set names

For each table, get its `EntitySetName` (the URL-path name, usually plural — e.g. `cr3e9_jobsites`). Read from `.datamodel-manifest.json` if it carries this; otherwise:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions(LogicalName='<table>')?\$select=EntitySetName"
```

Cache the result.

> **⚠️ Resolve EntitySetName for BOTH sides of every lookup.** You need the entity set name not only for the table you're inserting into (the `entitySet` field in BATCH-RECORDS), but also for every **lookup target** referenced in `@odata.bind` values (Step 5c). Entity set names are independent of logical names — Dataverse pluralises irregularly and version suffixes pass through verbatim. Examples that bite: `cr3e9_inspectionv3` → `cr3e9_inspectionv3s` (NOT `cr3e9_inspections`); `cr3e9_inquiry` → `cr3e9_inquiries`; `cr3e9_status` → `cr3e9_statuses`. **Never construct the path as `<logicalName>s` — always read it from EntityDefinitions.**

#### Step 5b — Insert one tier at a time, parallel within the tier

For each tier from 0 → N:

1. **Build the operations array.** Collect every (entitySet, body) pair across all tables in this tier. Tag each with a unique `index` you'll use to map results back to your row identity.

   ```jsonc
   [
     { "index": 0, "entitySet": "cr3e9_jobsites", "body": { "cr3e9_sitename": "Westside Construction Site", "cr3e9_address": "4521 Industrial Pkwy", "cr3e9_squarefeet": 12500, "cr3e9_active": true } },
     { "index": 1, "entitySet": "cr3e9_jobsites", "body": { "cr3e9_sitename": "Downtown Office Building", "cr3e9_address": "188 Main St",          "cr3e9_squarefeet":  3200, "cr3e9_active": true } },
     { "index": 2, "entitySet": "cr3e9_inspectors", "body": { "cr3e9_fullname": "Jane Smith", "cr3e9_email": "jane.smith@example.com" } }
     // ... all rows for tables in this tier
   ]
   ```

   Maintain a side-map `{ index → { table, rowSemantic } }` so you can correlate results back to your tracking.

2. **Fire BATCH-RECORDS once per tier.** The script handles concurrency, retry, GUID extraction, and adaptive throttling internally:

   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> BATCH-RECORDS \
     "Tier <N>" \
     --operations '<json-from-step-1>' \
     --concurrency 5 \
     --solution '<solution-uniquename-from-memory-bank>'
   ```

   Output is `{ "status": 200, "data": [{ "index": 0, "status": 204, "recordId": "<guid>" }, ...] }`. Results are ordered by input index (stable across parallel execution).

3. **Capture parent GUIDs.** For every successful row in the response, store `recordId` indexed by your row identity. Tier N+1's `@odata.bind` values come from this map.

   Print one line per inserted record (iterate the response array in input-index order so output reads sequentially):

   > `→ ✓ <table>: <primary-name-value> (<guid>)`

4. **Handle failures.** If any operation in the tier returned non-2xx or `error`, skip child rows whose parent failed but **continue to the next tier** with the rows that DID succeed. Rationale: aborting Tier 1 leaves Tiers 2+ empty, defeating the coverage contract. Document each skipped child and tier knock-on in the Step 6 summary.

#### Step 5c — Insert child tables with lookups (also via BATCH-RECORDS)

For Tier 1+ tables, build each row's body with `@odata.bind` referencing the parent GUID captured in the prior tier. Same BATCH-RECORDS call shape:

```jsonc
[
  {
    "index": 0,
    "entitySet": "cr3e9_inspections",
    "body": {
      "cr3e9_inspectionnumber": "INS-001",
      "cr3e9_status": 100000000,
      "cr3e9_Site@odata.bind": "/cr3e9_jobsites(<parent-guid-from-tier-0>)"
    }
  }
]
```

Then:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> BATCH-RECORDS \
  "Tier 1" \
  --operations '<json-with-bound-lookups>' \
  --concurrency 5 \
  --solution '<solution-uniquename-from-memory-bank>'
```

> **⚠️ Lookup write syntax (HARD — wrong shape silently saves null OR loudly 404s):** 
> - The property name on the LEFT of `@odata.bind` is the **PascalCase nav property**, e.g. `cr3e9_Site` (not `_cr3e9_siteid_value`, which is read-only).
> - The value is the entity-set path: `/<entitySetName>(<guid>)`. Note the leading `/`.
> - **`<entitySetName>` is the EntitySetName of the LOOKUP TARGET table, fetched via Step 5a — NOT the column's logical name with `s` appended.** Constructing it as `<logicalName>s` returns `Entity '<targetTable>' With Id = <guid> Does Not Exist` even when the row exists, because Dataverse can't resolve the wrong entity set to the right table. Versioned tables (`cr3e9_inspectionv3` → `cr3e9_inspectionv3s`) and irregular plurals (`cr3e9_inquiry` → `cr3e9_inquiries`) are the common traps.
> - **`<guid>` MUST come from a live query in the current process** — either the parent's BATCH-RECORDS response (Step 5b/5c) or, on resume, a fresh GET against the parent table (Step 5f). Never copy-paste GUIDs from a prior session's stdout.
> - Wrong shapes either silently drop the relationship (record lands without parent FK, app shows orphaned rows) or 404 the whole tier. See [`references/dataverse-reference.md` § Setting Lookups](../add-dataverse/references/dataverse-reference.md#setting-lookups-creatingupdating-records) for the canonical pattern.

#### Step 5d — Upload sample media after record inserts (only if enabled)

Run this step only when Step 4a created media jobs for business Image/File columns. Never run it for decorative UI assets.

Build a `mediaJobs` sidecar while generating rows:

```jsonc
[
  {
    "table": "cr3e9_product",
    "rowIndex": 2,
    "recordId": "<filled-after-BATCH-RECORDS>",
    "columnName": "cr3e9_productimage",
    "columnType": "Image",
    "filePath": "assets/sample-media/gatorade-aseptic.png",
    "fileName": "gatorade-aseptic.png",
    "purpose": "product photo"
  }
]
```

After each tier's `BATCH-RECORDS` response, fill `recordId` from the in-memory `{ index → recordId }` map, then upload media by column type:

- **Image columns:** if the base64 value was already included in the create body, mark the media job complete. If not, PATCH the record with the base64 string using the entity set + record GUID. Keep images small and app-facing; never upload original multi-megabyte photos for seed data.
- **File columns:** call a supported upload helper after the row exists. In app code, the generated service shape is `Service.upload(recordId, columnName, file, fileDisplayName?)`; for CLI seeding, use a dedicated helper that performs the same Dataverse file upload flow. The JSON-only `dataverse-request.js BATCH-RECORDS` mode is not a binary upload mechanism.

**Hard failure rule:** if media upload fails for a sample row, keep the metadata row, record the media failure in Step 6, and continue. Do not delete the row or rerun schema creation. The app should still have usable list/detail data with a placeholder image fallback.

**Never do these:**

- Never set a File/Image column to a CDN URL unless the column is actually a URL/Text column.
- Never stuff base64 into a File column.
- Never upload UI hero/splash/icon assets to Dataverse.
- Never guess `columnName`; use `.datamodel-manifest.json` / `field_bindings.file_columns` exact logical names.

#### Step 5e — Track results + memory-bank

The `BATCH-RECORDS` response is your tracking source. For each tier's response array:

- **Successes** (`status` 200-299, `recordId` present) → append to your in-memory `{ index → { table, primaryNameValue, recordId } }` map.
- **Failures** (`status` 0 / 4xx / 5xx with `error`) → append to a per-tier failure list for the Step 6 summary.

After **all tiers complete** (or after a strict-default stop), batch-write to `memory-bank.md` under `## Seeded sample data` so subsequent runs are idempotent. One row per table per run:

```markdown
## Seeded sample data

| Date | Table | Records inserted | First GUID | Last GUID |
|---|---|---|---|---|
| <ISO> | cr3e9_jobsite | 5 | <guid1> | <guid5> |
```

Write all rows in a single `Edit` call after the run, not per-tier — avoids race-on-file-write across iterations and keeps the audit log atomic.

#### Step 5f — Recovery / resume from a failed tier

If a tier fails partway and you need to retry, **do NOT write a hand-rolled `seed-resume.js` that hardcodes parent GUIDs from the prior run's stdout.** That pattern is the #1 source of `Entity '<table>' With Id = <guid> Does Not Exist` 404s, because (a) the prior run may not have actually committed the parent rows it printed, and (b) GUIDs from a re-created table are stale immediately.

**The only safe resume pattern:**

1. **Re-query parent GUIDs by a stable business key.** For every parent table referenced in the failed tier's `@odata.bind` values, run a fresh GET filtered by the row's natural identifier (name, tail-number, code — whatever you used as the primary name when seeding). Example:

   ```bash
   node "${PLUGIN_ROOT}/scripts/dataverse-request.js" <envUrl> GET \
     "<parentEntitySet>?\$select=<parentIdColumn>,<naturalKey>&\$filter=startswith(<naturalKey>,'<seed prefix>')&\$top=50"
   ```

   Build a fresh `{ naturalKey → guid }` map from the response.

2. **Re-query EntitySetName for every lookup target** (Step 5a). Don't trust a cached value from the prior session — table EntitySetName is stable, but the cache file may be from a different project.

3. **If the parent query returns fewer rows than expected, STOP.** Don't proceed with a partial map — surface the count to the user:

   > `⛔ Resume aborted: expected <N> parent rows in <table>, found <K>. Re-run /add-sample-data from Tier 0 (don't trust the prior session's GUIDs).`

4. **Re-issue the failed tier as a normal Step 5b/5c BATCH-RECORDS call** with the freshly-queried GUIDs and EntitySetNames substituted into the operations array. Same `--solution` flag, same concurrency rules.

5. **Continue forward** through subsequent tiers using the new in-memory `{ index → recordId }` map seeded from this resume's response.

> **Why no `--resume` flag exists today:** the strict-default failure mode ("stop the tier, surface failures, let user re-run") combined with the live-query rule above is the resume mechanism. A flag would imply the script can magically figure out what's already there — it can't, because partial commits and concurrent edits make any cache lie. The user owns the recovery decision; the agent's job is to follow the live-query pattern, never to invent a stateful resume helper.

### Step 6 — Summary

```
✅ Sample data seeded
─────────────────────────────────────────────
Environment   : <envUrl>
Solution      : <solution>
Tables seeded : <list with counts, e.g. cr3e9_jobsite (5), cr3e9_inspection (5)>
Total records : <N>
Failures      : <K> (see list below if K > 0)

Next steps:
  npm run dev          # Open the app — home screen now shows real data
  /preview-screens     # Generate static HTML preview with sample data
─────────────────────────────────────────────
```

If any record failed, print a sub-table of the failures with the error messages so the user can diagnose.

## Hard rules

- **Coverage-first — every table in scope gets at least 1 row.** If you find yourself dropping a table because "its parent count is small" or "the user probably doesn't need it on day 1," you're wrong. Empty downstream tables are the failure mode this skill exists to prevent. The only legitimate exclusions: shared standard tables (`contact`, `account`, `incident`) and reused-as-is tables.
- **Per-parent fanout floor — every parent in Tier K-1 gets at least 1 child in Tier K** (when the relationship is required or implies 1-to-many). Random lookup distribution leaves orphan parents and breaks parent-detail screens. Generate child rows parent-by-parent, not as a flat batch with random parent picks.
- **State / status distribution for transactional, issue, override, log tables** — mix at least 2 distinct values; never all-`Open`, never all-`InProgress`, never all-`Pending`. See Step 4a for per-class targets.
- **Date distribution for transactional / log tables** — spread across today + last 14 days, not bunched on a single day. ~30% recent / 50% last week / 20% older.
- **Use `BATCH-RECORDS` mode for the actual inserts** — single Node process, parallel within a tier, ordered results, adaptive concurrency on 429. Don't fire per-row `node dataverse-request.js POST ...` invocations: each cold-start is ~150-300ms and the whole point of the batch mode is to amortize that.
- **Across-tier always sequential, within-tier always parallel.** Children need parent GUIDs; rows in the same tier are independent. Mixing this up either creates orphan lookups (going too parallel) or wastes time (going too sequential).
- **Concurrency cap is 5** (default in BATCH-RECORDS). The script auto-downgrades to 3 on the first 429. Don't set `--concurrency` higher unless you've measured and verified the env's service-protection ceiling.
- **Parallelism applies ONLY to record inserts.** Schema operations (`EntityDefinitions`, `Attributes`, `RelationshipDefinitions` POSTs) MUST stay sequential — Dataverse metadata lock. The existing `/add-dataverse` Step 5 concurrency rule is unchanged.
- **Never seed standard system tables** (`contact`, `account`, `incident`, etc.) by default — they're shared with other apps in the env. If the user explicitly selects them, surface a confirmation: "These records will be visible to all apps in this env. Continue?"
- **Always pass `--solution`** so records land in our solution.
- **Lookups use `@odata.bind` with PascalCase nav property name + `/entitySet(guid)` value.** Anything else either silently drops the relationship, 400s, or 404s with `Entity '<target>' With Id = <guid> Does Not Exist`. The BATCH-RECORDS mode passes the body through verbatim — it doesn't validate `@odata.bind` shape, that's the caller's job.
- **EntitySetName for lookup targets is fetched, never guessed.** `<logicalName>s` is wrong for versioned tables (`cr3e9_inspectionv3s`) and irregular plurals (`cr3e9_inquiries`, `cr3e9_statuses`). Always read EntitySetName from EntityDefinitions (Step 5a) for **every** lookup target referenced in `@odata.bind` values.
- **GUIDs in `@odata.bind` come from live queries in the current process — never from a prior session's stdout.** On resume, re-query parents by their natural key (Step 5e); never paste GUIDs into a hand-rolled `seed-resume.js`.
- **No hand-rolled resume scripts.** If a tier fails, follow Step 5e (re-query, re-issue the failed tier as a normal BATCH-RECORDS call). A `.tmp/seed-resume.js` with hardcoded `inspGuids = [...]` is a guaranteed 404.
- **Choice columns use the actual numeric `Value` from the option set, not labels.** Query the option set first (Step 4b).
- **Do NOT auto-rollback on failure.** Strict-default (interactive) stops the run after a failed tier; auto / coverage-first mode continues with orphan-skip; either way, user owns the cleanup decision — never DELETE rows automatically.

## Reference

- [microsoft/power-platform-skills/power-pages/add-sample-data](https://github.com/microsoft/power-platform-skills/tree/main/plugins/power-pages/skills/add-sample-data) — the skill this is modeled on
- [`skills/add-dataverse/references/dataverse-reference.md`](../add-dataverse/references/dataverse-reference.md) — Setting Lookups, Choice fields, Formatted Values
- [`scripts/dataverse-request.js`](../../scripts/dataverse-request.js) — bundled HTTP helper with `--solution`, `--include-headers`, `--body` flags
