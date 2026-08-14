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

### Supported read paths

The Power Apps SDK's `IGetAllOptions` / `IGetOptions` interfaces have **no `expand` field**. Passing `$expand` is silently dropped at runtime — the related fields come back `undefined`, the screen renders `—`, and the user thinks the data is missing. So the standard OData answer ("just expand the lookup") doesn't work.

Use one of these supported paths:

- **Formatted lookup annotation** — when the UI needs only the primary display
  name of a direct lookup already present on the fetched record, use
  `lookupName(record, '<lookupLogicalName>')` / `formattedValue(...)`.
- **Chained fetch** — call a second `Service.get(...)` once in a detail load, or
  `Service.getAll(...)` for a bounded related collection.
- **External projection required** — for a hot list/dashboard field that is not
  the direct lookup display name. Omit the field until the user creates a
  supported server-owned projection outside this workflow.

Dataverse exposes formula metadata, but Microsoft does not support defining
calculated, rollup, or formula expressions through code. Never synthesize
workflow XAML or formula serialization.

### Decision table (the rule)

| Screen archetype | Relationship | Action |
|---|---|---|
| **List** (`top ≥ 5`), **Tab-root**, **Dashboard** | Direct N:1 lookup primary display name | Use the formatted lookup annotation. |
| **List** (`top ≥ 5`), **Tab-root**, **Dashboard** | Any other related field | Mark `external-projection-required` and omit it. Do not scaffold N+1 reads or synthesize a formula definition. |
| **Detail** (single record, cold path) | 1:1 (N:1 lookup chain) | Scaffold a chained fetch in the screen's load step. One extra round trip is fine for a single record. |
| **List**, **Tab-root**, **Dashboard** | 1:many or M:N per-row field/aggregate | Mark `external-projection-required`; never fetch once per row. |
| **Detail/Form/Modal** | 1:many | Scaffold a bounded chained `*Service.getAll(...)` with `_<parentid>_value eq '${id}'` filter. |
| **Detail/Form/Modal** | M:N | Mark `external-projection-required` unless the plan names a generated intersect-table service and exact bounded query contract. |

Verification: every UI field must have a primary `select`, formatted lookup, or bounded chained fetch. Otherwise return `BLOCKED: <field> on <screen> requires an external projection`.

### Pattern A: Formatted lookup annotation

For the primary display value of a direct lookup, select the lookup ID and read
the formatted annotation already returned by Dataverse:

```typescript
const res = await Cr3e9_inspectionsService.getAll({
  select: ['cr3e9_inspectionid', 'cr3e9_status', '_cr3e9_flightid_value'],
  top: 50,
});

import { lookupName } from '@/utils';
<Text>{lookupName(record, 'cr3e9_flightid') ?? '—'}</Text>
```

### Pattern B: Chained fetch

A chained fetch is a second `Service.get(...)` (for 1:1) or
`Service.getAll(...)` (for 1:many) inside the screen's load step. M:N reads
require an explicit intersect-table service contract.

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

**1:many chain:**

```typescript
// app/(app)/inspections/[id]/index.tsx — list defects belonging to this inspection
const defectsResult = await Cr3e9_defectsService.getAll({
  filter: `_cr3e9_inspectionid_value eq '${id}'`,
  select: ['cr3e9_defectid', 'cr3e9_severity', 'cr3e9_summary'],
  orderBy: ['cr3e9_severity desc'],
});
```

**Hard rule — NEVER chain inside a list `map()` / `FlatList renderItem`.**
Use the direct lookup annotation or omit the field until an external projection exists.

### Limits

- Formatted lookup annotations expose only the direct lookup's primary display value.
- Chained reads must be bounded and executed once per screen load, never per row.
- A manually created formula/calculated column can be reused only when reconciliation validates its source type and exact `FormulaDefinition`.
- This workflow never creates or updates formula definitions through code.

### How the screen-builder applies this

The screen-builder selects a formatted lookup, scaffolds one bounded chained fetch, or returns `BLOCKED` for an external projection.

### How the data-model-architect proposes this

The screen-planner emits a `related_entity_fields` block with cardinality,
archetype, and one of `formatted-lookup`, `chained-fetch`, or
`external-projection-required`. The data-model architect verifies the path and
does not synthesize formula metadata.

---

## Quick Reference

| Need | Generated-service option | Example |
|---|---|---|
| Limit page size | `maxPageSize` | `maxPageSize: 50` |
| Next page | `skipToken` | from `IOperationResult.skipToken` |
| Filter server-side | `filter` | `contains(name, 'foo')` |
| Sort | `orderBy` | `['createdon desc', 'cr123_id asc']` |
| Reduce payload | `select` | `['id', 'name', 'status']` |
| Direct lookup display (list / hot) | formatted lookup annotation | `lookupName(record, 'cr3e9_productid')` |
| Other cross-entity field (list / hot) | external projection required | omit until supplied |
| Cross-entity field (detail / cold) | chained `Service.get` | `Cr3e9_flightsService.get(flightId)` after primary fetch |
| expand/join fields | NOT SUPPORTED in current generated options | use formatted lookup or bounded chained fetch |

---

## Where This Is Enforced

- `shared/references/mobile-ui-patterns.md` — pagination is a required rule for List screens that query unbounded tables
- `screen-planner` — flags `pagination: cursor` in per-screen spec for List archetypes with unbounded data; emits `related_entity_fields` block per screen
- `screen-builder` — applies pagination pattern when spec says `pagination: cursor`; applies the Cross-entity Field Resolution rule on every UI field
- `data-model-architect` — Step 6a verifies every related field has a supported read path
- `/setup-datamodel` and `/add-dataverse` — never synthesize formula definitions; they validate any user-supplied computed dependency before reuse
