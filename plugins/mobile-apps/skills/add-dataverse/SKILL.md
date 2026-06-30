---
name: add-dataverse
description: Use when the user wants to add Dataverse tables (existing or new) to a Power Apps mobile app, extend an existing Dataverse table with new columns, or apply an approved data model plan.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, EnterPlanMode, ExitPlanMode, Task
model: opus
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

# Add Dataverse

Two paths:

- **Existing tables only** — skip to Step 5 (just runs `npx power-apps add-data-source` per table)
- **New / extended tables** — full workflow with Web API mutations in dependency order

## Workflow

1. Verify project & auth → 2. Resolve plan → 3. Setup Dataverse Web API auth → 4. Review existing tables → 5. Create / extend tables → 5d. Create alternate keys → 6. Add data sources → 6b. Publish customizations → 6c. Verify tables → 6d. Write manifest → 7. Inspect generated files → 8. Type-check → 9. Summary

---

### Step 1 — Verify project & auth

Confirm Power Apps mobile app:

```bash
test -f power.config.json && test -f app.config.js
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$(node -e \"console.log(require('./power.config.json').environmentId)\")"
```

Capture the **environment URL** (`https://orgXXX.crm.dynamics.com`), **environment ID**, and **tenant ID** from `resolve-environment.js` — needed for Step 3. If only the environment URL is available, pass that URL instead of the ID.

### Step 2 — Resolve plan

Look for `native-app-plan.md` in the project root:

```bash
test -f native-app-plan.md
```

**If present:** read the `## Data Model` section. Extract:
- The reuse / extend / create table
- The Mermaid ER diagram (informational)
- The "Creation Order" tier list

**If absent:** check `$ARGUMENTS` for diagram hints (`*.png`, `*.jpg`, `*.jpeg` filename, `erDiagram` keyword, `||--o{` cardinality syntax). 

- **Diagram hint present** → Path A (Step 2.5).
- **No hint AND `$ARGUMENTS` describes what the app does** (the typical case) → silently take Path B (Step 2.6 — spawn architect). No prompt.
- **No hint AND `$ARGUMENTS` is empty / non-descriptive** → only then prompt with `AskUserQuestion`:

  > "How would you like to define the data model?
  > (a) I have an existing ER diagram to upload (PNG/JPG path, Mermaid syntax, or text description)
  > (b) Let the data-model-architect agent analyze and propose one (default)
  > (c) Cancel — I'll plan it elsewhere first"

  Default the answer to (b) so empty/cancel input auto-proceeds. The 99% case (user gave a description but no diagram) skips this prompt entirely.

### Step 2.5 — Path A: Parse user-provided diagram

Used when the user has an existing diagram from another tool (Visio, dbdiagram.io, screenshot, hand-drawn).

Accept three input formats:

| Format | How |
|---|---|
| **Image path** (`*.png` / `*.jpg` / `*.jpeg`) | Use `Read` on the file path. The vision-capable model extracts entities, columns, relationships. |
| **Mermaid syntax** | User pastes a `erDiagram` block in chat. Parse the entities, columns, and `\|\|--o{` cardinalities directly. |
| **Text description** | User types a structured description ("Account has many ServiceVisits; each ServiceVisit has many WorkItems and Photos"). Spawn `data-model-architect` agent in `parse-only` mode with the text as input. |

Whichever format, normalize into the same structure used by the planner agent:

```yaml
publisherPrefix: <from detected publisher prefix or user>
tables:
  - logicalName: contoso_servicevisit
    displayName: Service Visit
    status: new   # new | extend | reuse
    columns: [...]
    relationships: [...]
```

