# Data Performance Reference

Patterns for handling large datasets in Power Apps mobile apps. Uses only what the template already ships — no additional libraries required.

---

## When to Apply

Apply these patterns whenever a List screen queries a Dataverse table that can grow without a natural ceiling:
- Work orders, inspections, visits, tickets, transactions, audit logs
- Any table where users create records over time

**Skip for:** small lookup tables (status types, categories, job types) where total rows are bounded and known.

The `screen-planner` flags this in the per-screen spec as `pagination: cursor` or `pagination: none`.

---

## Dataverse Pagination: `maxPageSize` + `skipToken`

Microsoft Learn's Dataverse Web API guidance is the source of truth:
- Use server paging and continue with the SDK `skipToken` from `IOperationResult`, which is derived from Dataverse `@odata.nextLink` / `$skiptoken`.
- Do not use SDK `skip` / OData `$skip` for Dataverse heavy-list paging. Dataverse doesn't support `$skip` for paging; use `skipToken`.
- Do not treat a first request with `top: 50` as pagination. That is only the first page.
- Use deterministic ordering for paged results. Include a unique key, preferably the table primary key, after the user-facing sort.
- Select only the columns the UI renders.

The native code-app rule is service-first: use generated services from `src/generated/`, not direct Dataverse REST. Current real generated Dataverse services call `retrieveMultipleRecordsAsync` and accept `getAll({ maxPageSize, filter, orderBy, select, skipToken })`; the result is `IOperationResult<T[]>` with `data` and optional `skipToken`. Older mock/prototype services may only expose `getAll({ filter, orderBy, top, select })` and return an array; those are single-page mocks and are not enough for an unbounded production list.

### Cursor list with the shared hook

```typescript
import { useCursorListData } from '@/hooks';
import { containsFilter } from '@/utils';
import { Cr123_jobvisitService } from '@/generated/services/Cr123_jobvisitService';
import type { Cr123_jobvisit } from '@/generated/models/Cr123_jobvisitModel';

const {
  items,
  loading,
  refreshing,
  loadingMore,
  hasNextPage,
  error,
  query,
  setQuery,
  onRefresh,
  refetch,
  loadMore,
} = useCursorListData<Cr123_jobvisit>({
  queryKey: ['jobvisits'],
  fetchPage: ({ pageSize, search, skipToken }) => Cr123_jobvisitService.getAll({
    maxPageSize: pageSize,
    orderBy: ['createdon desc', 'cr123_jobvisitid asc'],
    select: ['cr123_name', 'cr123_status', 'createdon'],
    ...(search ? { filter: containsFilter('cr123_name', search) } : {}),
    ...(skipToken ? { skipToken } : {}),
  }),
});
```

Wire the returned state into `FlatList`:

```tsx
<FlatList
  data={items}
  keyExtractor={(item) => item.cr123_jobvisitid}
  renderItem={({ item }) => <VisitRow item={item} />}
  refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
  onEndReached={hasNextPage ? loadMore : undefined}
  onEndReachedThreshold={0.3}
  ListFooterComponent={loadingMore ? <Spinner size="small" /> : null}
  ListEmptyComponent={<EmptyState title={query ? 'No matching visits' : 'No visits scheduled'} />}
/>
```

`useCursorListData` accepts page results shaped as an SDK `IOperationResult<T[]>` (`{ data, skipToken }`) and also tolerates `{ value }`, `{ items }`, `nextLink`, `nextSkipToken`, `skiptoken`, or `@odata.nextLink` for compatibility. An array result is treated as a single bounded page, so it is not enough for an unbounded production list unless the service also returns a cursor.

---

## Server-Side Search with `filter`

Never filter a heavy Dataverse list client-side. Push search into the generated service's `filter` option and reset pagination when the query changes. The shared cursor hook debounces `query` and includes it in the query key.

```typescript
import { containsFilter } from '@/utils';

const filter = containsFilter('cr123_name', search);
const result = await Cr123_jobvisitService.getAll({
  maxPageSize: 50,
  filter,
  orderBy: ['createdon desc', 'cr123_jobvisitid asc'],
  select: ['cr123_name', 'cr123_status', 'createdon'],
});
```

`containsFilter` trims empty search text and escapes single quotes using the Dataverse OData string-literal rule.

---

## `orderBy` and `select`

Always specify both on large lists:

```typescript
maxPageSize: 50,
orderBy: ['createdon desc', 'cr123_jobvisitid asc'],
select: ['cr123_name', 'cr123_status', 'createdon'],
```

The primary key is usually returned even if not selected, but include it in `orderBy` for deterministic paging. Avoid paging orders that rely only on status, choices, names, descriptions, calculated fields, or other non-unique values.

---

## Cross-entity Reads

The single source of truth for how a screen displays a column that lives on a **different entity** than the one it primarily fetches. Every other file in this repo (`agents/screen-builder.md`, `agents/screen-planner.md`, `agents/data-model-architect.md`, `agents/native-app-planner.md`, `skills/setup-datamodel/SKILL.md`, `skills/add-dataverse/SKILL.md`) references this section — do not duplicate the rule elsewhere.

### When to apply

Whenever a UI field on a screen displays data sourced from an entity OTHER than the screen's primary `*Service.getAll(...)` / `*Service.get(...)` target. Examples:

- Inspections list shows "Gate name" → gate name lives on `cr3e9_gate`, screen fetches `cr3e9_inspection` → cross-entity read
- Inspection detail shows "Inspector email" → email lives on `systemuser`, screen fetches `cr3e9_inspection` → cross-entity read
- Order detail shows "Customer phone" → phone lives on `contact`, screen fetches `salesorder` → cross-entity read

### Why two patterns exist (calculated column AND chained fetch)

The Power Apps SDK's `IGetAllOptions` / `IGetOptions` interfaces have **no `expand` field**. Passing `$expand` is silently dropped at runtime — the related fields come back `undefined`, the screen renders `—`, and the user thinks the data is missing. So the standard OData answer ("just expand the lookup") doesn't work.

Two patterns remain. Their cost profiles are very different, so the right pick depends on **screen archetype × relationship cardinality**:

- **Calculated column** — denormalize the related field onto the parent table at the data-model layer. One round trip per page load, no N+1, no per-row jank. Best for hot paths (lists, dashboards, tab roots).
- **Chained fetch** — call a second `Service.get(...)` inside the screen's load step. One extra network round trip per screen load. Acceptable for cold paths (a single detail screen). Disastrous on lists (one extra fetch per row × 50 rows = N+1 fetch storm).

### Decision table (the rule)

| Screen archetype | Relationship | Action |
|---|---|---|
| **List** (`top ≥ 5`), **Tab-root**, **Dashboard** | 1:1 (N:1 lookup chain) | **REFUSE to scaffold the field.** Recommend the user re-run `/setup-datamodel` (or `/add-dataverse` for existing apps) to add a calc column on the parent entity. Do NOT scaffold N+1 chained fetches on list screens — visible jank on a list of 50. |
| **Detail** (single record, cold path) | 1:1 (N:1 lookup chain) | Scaffold a chained fetch in the screen's load step. One extra round trip is fine for a single record. |
| **Any screen** | 1:many or M:N | Scaffold a chained `*Service.getAll(...)` with `_<parentid>_value eq '${id}'` filter. **Calc columns CANNOT traverse 1:many or M:N** — Dataverse only supports calc-column formulas across N:1 (single-valued) navigation properties. |

Verification: every UI field on a screen spec must end up with EITHER a `select` entry (covered by primary fetch or calc column) OR a chained fetch path (separate `Service.get` / `Service.getAll`). If neither, fail with `BLOCKED: <field> on <screen> has no fetch path`.

### Pattern A: Calculated column (preferred for list / hot path)

A calculated column lives on the parent entity and resolves its value via a dotted-path formula traversing N:1 lookups. The Dataverse server computes it at read time, so the screen sees it as an ordinary column in `select: [...]`.

**Naming convention:** `<prefix>_<resolved_field>_calc` — e.g. `cr3e9_gatename_calc`, `cr3e9_flightnumber_calc`. The `_calc` suffix is mandatory; it tells the screen-builder this is a denormalized read-only field (never write to it, never put it in a create/update payload).

**Adding the column:** done by the data-model-architect in its Step 6a Cross-entity Read Audit (writes a row to the `### Cross-entity Reads` subsection of `_dm_section.md`), then created by `/setup-datamodel` Phase 6.1b (or `/add-dataverse` Phase 6.1b for existing apps) via `scripts/create-calculated-column.js`.

**Screen-builder consumption** — once the calc column exists in `src/generated/models/<Entity>Model.ts`, just add it to `select`:

```typescript
// Before — gate name unavailable, renders "—"
const res = await Cr3e9_inspectionsService.getAll({
  select: ['cr3e9_inspectionid', 'cr3e9_status', '_cr3e9_flightid_value'],
  top: 50,
});

// After — calc column added at data-model layer, one round trip
const res = await Cr3e9_inspectionsService.getAll({
  select: [
    'cr3e9_inspectionid',
    'cr3e9_status',
    '_cr3e9_flightid_value',
    'cr3e9_gatename_calc',      // ← from calc column
    'cr3e9_flightnumber_calc',  // ← from calc column
  ],
  top: 50,
});

// In renderItem
<Text>{record.cr3e9_gatename_calc ?? '—'}</Text>
```

### Pattern B: Chained fetch (preferred for detail / cold path)