Then:
1. Query existing Dataverse (Step 4 logic) to mark each table as `new`, `modified`, or `reused`.
2. Generate a Mermaid ER diagram from the parsed structure for visual confirmation.
3. Present back to the user via `EnterPlanMode` for approval.
4. On `ExitPlanMode`, write the approved data model into `native-app-plan.md` `## Data Model` section (creating the file if it doesn't exist).
5. Continue to Step 3.

### Step 2.6 — Path B: Spawn architect agent

If the user picked Path B (or the user-provided diagram parse failed), spawn the `mobile-app:data-model-architect` agent via `Task` (the `mobile-app:` plugin-name prefix is required) with the user's high-level requirements as input. The agent returns `_dm_section.md`. Embed it in `native-app-plan.md`, present via `EnterPlanMode` for approval, then continue to Step 3.

If they need new tables and refuse both paths, recommend they run `/setup-datamodel` (alias of this skill) explicitly, or `native-app-planner` for a full app-level plan. STOP if neither.

### Step 3 — Setup Dataverse Web API auth

Required only if creating or extending tables. Skip to Step 5 for read-only `add-data-source`.

#### Step 3a — Environment consistency check

`npx power-apps` and `az` authenticate independently — they can point to different accounts. Verify `power.config.json` resolves and `az` can token for the target tenant before making any Dataverse API calls:

```bash
ENV_JSON=$(node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$(node -e \"console.log(require('./power.config.json').environmentId)\")")
echo "$ENV_JSON"
az account show --query "{user: user.name, tenant: tenantId}" -o json
```

Compare the resolved environment URL with `<envUrl>` captured in Step 1. If they differ, **STOP** and warn:

> "⚠️ Environment mismatch detected:
> - resolver reports: `<resolved_env_url>`
> - This project targets: `<envUrl>`
>
> The Dataverse API token comes from `az`, which must target the same tenant as the selected environment. Run:
> ```bash
> az login --tenant <tenant-id>      # switch az to the right tenant
> ```
> Then re-run `/add-dataverse`."

**Do NOT proceed with table creation if environments don't match** — you'll create tables in the wrong org.

#### Step 3b — Acquire token

```bash
az account show --query "user.name" -o tsv
```

If empty, instruct `az login` and stop.

**Script invocation contract — read this once, all subsequent calls in this skill follow it:**

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> <METHOD> <apiPath> [--body '<json>'] [--include-headers]
```

- Three positional args, in order: `<envUrl>`, `<METHOD>` (GET / POST / PATCH / DELETE), `<apiPath>` (everything after `/api/data/v9.2/`).
- **Body is a flag, not positional.** `--body '<json>'` — required for POST/PATCH, never for GET/DELETE. Forgetting `--body` and passing the JSON as a 4th positional arg returns a usage error.
- `--include-headers` adds response headers (needed for `OData-EntityId` after a record create).
- Output is JSON: `{ "status": <code>, "data": <body> }`. Token refresh on 401 and back-off on 429 are automatic — never wrap with manual retry.

Acquire a Dataverse access token and verify connectivity:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET WhoAmI
```

`WhoAmI` is the Dataverse identity endpoint — capital W/A/I (case-sensitive). The response gives `UserId`, `BusinessUnitId`, `OrganizationId` but **does NOT include the publisher prefix**. To get the publisher prefix, query the solution's publisher (defaults to `Default`; pass a different solution name if the env uses a custom solution):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/detect-publisher-prefix.js" <envUrl> [solutionName]
# solutionName defaults to "Default" if omitted
```

This runs the OData query:
`/api/data/v9.2/solutions?$select=uniquename&$expand=publisherid($select=customizationprefix)&$filter=uniquename eq '<solutionName>'`

Capture `customizationprefix` from the solution's publisher (typical value: `cr123` → schema names like `cr123_jobsite`). Also capture the solution `uniquename` — needed for the `--solution` flag on every Step 5 / 5b POST so artifacts land in our solution rather than landing wherever Dataverse defaults. Write both to `memory-bank.md` Power Platform context block.

Requires the user to hold **System Administrator** or **System Customizer** in this environment.

### Step 4 — Review existing tables

**Print before starting:**
> "→ Querying existing custom tables in the environment…"

Always query before creating:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions?\$filter=IsCustomEntity eq true&\$select=SchemaName,LogicalName,DisplayName"
```

For each plan entry classified `Reuse` or `Extend`, fetch the table's columns to confirm the match:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions(LogicalName='<table>')/Attributes?\$select=LogicalName,AttributeType,RequiredLevel"
```

Schema divergence handling is in Step 5b's per-column pre-flight (not a Step 4 prompt). The pre-flight auto-skips columns that already exist with the same type, and STOPs only on incompatible type drift — no separate confirmation needed here.

### Step 5 — Create / extend tables

**Print before starting:**
> "→ Creating/extending <N> tables in tier order (sequential — Dataverse serializes metadata writes). For each: pre-flight check, then 'Creating <table>…' before the POST and '✓ <table>' on 2xx response."

> **⚠️ Concurrency rule — do not violate.** All Dataverse metadata operations in Steps 5, 6, and 6b are **strictly sequential**: issue one HTTP request, wait for a 2xx response, then issue the next. Do NOT batch, parallelize, or fire concurrent requests. Dataverse serializes metadata writes via an exclusive lock; parallel calls return `429 TooManyRequests`, `MetadataLockHeldException`, or `404 EntityNotFound` for lookups whose parent hasn't committed yet.
>
> Specifically:
> - **Within a tier:** create tables one at a time.
> - **Across tiers:** Tier 0 fully done (all tables + all columns committed) before any Tier 1 POST.
> - **Lookups:** POST to `/RelationshipDefinitions` only **after** both endpoint tables exist and have returned 2xx.
> - **Extensions:** column POSTs to an existing table are also serial — same lock applies.

#### Step 5a — Pre-flight collision check (per table, before each POST)

Step 4 listed *known* custom tables you intend to reuse. Step 5a probes for *unknown* problems on a per-create basis: name-prefix collisions from stale solutions, soft-deleted tombstones, and reserved system names. Skipping this check costs ~1 minute per failed POST (Dataverse takes its time returning the conflict error) and can leave Tier 0 partially created when a Tier 1 lookup fails on a phantom parent.

**For every `Create` entry, before its POST, probe the target logical name:**

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions(LogicalName='<prefix>_<table>')?\$select=MetadataId,LogicalName,IsCustomEntity"
```

Branch on the response:

| Status / body | Meaning | Action |
|---|---|---|
| **404 NotFound** | Name is free | Proceed with POST. |
| **200 OK** + `IsCustomEntity: true` + `MetadataId` matches memory-bank | We created this earlier — idempotent re-run | Skip the POST, mark as created, continue. |
| **200 OK** + `IsCustomEntity: true` + `MetadataId` *not* in memory-bank | Foreign collision | Auto-recover (see below) — do NOT prompt. |
| **200 OK** + `IsCustomEntity: false` | Reserved system table name | Auto-recover via rename (see below). |
| **5xx** with `0x80060890` or message `"object with same name exists in solution"` | Tombstone (soft-deleted, ~30 min purge TTL) | Auto-recover via rename (see below). |
| **400** with `0x80044363`, `"schema name ... is not unique"`, or `"same name already exists"` | Hidden Dataverse collision / recent-delete tombstone not visible to `EntityDefinitions` GET | Auto-recover via rename (see below), then retry the POST once. |

**Important:** Step 5a is a best-effort preflight, not the final authority. Dataverse can return 404 for a recently deleted table and still reject the create POST minutes later because the schema name remains reserved internally. Treat that POST-time 400 as a recoverable name collision, not a data-model failure.

#### Auto-recovery — reuse/extend first, rename as last resort

**Priority order when Step 5a hits a name collision:**

1. **Adopt as Extend (preferred)** — if the existing table's `Attributes` overlap with the planned columns by ≥50%, or the existing table is the same conceptual entity: add only the missing columns via per-column POST (Step 5b Extend path). No prompt needed — extend automatically and log `→ Extending existing <original> with <N> missing columns.`
2. **Adopt as Reuse** — if the existing table's schema already covers all planned columns: skip Step 5b for this entry, keep it in Step 6 for service generation. No prompt. Log `→ Reusing existing <original> (all required columns present).`
3. **Rename and Create (last resort)** — only when the existing table is a fundamentally different entity (e.g., planned table is an inspection log but existing `<original>` is a payroll record — incompatible concept, incompatible columns). Prompt the user before proceeding.

**When to auto-decide vs. prompt:**

| Situation | Action |
|---|---|
| Foreign collision + schema overlap ≥50% | Auto-Extend (no prompt) |
| Foreign collision + all planned columns present | Auto-Reuse (no prompt) |
| Foreign collision + incompatible concept | Prompt (see below) |
| Reserved system name | Auto-rename (no prompt) |
| Tombstone (0x80060890 / same-name-exists) | Auto-rename (no prompt) |

**For the incompatible-concept case only** — prompt via `AskUserQuestion`:

```
| Option | What it means |
|---|---|
| Extend existing (default) | Add required columns to <original>. Safer — avoids duplicate tables. |
| Rename and Create | Auto-renamed to <new>. Existing table left untouched. |
```

Default to "Extend existing" so an empty answer auto-proceeds. Rename-and-Create is the opt-in exception, not the default.

Maintain a run-level logical-name alias map for every auto-rename. Example:

```json
{ "cr3e9_aircraft": "cr3e9_aircraftv2" }
```

Before building any later table, column, lookup relationship, sample-data payload, service-reference text, or screen data spec, resolve logical names through this map. A rename that only changes the table POST but leaves relationships/screens/sample data pointing at the old name is a bug.

**Auto-rename probe sequence** (cap at 4 probes — only used for reserved/tombstone cases):

```
<original>v2  →  <original>v3  →  <original>2  →  <original>copy
```

For each candidate in order, GET `EntityDefinitions(LogicalName='<candidate>')?$select=MetadataId,IsCustomEntity`:
- 404 → free, **take it**, stop probing.
- 200 or 5xx (collision) → next candidate.

If all 4 probes collide, surface a `BLOCKED: cannot find a free alternative for <original>` and stop.

**On a successful auto-rename, do these in order BEFORE the POST:**

1. **Update `native-app-plan.md`** — `Edit` with `replace_all: true` to swap the old logical name for the new one across the entire `## Data Model` section (Mermaid ER, Reuse/Extend/Create table, Creation Order, Notes). This catches downstream relationship POSTs in this same Step 5 too.
2. **Update `## Screens` per-screen specs** — same `replace_all` sweep for any service / data-source references using the old name.
3. **Append to `memory-bank.md` Collision history** — `<original> → <new>` with reason (foreign / reserved / tombstone) and timestamp.
4. **Update the run-level alias map** — every later metadata payload and plan edit resolves `<original>` to `<new>` before use.
5. **Inform the user — single line, no prompt:**
   > `→ Collision on <original> (<foreign|reserved|tombstone>). Renamed to <new> and updated plan + memory-bank. Continuing.`

Then proceed with the POST using `<new>`.

#### Post-create collision rescue — hidden tombstone / recent delete

If the Step 5b table POST fails after a 404 preflight with any Dataverse name-collision signature, **do not fail the run**:

- HTTP `400` with code `0x80044363`
- message contains `schema name` and `not unique`
- message contains `same name already exists`
- message contains `object with same name exists in solution`

First attempt auto-Extend: re-GET the existing table's attributes and compare with the plan. If ≥50% overlap, switch to Extend path (add missing columns). Otherwise, run the auto-rename probe sequence, update `native-app-plan.md`, `## Screens`, `memory-bank.md`, and the run-level alias map, then retry the table POST exactly once with the resolved name. Print:

> `→ Dataverse still has <original> reserved from a recent delete/hidden collision. Using <new> and continuing.`

If the retry also returns a collision signature, continue probing the remaining candidates. If all candidates collide, return `BLOCKED: cannot find a free alternative for <original>`.

**On successful POST**, immediately re-GET to capture the server-assigned `MetadataId` and write it to memory-bank (Step 6d updates `.datamodel-manifest.json`; you also append to `memory-bank.md` under "Created tables" with the GUID and solution name). This lets future `/add-dataverse` runs distinguish "we own this" from "name collision."

#### Step 5b — Create / extend

For each `Create` decision, in **tier order** (Tier 0 → Tier 1 → Tier 2 → …), POST a new EntityDefinition. Skip if Step 5a returned a known-self match (idempotent).

> **⚠️ Inline ALL planned columns into the Create POST body — do NOT POST columns individually.**
>
> Dataverse processes the `Attributes: [...]` array atomically with the table create. Inline form: 1 round trip, ~3-8s. Per-column form: N+1 round trips, each ~3-8s. For a 5-column table that's 24s saved per table on the lock-serialized metadata path.
>
> **Wrong** (N round trips):
> ```json
> { "SchemaName": "...", "Attributes": [{ /* primary only */ }] }
> // then 4× POST /Attributes for the rest
> ```
>
> **Right** (1 round trip):
> ```json
> {
>   "SchemaName": "...",
>   "Attributes": [
>     { /* primary name */ },
>     { /* column 2 */ },
>     { /* column 3 */ },
>     { /* column 4 */ },
>     { /* column 5 */ }
>   ]
> }
> ```
>
> The per-column POST path remains valid for two cases only: (1) Extend on an existing table, (2) retry-after-partial-failure when Step 5a's pre-flight shows the table exists but some columns don't.

**Solution targeting (HARD):** every Step 5 / 5b POST MUST pass `--solution <uniquename>` so Dataverse routes the new artifact into our solution rather than the unmanaged default. Read the solution name from `memory-bank.md` Power Platform context (captured in Step 3b). Without this flag, multi-project environments end up with cross-solution leakage and the foreign-collision class of bug returns. The script translates `--solution` to the `MSCRM.SolutionUniqueName` HTTP header.

**Scratch files:** When writing request body JSON to disk (e.g. table definitions, column metadata, relationship payloads), always write to `<working_dir>/.tmp/`, never to `/tmp/`. The hook `validate-write-safety.js` blocks writes outside the project directory. Create the folder if it doesn't exist: `mkdir -p <working_dir>/.tmp`.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST EntityDefinitions \
  --body '<json-body-with-all-columns-inline>' \
  --solution '<solution-uniquename-from-memory-bank>'
```

Body skeleton — **all planned columns inline in `Attributes: [...]`** (this example shows primary + 3 additional; expand the array to fit every column from the plan):

> **⚠️ `IsAvailableOffline` + `ChangeTrackingEnabled` MUST be set to `true` at create time** for any table the app intends to make available offline. Without these two flags the table cannot be added to a `mobileofflineprofile`, and `/setup-offline-profile` will have to fix them via a separate metadata PUT (the `/enable-tables-offline` skill handles that, but it doubles the metadata-lock-serialized round trips). Empirically verified 2026-05-18 in the chanel-rm demo: 7 custom tables created without these flags caused 7 prereq-revert drift entries; fixed by post-hoc enablement. Default these to `true` for all UserOwned tables created by `/add-dataverse` unless the user has explicitly opted out of offline support. The flags are no-ops at runtime for apps that don't use offline profiles.

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
  "SchemaName": "cr123_jobsite",
  "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Job Site", "LanguageCode": 1033 }] },
  "DisplayCollectionName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Job Sites", "LanguageCode": 1033 }] },
  "OwnershipType": "UserOwned",
  "HasActivities": false,
  "HasNotes": false,
  "IsAvailableOffline": true,
  "ChangeTrackingEnabled": true,
  "PrimaryNameAttribute": "cr123_sitename",
  "Attributes": [
    {
      "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
      "SchemaName": "cr123_sitename",
      "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Site Name", "LanguageCode": 1033 }] },
      "MaxLength": 200,
      "FormatName": { "Value": "Text" },
      "RequiredLevel": { "Value": "ApplicationRequired" },
      "IsPrimaryName": true
    },
    {
      "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
      "SchemaName": "cr123_address",
      "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Address", "LanguageCode": 1033 }] },
      "MaxLength": 500,
      "FormatName": { "Value": "Text" },
      "RequiredLevel": { "Value": "None" }
    },
    {
      "@odata.type": "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
      "SchemaName": "cr123_squarefeet",
      "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Square Feet", "LanguageCode": 1033 }] },
      "RequiredLevel": { "Value": "None" },
      "MinValue": 0,
      "MaxValue": 2147483647,
      "Format": "None"
    },
    {
      "@odata.type": "Microsoft.Dynamics.CRM.BooleanAttributeMetadata",
      "SchemaName": "cr123_active",
      "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Active", "LanguageCode": 1033 }] },
      "RequiredLevel": { "Value": "None" },
      "DefaultValue": true,
      "OptionSet": {
        "@odata.type": "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
        "TrueOption": { "Value": 1, "Label": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "Yes", "LanguageCode": 1033 }] } },
        "FalseOption": { "Value": 0, "Label": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "No", "LanguageCode": 1033 }] } }
      }
    }
  ]
}
```

For each `Extend` decision, POST a new column to the existing table.

> **⚠️ Per-column pre-flight (HARD — required for idempotent re-runs).** Before each column POST, probe whether the column already exists. This catches:
> - Partial failures from a prior `EntityDefinitions` POST that created the table + some columns but not all (the body is non-atomic — server commits each Attribute one at a time).
> - User re-runs after fixing a typo in one column's metadata.
> - Re-applying a plan after a network drop mid-Step-5b.
>
> Without this check, the second POST returns `400: attribute already exists` (`0x80044153`) and the run aborts mid-tier.
>
> ```bash
> node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
>   "EntityDefinitions(LogicalName='<table>')/Attributes(LogicalName='<column>')?\$select=LogicalName,AttributeType"
> ```
>
> | Status | Meaning | Action |
> |---|---|---|
> | **404** | Column doesn't exist | Proceed with POST. |
> | **200** + `AttributeType` matches the spec | Already created (idempotent re-run) | Skip the POST, log `↻ <column> (already exists, skipped)`, continue. |
> | **200** + `AttributeType` differs from the spec | Schema drift — column type was changed manually OR plan changed since last run | **STOP** and surface to user: "Column `<column>` exists but is `<existingType>`, plan expected `<plannedType>`. Dataverse does NOT allow column-type changes via API — you must delete the column manually and re-run." Do NOT silently overwrite. |

After pre-flight returns 404, POST the column (always pass `--solution`):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "EntityDefinitions(LogicalName='<table>')/Attributes" \
  --body '<column-json>' \
  --solution '<solution-uniquename-from-memory-bank>'
```

**The same pre-flight applies inside Create POSTs that include initial Attributes.** If a Create POST partially failed earlier (table + some columns committed), the retry path is to do **per-column** pre-flight + POST instead of re-POSTing the whole `EntityDefinitions` body — re-POSTing returns `0x80060888 entity already exists`. After Step 5a says "table exists with our MetadataId" (idempotent re-run match), iterate the planned `Attributes` and pre-flight each one against `/Attributes(LogicalName='<column>')`, then POST only the missing ones.

Column shapes that have non-obvious gotchas (handle carefully):
- **Lookup** — POST to `/RelationshipDefinitions`, not `/Attributes`.

  > **⚠️ Do NOT improvise the body. Copy the skeleton below verbatim and replace only the placeholders in `<>` brackets.**
  >
  > Fields that cause silent failure if added:
  > - **Do NOT include `ReferencingAttribute`.** Dataverse auto-creates the foreign-key column from `Lookup.SchemaName`. Including it causes `404: Could not find an attribute with specified name` because the column doesn't exist yet at POST time.
  > - **Do NOT include `Lookup.LogicalName`.** It's read-only metadata; including it returns `400 Bad Request`.
  > - **Do NOT include `ReferencedAttribute`.** Dataverse resolves the primary key of the referenced entity automatically. The reference is optional and omitting it is the correct default.
  >
  > Required fields: `SchemaName`, `ReferencedEntity`, `ReferencingEntity`, `Lookup.{@odata.type, SchemaName, DisplayName, RequiredLevel}`, `AssociatedMenuConfiguration`, `CascadeConfiguration` (including `RollupView`). Anything else is invented — drop it.

  ```json
  {
    "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
    "SchemaName": "<prefix>_<Parent>_<Child>",
    "ReferencedEntity": "<parent_table_logical_name>",
    "ReferencingEntity": "<child_table_logical_name>",
    "Lookup": {
      "@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
      "SchemaName": "<Prefix>_<Parent>Id",
      "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Parent Display Name>", "LanguageCode": 1033 }] },
      "RequiredLevel": { "Value": "None" }
    },
    "AssociatedMenuConfiguration": { "Behavior": "UseCollectionName", "Group": "Details", "Order": 10000 },
    "CascadeConfiguration": {
      "Assign": "NoCascade",
      "Delete": "RemoveLink",
      "Merge": "NoCascade",
      "Reparent": "NoCascade",
      "Share": "NoCascade",
      "Unshare": "NoCascade",
      "RollupView": "NoCascade"
    }
  }
  ```

  Invocation (apiPath is `RelationshipDefinitions`, body via `--body`, always pass `--solution`):

  ```bash
  node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
    RelationshipDefinitions \
    --body '<json-body-from-skeleton-above>' \
    --solution '<solution-uniquename-from-memory-bank>'
  ```

- **Many-to-Many (M:N)** — also POST to `/RelationshipDefinitions`, but with `ManyToManyRelationshipMetadata`. Dataverse creates an auto-named intersect table.

  > **⚠️ Do NOT improvise the body.** Required fields: `SchemaName`, `Entity1LogicalName`, `Entity2LogicalName`, `IntersectEntityName`, and the two `AssociatedMenuConfiguration` blocks. Do not include lookup or cascade fields — those are 1:N concepts.

  ```json
  {
    "@odata.type": "Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata",
    "SchemaName": "<prefix>_<table1>_<table2>",
    "Entity1LogicalName": "<table1_logical_name>",
    "Entity2LogicalName": "<table2_logical_name>",
    "IntersectEntityName": "<prefix>_<table1>_<table2>",
    "Entity1AssociatedMenuConfiguration": {
      "Behavior": "UseLabel",
      "Group": "Details",
      "Label": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Table2 Plural>", "LanguageCode": 1033 }] },
      "Order": 10000
    },
    "Entity2AssociatedMenuConfiguration": {
      "Behavior": "UseLabel",
      "Group": "Details",
      "Label": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Table1 Plural>", "LanguageCode": 1033 }] },
      "Order": 10000
    }
  }
  ```

  **Pre-flight M:N:** GET `RelationshipDefinitions(SchemaName='<prefix>_<table1>_<table2>')?$select=SchemaName` — 404 → proceed; 200 → skip (already exists).

  **In the generated service:** M:N relationships are queried via the intersect entity name (e.g., `cr123_tag_inspection`) — the SDK does not expose a direct M:N navigation helper; the screen-builder must query the intersect table directly or via a calculated column approach. Flag this in the Step 7 summary if any M:N relationships are created.

- **Column `@odata.type` and required fields — reference table (verified against Dataverse OData API):**

  | Dataverse type | `@odata.type` | Required extra fields |
  |---|---|---|
  | Single-line text | `Microsoft.Dynamics.CRM.StringAttributeMetadata` | `MaxLength` (200), `FormatName: { "Value": "Text" }` — values: `Text`, `Email`, `Url`, `Phone`, `TextArea` |
  | Multi-line text | `Microsoft.Dynamics.CRM.MemoAttributeMetadata` | `MaxLength` (10000), `Format: "TextArea"` |
  | Whole number | `Microsoft.Dynamics.CRM.IntegerAttributeMetadata` | `MinValue`, `MaxValue`, `Format: "None"` |
  | Decimal | `Microsoft.Dynamics.CRM.DecimalAttributeMetadata` | `MinValue`, `MaxValue`, `Precision` (2) |
  | Currency (Money) | `Microsoft.Dynamics.CRM.MoneyAttributeMetadata` | `MinValue`, `MaxValue`, `Precision` (2), `PrecisionSource` (2) |
  | Date/Time | `Microsoft.Dynamics.CRM.DateTimeAttributeMetadata` | `Format: "DateAndTime"` or `"DateOnly"`, `DateTimeBehavior: { "Value": "UserLocal" }` |
  | Boolean | `Microsoft.Dynamics.CRM.BooleanAttributeMetadata` | `DefaultValue`, `OptionSet` with `TrueOption`/`FalseOption` |
  | Choice (picklist) | `Microsoft.Dynamics.CRM.PicklistAttributeMetadata` | `OptionSet` with `IsGlobal: false`, `OptionSetType: "Picklist"`, `Options[]` — **option integer values start at `100000000` and increment by 1** |
  | Lookup | via `RelationshipDefinitions` — see 1:N skeleton above | — |
  | Image | `Microsoft.Dynamics.CRM.ImageAttributeMetadata` | `MaxHeight`, `MaxWidth` |
  | File | `Microsoft.Dynamics.CRM.FileAttributeMetadata` | `MaxSizeInKB` |

  **Common mistake:** omitting `FormatName` on String columns and `DateTimeBehavior` on DateTime columns. Both are required — Dataverse rejects the POST without them.

- **Choice (option set)** — set `OptionSet.IsGlobal: false` for local picklists. Full body (option values start at `100000000` and increment by 1):

  ```json
  {
    "@odata.type": "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
    "SchemaName": "<Prefix>_<ColumnName>",
    "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "<Display Name>", "LanguageCode": 1033 }] },
    "RequiredLevel": { "Value": "None" },
    "OptionSet": {
      "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
      "IsGlobal": false,
      "OptionSetType": "Picklist",
      "Options": [
        { "Value": 100000000, "Label": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "Option 1", "LanguageCode": 1033 }] } },
        { "Value": 100000001, "Label": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", "Label": "Option 2", "LanguageCode": 1033 }] } }
      ]
    }
  }
  ```
- **Image** — `@odata.type: Microsoft.Dynamics.CRM.ImageAttributeMetadata`, `MaxHeight`/`MaxWidth` required
- **File** — `@odata.type: Microsoft.Dynamics.CRM.FileAttributeMetadata`, `MaxSizeInKB` required

If the column type is not a simple string/int/boolean, surface a one-line confirmation to the user before posting.

After all mutations, re-run the existing-tables query (Step 4) to confirm everything landed.

### Step 5c — Create calculated columns from `### Cross-entity Reads`

**Print before starting:**
> "→ Creating calculated columns from the plan's ### Cross-entity Reads subsection (one HTTP call per row). Skip if the subsection is absent."

**Run condition:** the planner / data-model-architect emits a `### Cross-entity Reads (auto-derived from screen plan)` subsection inside `## Data Model` of `native-app-plan.md` when the screen plan reads any field from a related entity. Parse that subsection. If absent or empty, **skip Step 5c entirely** — proceed to Step 6.

This step exists because of the runtime constraint documented at [`shared/references/data-performance.md` § Cross-entity Reads](${PLUGIN_ROOT}/shared/references/data-performance.md#cross-entity-reads): the SDK has no `$expand`, so cross-entity fields on hot paths (lists, dashboards, tab roots) MUST be denormalized via calculated columns at the data-model layer. The `### Chained-fetch fields (informational)` subsection (if present) is documentation only — the screen-builder handles those at scaffold time, no schema change.

**Algorithm:**

1. Parse the `### Cross-entity Reads` table. Each row has columns: `Calc column | On table | Type | Resolves | Driven by`.
2. **Run AFTER all regular columns + relationships from Step 5b have been created** (the formula chain references real columns + lookups; creating the calc column before its dependencies returns HTTP 400 from Dataverse).
3. **Per row**, invoke the helper:

   ```bash
   node "${PLUGIN_ROOT}/scripts/create-calculated-column.js" <envUrl> \
     --table <on-table> \
     --column <calc-column-logical-name> \
     --type <Type column verbatim: string|datetime|decimal|integer|boolean> \
     --formula "<dotted path from Resolves column, e.g. cr3e9_flightid.cr3e9_gateid.cr3e9_gatename>" \
     --display "<human-friendly label inferred from the column name minus _calc suffix>" \
     --solution '<solution-uniquename-from-memory-bank>'
   ```

4. **One at a time, sequentially.** Calc-column creation is metadata mutation — same concurrency rule as table creation. Print `✓ <calc-column>` after each success.
5. **On failure** — the helper script prints the OData error inline. Common cases:
   - `400 — formula references unknown attribute` → the relationship or column the formula needs has not been created yet. Verify Step 5b finished cleanly before retrying.
   - `400 — calculated formula not allowed on this navigation` → the dotted path tries to traverse 1:many or M:N. The architect should have caught this at Step 6a; flag in summary, skip the row, continue.
   - Surface non-recoverable errors to the user with the offending row, then proceed to the next row. Do NOT abort the whole step on one bad row.

6. After all rows are processed, the publish step (Step 6b) below picks up calc columns automatically — no extra publish call needed.

### Step 5d — Create alternate keys for unique business identifiers

**Print before starting:**
> "→ Creating alternate keys for columns marked unique in the data model (one HTTP call per key). Skip if no unique columns are planned."

**Run condition:** the `## Data Model` section marks a non-primary column as unique / alternate key / natural key. Common examples: QR Code Value, SKU, external ID, employee number, asset tag. Skip primary IDs and skip columns whose type Dataverse cannot index as an alternate key (file/image, memo/long text, multi-select choice, calculated/rollup, customer/owner lookups).

**Ordering:** run after the target table and target columns exist, and before Step 6b publish. Alternate-key index activation is asynchronous; creation may return success while the key status is `Pending`.

**Do NOT use the `CreateEntityKey` action route.** In practice it can return 404 depending on route shape / environment. The reliable metadata route is POSTing to the table's `Keys` navigation collection:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "EntityDefinitions(LogicalName='<table>')/Keys" \
  --body '<entity-key-json>' \
  --solution '<solution-uniquename-from-memory-bank>'
```

Body skeleton:

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.EntityKeyMetadata",
  "SchemaName": "<prefix>_<table>_<column>_key",
  "DisplayName": { "@odata.type": "Microsoft.Dynamics.CRM.Label", "LocalizedLabels": [{ "Label": "<Column display> Key", "LanguageCode": 1033 }] },
  "KeyAttributes": ["<column_logical_name>"]
}
```

**Pre-flight each key before POST** so re-runs are idempotent:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions(LogicalName='<table>')?\$select=LogicalName&\$expand=Keys(\$select=SchemaName,KeyAttributes,EntityKeyIndexStatus)"
```

| Existing key state | Action |
|---|---|
| Same `SchemaName` or same `KeyAttributes` exists with `Active` / `Pending` | Skip POST; record the key in `.datamodel-manifest.json`. |
| Same `SchemaName` exists with `Failed` | Surface the failure and stop; Dataverse requires deleting/recreating the key manually or changing the planned key name. |
| No matching key | POST to `EntityDefinitions(LogicalName='<table>')/Keys`. |

**After POST:** a `204` response is success. Re-query the `Keys` expand above and capture `EntityKeyIndexStatus`. If it is `Pending`, continue the scaffold but add a memory-bank follow-up: `alternate key <schema> pending index activation`. Do not rely on duplicate enforcement in manual tests until the status reaches `Active`.

Add alternate keys to `.datamodel-manifest.json` for the table:

```json
"alternateKeys": [
  { "schemaName": "cr123_item_code_key", "keyAttributes": ["cr123_code"], "indexStatus": "Pending" }
]
```

### Step 6 — Add data sources

**Print before starting:**
> "→ Generating TypeScript services for <N> tables via `npx power-apps add-data-source` (sequential). Print '✓ <table>Service.ts' after each."

For each table the app will use (regardless of reuse/extend/create), generate the TS layer from the app root. The CLI reads the environment ID from `power.config.json`; pass the environment URL resolved earlier in the skill:

```bash
npx power-apps add-data-source --api-id dataverse --org-url <envUrl> --resource-name <table-logical-name>
```

Run **one at a time — sequentially**, not in parallel. The Power Apps CLI writes `src/generated/connectorSchemas.ts` and other generated files non-atomically; concurrent invocations corrupt them.

### Step 6b — Publish customizations

**Print before starting:**
> "→ Publishing customizations (PublishXml) so new tables/columns become queryable. ~5–20 seconds."

Only after **every** Step 5 metadata POST and **every** Step 6 `npx power-apps add-data-source` has returned successfully, publish so the new tables and columns are available to the runtime. `PublishXml` takes the same exclusive metadata lock as the create/extend calls — do not run it concurrently with anything from Steps 5 or 6.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> POST \
  "PublishXml" \
  --body "{\"ParameterXml\":\"<importexportxml><entities><entity>cr123_table1</entity><entity>cr123_table2</entity></entities></importexportxml>\"}"
```

Build the entity list from all tables that were **created or extended** in Steps 4–5. Skip reused-as-is tables — they don't need republishing.

If the publish call returns a non-2xx status, report the error and stop — do not proceed. The user must resolve before the tables are usable.

### Step 6c — Verify tables exist

For each created or extended table, confirm it is queryable after publish:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/dataverse-request.js" <envUrl> GET \
  "EntityDefinitions(LogicalName='<table>')?\\$select=LogicalName,DisplayName"
```

- **200** → confirmed.
- **404** → table missing after publish — report and stop.

### Step 6d — Write `.datamodel-manifest.json`

After all tables are verified, write the manifest to the project root using the `Write` tool:

```json
{
  "environmentUrl": "<envUrl>",
  "generatedAt": "<ISO timestamp>",
  "tables": [
    {
      "logicalName": "cr123_jobsite",
      "displayName": "Job Site",
      "status": "new",
      "metadataId": "<server-assigned GUID from Step 5a re-GET>",
      "solution": "<solution unique name, e.g. PowerAppsDefault>",
      "columns": [
        { "logicalName": "cr123_sitename", "type": "String" },
        { "logicalName": "cr123_address",  "type": "String" }
      ]
    }
  ]
}
```

`metadataId` and `solution` are required for `status: "new"` or `"extended"` entries — they're how Step 5a distinguishes "we own this on a re-run" from "name collision." Reused tables can omit both.

Include only tables confirmed in Step 6c. Do NOT include tables reused with no schema changes.

### Step 7 — Inspect generated files

```text
Glob: src/generated/services/*Service.ts
Glob: src/generated/models/*Model.ts
```

For each table, check the generated service exposes the expected methods:

```text
Grep pattern="async (create|getAll|getById|update|delete|upload|downloadFile|downloadImage)" path="src/generated/services/<Table>Service.ts"
```

If the table has file or image columns, confirm the service includes `upload`, `downloadFile`, `downloadImage`, `deleteFileOrImage` — and the model exposes `<Table>FileColumnName` / `<Table>ImageColumnName` union types.

**File/image column UI controls:** When a generated table has File or Image columns, note this in the summary so screen-builders apply the host controls from `power-apps-native-host`:
- **File columns** → `<FilePicker>`; upload bytes separately via the generated service's upload method after the main create/update.
- **Image columns** → `<ImagePicker>`; capture `PickedImageInfo` via `onImageChange` and persist through generated `upload(...)` after the main create/update.
- **Read/view flows** → use generated `downloadFile(...)` / `downloadImage(...)` helpers for existing attachments/previews.

Full usage pattern and the native-wrapper boundary live in [`/add-native`](../add-native/SKILL.md#fileimage-picker-ownership); screen-builder keeps only the concise JSX enforcement rule.

**PDF/signature artifact schema guidance:** If the approved plan mentions generated PDFs, PDF evidence packets, approvals, signatures, sign-off, ink, or drawings, preserve the storage decision in the Dataverse model instead of defaulting to text fields.

| User need | Dataverse shape | Write pattern |
|---|---|---|
| Generated PDF report that must be retained | File column on the parent record, or child Evidence/Attachment table with a File column | Create/update parent row first, then call generated `Service.upload(parentId, '<fileColumn>', file)` |
| Generated PDF report that is only transient | No Dataverse column required | Generate locally with `expo-print` only when present; share with `expo-sharing` only when present; do not route local URI to native PDF viewer |
| Captured signature/sign-off image | Image column when the latest signature belongs on the parent row | Strip `data:image/png;base64,` if the generated service expects raw base64, then include image payload in the update body |
| Multiple signatures, sketches, evidence images, or audit attachments | Child Evidence/Attachment table with Image/File columns and lookup to parent | Create child row first, then include Image payload or upload File bytes through generated service helpers |

Signature image normalization example:

```ts
const signatureBase64 = signatureDataUri.replace(/^data:image\/png;base64,/, '');
const result = await Cr123_approvalService.update(approvalId, {
  cr123_signatureimage: signatureBase64,
  cr123_signedat: new Date().toISOString(),
});

if (!result.success) {
  throw new Error(result.error?.message ?? 'Signature image was not saved.');
}
```

File upload after parent row exists example:

```ts
const save = await Cr123_inspectionService.update(inspectionId, {
  cr123_reportgeneratedat: new Date().toISOString(),
});

if (!save.success) {
  throw new Error(save.error?.message ?? 'Inspection was not saved.');
}

const upload = await Cr123_inspectionService.upload(inspectionId, 'cr123_reportfile', reportFile);

if (!upload.success) {
  throw new Error(upload.error?.message ?? 'Inspection report was not uploaded.');
}
```

### Step 8 — Type-check

**Print before starting:**
> "→ Regenerating connector schemas + running tsc to verify generated services compile (~15–30 seconds)."

`npx power-apps add-data-source` (Step 5) wrote new files into `.power/schemas/<connector>/`. The `connectorSchemas.ts` consumed by `app/_layout.tsx` is now stale — regenerate it before type-checking, otherwise the new tables won't be wired into the runtime schema map and `tsc` will pass against an out-of-date snapshot:

```bash
npm run generate-schemas
npx tsc --noEmit
```

Fix any errors. Common: missing peer dependencies — `npx expo install <package>`.

### Step 9 — Summary

```
✅ Dataverse added
─────────────────────────────────────────────
Environment   : <envUrl>
Tables reused : <list>
Tables extended: <list (columns added)>
Tables created : <list (in tier order)>

Generated services:
  src/generated/services/<Table>Service.ts × N
Generated models:
  src/generated/models/<Table>Model.ts × N

Type-check: PASS

Sample usage:

  import { Cr123_jobsiteService } from '../../src/generated/services/Cr123_jobsiteService';

  const result = await Cr123_jobsiteService.getAll({
    select: ['cr123_sitename', 'cr123_address'],
    filter: 'statecode eq 0',
    orderBy: ['cr123_sitename asc'],
    top: 50,
  });
  const sites = result.data ?? [];

⚠️  First call triggers Dataverse OAuth consent via the native player's
    `<scheme>://oauth-callback` deep link.

Next:
  /add-sample-data        # Seed each new table with 5-10 realistic rows so the
                          # app's home screen shows real-looking data on first launch.
─────────────────────────────────────────────
```

After printing the summary, **offer one-click sample-data seeding** — but only when invoked manually (not from `/create-mobile-app`, which handles this in its own Step 8.5).

- **If `$ARGUMENTS` contains `--skip-planning`** (the orchestrator-invoked path): skip the prompt. The orchestrator invokes `/add-sample-data` separately.
- **Otherwise (manual invocation)**, if the manifest contains any tables, ask:

  > "Seed <N> tables with sample records so the app shows real-looking data on first launch? (yes / no — default: yes)"

  Default to "yes" so empty input auto-proceeds. On "yes", invoke `/add-sample-data`. On "no", print "→ Skipped sample data. Run `/add-sample-data` later to populate." and stop.

## Key Rules

- **Always** use generated services (e.g., `Cr123_jobsiteService.getAll()`) — never `fetch` / `axios` directly.
- Result data lives at `result.data`, not `result` itself.
- Don't edit files under `src/generated/` — they are regenerated on every `npx power-apps add-data-source`.
- Picklist (Choice) fields, virtual fields, lookups, and file/image columns each have non-obvious gotchas. Keep `references/dataverse-reference.md` aligned with this skill.
- **When a Dataverse Web API behavior is uncertain (lookup write syntax, `$expand` nav property names, choice column shape, batch semantics, error format), query the `microsoft-learn` MCP server before guessing.** See [shared/shared-instructions.md → Microsoft Learn MCP](../../shared/shared-instructions.md#microsoft-learn-mcp-authoritative-microsoft-docs). Guessed Dataverse syntax silently 400s.

## Reference

- [`scripts/dataverse-request.js`](../../scripts/dataverse-request.js) — bundled in this plugin