A chained fetch is a second `Service.get(...)` (for 1:1) or `Service.getAll(...)` (for 1:many / M:N) inside the screen's load step. Use only on detail screens (one record on screen) or for collections that genuinely need a parent-id filter.

**1:1 chain (detail screen only):**

```typescript
// app/(app)/inspections/[id]/index.tsx — Detail screen
const inspResult = await Cr3e9_inspectionsService.get(id);
const flightId = inspResult.data?._cr3e9_flightid_value;
const flightResult = flightId
  ? await Cr3e9_flightsService.get(flightId, {
      select: ['cr3e9_flightnumber', '_cr3e9_gateid_value', '_cr3e9_aircraftid_value'],
    })
  : null;

// In JSX
import { lookupName } from '@/utils';
<Text>{flightResult?.data?.cr3e9_flightnumber ?? '—'}</Text>
<Text>{lookupName(flightResult?.data, 'cr3e9_gateid') ?? '—'}</Text>
```

**1:many or M:N chain (any screen — calc columns can't traverse this):**

```typescript
// app/(app)/inspections/[id]/index.tsx — list defects belonging to this inspection
const defectsResult = await Cr3e9_defectsService.getAll({
  filter: `_cr3e9_inspectionid_value eq '${id}'`,
  select: ['cr3e9_defectid', 'cr3e9_severity', 'cr3e9_summary'],
  orderBy: ['cr3e9_severity desc'],
});
```

**Hard rule — NEVER chain inside a list `map()` / `FlatList renderItem`.** That's the N+1 trap: 50 list rows × 1 extra fetch each = 50 extra network calls per page load. Visible scroll jank. Battery drain on mobile. If a list needs cross-entity data, it needs a calc column — not a chained fetch.

### Limits

- **Calc columns can only traverse N:1** (single-valued navigation properties). 1:many and M:N must use chained fetch.
- **Calc columns cannot reference other calc columns** in the same formula chain (Dataverse limitation — a calc on a calc is rejected at create time).
- **Calc columns are read-only** — never include them in a create/update payload (Dataverse 400s on write).
- **`$filter` on calc columns is restricted** — some operators (`contains`, `startswith`) work, others may not. If a screen needs to filter / sort on a calc-resolved field, query the `microsoft-learn` MCP server first to confirm the exact operator support, or fall back to a chained fetch + client-side filter.
- **Don't denormalize fields that change frequently** — the resolution happens at read time so the value is technically live, but indexes on calc columns may not refresh as fast as the source.

### How the screen-builder applies this

The screen-builder's "Cross-entity Field Resolution" rule (in `agents/screen-builder.md`) walks every UI field in its assigned spec, checks for a `<prefix>_<field>_calc` column on the primary entity model, and either selects the calc column OR scaffolds a chained fetch OR returns `BLOCKED` based on the decision table above. See `agents/screen-builder.md` for the exact algorithm.

### How the data-model-architect proposes this

The screen-planner emits a `related_entity_fields` block in each per-screen spec (in `_screens_section.md`) with cardinality + archetype + recommendation. The data-model-architect's Step 6a Cross-entity Read Audit reads that block, derives calc columns for every entry tagged `recommends: calc-column`, and adds them to the `### Cross-entity Reads` subsection of `_dm_section.md`. The orchestrator presents this to the user at Gate 1. See `agents/data-model-architect.md` Step 6a and `agents/screen-planner.md` Step 4 (per-screen spec shape).

---

## Quick Reference

| Need | Generated-service option | Example |
|---|---|---|
| Limit page size | `maxPageSize` | `maxPageSize: 50` |
| Next page | `skipToken` | from `IOperationResult.skipToken` |
| Filter server-side | `filter` | `contains(name, 'foo')` |
| Sort | `orderBy` | `['createdon desc', 'cr123_id asc']` |
| Reduce payload | `select` | `['id', 'name', 'status']` |
| Cross-entity field (list / hot) | calc column | `cr3e9_gatename_calc` in `select` |
| Cross-entity field (detail / cold) | chained `Service.get` | `Cr3e9_flightsService.get(flightId)` after primary fetch |
| expand/join fields | NOT SUPPORTED in current generated options | use calc column or chained fetch — see Cross-entity Reads above |

---

## Where This Is Enforced

- `shared/references/mobile-ui-patterns.md` — pagination is a required rule for List screens that query unbounded tables
- `screen-planner` — flags `pagination: cursor` in per-screen spec for List archetypes with unbounded data; emits `related_entity_fields` block per screen
- `screen-builder` — applies pagination pattern when spec says `pagination: cursor`; applies the Cross-entity Field Resolution rule on every UI field
- `data-model-architect` — Step 6a Cross-entity Read Audit reads planner's `related_entity_fields` blocks and proposes calc columns
- `/setup-datamodel` and `/add-dataverse` — Phase 6.1b creates calc columns via `scripts/create-calculated-column.js`
