# Data Performance Reference

Patterns for handling large datasets in Power Apps mobile apps. Uses only what the template already ships — no additional libraries required.

---

## When to Apply

Apply these patterns whenever a List screen queries a Dataverse table that can grow without a natural ceiling:
- Work orders, inspections, visits, tickets, transactions, audit logs
- Any table where users create records over time

**Skip for:** small lookup tables (status types, categories, job types) where total rows are bounded and known.

The `screen-planner` flags this in the per-screen spec as `pagination: cursor` or `pagination: none`.

## Query availability

New apps use Power Apps SDK `1.6.0` and CLI `1.4.1` from the template.
These releases support `expand` on `get`/`getAll`, `apply` on `getAll`,
generic result projections, and `getSavedQuery` with complete-link pagination.
FetchXML execution, SQL, typed parameter aliases, and personal `userQuery`
APIs are not part of this contract. Do not invent service methods for them.

Before planning new queries, inspect the installed packages, not just manifest
ranges. After generating services, and again before shipping a new query, run:

```bash
node "${PLUGIN_ROOT}/scripts/check-dataverse-query-support.js" \
  --project-root '<working_dir>'
```

The report separates SDK support from each retained service's generated
options/methods. For a required query, add `--table '<logical-name>' --require
expand` (or `apply`, `saved-query`, or a comma-separated set). Only gate the
services/features actually used. Missing services, stale generated options,
and failed type-checks are blockers, not permission to hand-edit generated code.
Include the verified features alongside the Generated Services snapshot.
Recheck after dependency, binding, environment, or generated-code changes.

**Existing apps are not migrated.** Keep their current queries and computed
columns. `/check-updates` can offer individually approved SDK/CLI updates and
tell the user to refresh retained data sources. It does not rewrite screens,
replace the template, delete columns, or run refresh on the user's behalf.
A dependency upgrade alone does not refresh services or adopt new queries.

This is the **online Dataverse** contract. The native online bridge forwards
SDK-built queries; native offline execution is owned by a different runtime.
Do not assume expand, apply, saved queries, or SDK mocks work offline. For a
screen required offline, verify that runtime's exact query support and related
table/column/profile coverage, or retain an approved supported read path.
Never silently fall back to an online request, unfiltered rows, or fake values.
Do not apply these Dataverse-only features to connector services.

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

`useCursorListData` accepts SDK `IOperationResult<T[]>` and checks `success:
false` even when `error` is absent. Its default `cursorMode: 'skipToken'`
preserves ordinary OData callers. An array result is one bounded page, not
production pagination. Mock data is only used when fetching is explicitly
disabled; a failed or empty real response never becomes mock success.
Include environment, table, filters, ordering, selected/expanded fields, and
query identity in `queryKey`; changing any of them must restart pagination.
Pull-to-refresh restarts from page one.

### Saved system views

Use the generated `getSavedQuery<TResult>(savedQueryId, { maxPageSize,
nextLink })` for an approved **system view** belonging to that table in the
selected environment. Verify its ID, expected columns/aliases, and access.
A GUID's syntax does not prove that the correct view exists. Saved queries
omit null-valued properties, so model optional fields explicitly and fail if
a required identity/display column is absent.

```typescript
type ActiveContactRow = { contactid: string; fullname?: string };

const contacts = useCursorListData<ActiveContactRow>({
  queryKey: ['contacts', environmentId, savedQueryId],
  cursorMode: 'nextLink',
  fetchPage: ({ pageSize, nextLink }) => ContactsService.getSavedQuery<ActiveContactRow>(
    savedQueryId,
    { maxPageSize: pageSize, ...(nextLink ? { nextLink } : {}) },
  ),
});
```

Pass the complete returned link unchanged to the same service/view. Do not
extract its skip token, decode/re-encode it, append options, or log/persist
it in telemetry or plans. The SDK rejects a different environment/table;
only reuse links from the current query chain. Generic `getAll` still uses
`skipToken`: its public options do not accept `nextLink`.

The saved-query options do not accept arbitrary `filter`, `orderBy`, `select`,
`expand`, or `apply`. The view owns selection and ordering. If search/sort is
required, plan a supported OData query instead; do not filter just loaded rows.
The SDK mock executor rejects saved queries rather than returning all records.

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

Always specify both on ordinary large OData lists (saved views own them, and
aggregate projections use the contract below):

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

For new queries on a supported SDK and generated service, use these paths:

- **Formatted lookup annotation** — when the UI needs only the primary display
  name of a direct lookup already present on the fetched record, use
  `lookupName(record, '<lookupLogicalName>')` / `formattedValue(...)`. This
  adds no schema mutation and no additional request.
- **Expand** — use `expand: ['<navigation>($select=<columns>)']` on the primary
  service, with a nullable, app-owned generic result projection. Prefer this
  for arbitrary related scalar fields, including hot lists; create no column.
- **Chained fetch** — for a legacy/unsupported query path, call a second
  `Service.get(...)` once in a detail load, or
  `Service.getAll(...)` for a bounded related collection.
- **External projection required** — report a blocked field when no supported
  read path can meet its requirements. Never quietly omit an approved field.

Dataverse exposes formula metadata, but Microsoft does not support defining
calculated, rollup, or formula expressions through code. Never synthesize
workflow XAML or formula serialization.

### Decision table (the rule)

| Screen archetype | Relationship | Action |
|---|---|---|
| **List** (`top ≥ 5`), **Tab-root**, **Dashboard** | Direct N:1 lookup primary display name | Use the formatted lookup annotation. |
| Any | Arbitrary related scalar / multi-hop N:1 | Prefer narrow single-valued `expand`; verify every navigation hop. Without support, detail may chain; a hot list requires an existing projection or blocks. |
| **Detail/Form/Modal** | 1:many or M:N | Bounded collection expand when legal and complete; otherwise a verified bounded child/intersect service query. |
| **List**, **Tab-root**, **Dashboard** | Per-row collection/aggregate | Prefer one bounded grouped `apply` query joined by parent ID when supported; otherwise an existing owned projection. Never fetch once per row. |

Verification: every UI field must have a primary `select`, formatted lookup, or
verified expanded/aggregate result, existing projection, or bounded chained fetch. Otherwise return
`BLOCKED: <field> on <screen> requires an external projection`.

### Pattern A: Typed expansion

Use the exact navigation names from relationship metadata, not lookup logical
names, relationship schema names, or guessed entity-set names. The normalized
snapshot carries `navigationProperty` for N:1/1:N and
`entity1NavigationProperty` / `entity2NavigationProperty` for M:N. Legacy
snapshots without them require bounded foreground metadata discovery.
New relationships require a post-provisioning metadata read before queries
are finalized. Polymorphic customer/owner lookups need target-specific
navigation properties and nullable branches.

```typescript
type ContactWithAccount = Pick<Contacts, 'contactid' | 'fullname'> & {
  parentcustomerid_account?: Pick<Accounts, 'accountid' | 'name' | 'telephone1'> | null;
};

const result = await ContactsService.getAll<ContactWithAccount>({
  select: ['contactid', 'fullname', '_parentcustomerid_value'],
  expand: ['parentcustomerid_account($select=accountid,name,telephone1)'],
  maxPageSize: 50,
  orderBy: ['fullname asc', 'contactid asc'],
});
if (!result.success) throw result.error ?? new Error('Could not load contacts');
```

Import actual generated model names; the example is not permission to invent
one. A generic projection does not add fields at runtime. Select all required
fields, retain lookup IDs, use optional/null guards, and keep projection types
outside `src/generated/`. Expanded objects never belong in create/update
payloads. Related-record writes must invalidate consuming query caches.

Dataverse allows up to 15 expand options and restricts nested collection
options. In particular, do not combine nested collection expand with unsupported
`$top`/`$orderby`, or use `$skip`, `$count`, `$search`, or `$levels` inside
expand. Verify the specific shape against
[Microsoft Learn](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/join-tables).
Only use bounded collection expansions; large child arrays can be worse than
separate paged queries.

Root pagination does not finish child collections. A child
`<navigation>@odata.nextLink` may address a navigation route, which is not the
root-table URL accepted by saved-query continuation. Do not send it to
`getSavedQuery`, bypass the service with HTTP, or count truncated child rows.
Use a supported child-service cursor query; block unsupported M:N continuation
or label a deliberately bounded preview explicitly.

### Pattern B: Formatted lookup annotation

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

### Pattern C: Bounded legacy/detail fetch

A chained fetch is a second `Service.get(...)` (for 1:1) or
`Service.getAll(...)` (for 1:many) inside the screen's load step. Use only on
detail screens (one record on screen) or for collections that genuinely have a
parent lookup field. M:N reads require an explicit intersect-table service
contract; otherwise they are blocked as `external-projection-required`.

**1:1 chain (detail screen only):**

```typescript
// app/(app)/inspections/[id]/index.tsx — Detail screen
const inspResult = await Cr3e9_inspectionsService.get(id);
if (!inspResult.success) throw inspResult.error ?? new Error('Could not load inspection');
const flightId = inspResult.data?._cr3e9_flightid_value;
const flightResult = flightId
  ? await Cr3e9_flightsService.get(flightId, {
      select: ['cr3e9_flightnumber', '_cr3e9_gateid_value', '_cr3e9_aircraftid_value'],
    })
  : null;
if (flightResult && !flightResult.success) throw flightResult.error ?? new Error('Could not load flight');

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
  orderBy: ['cr3e9_severity desc', 'cr3e9_defectid asc'],
  maxPageSize: 50,
});
if (!defectsResult.success) throw defectsResult.error ?? new Error('Could not load defects');
```

For an unbounded detail collection, continue using the shared cursor hook;
one `getAll` call is not a guarantee of completeness.

**Hard rule — NEVER chain inside a list `map()` / `FlatList renderItem`.**
That is the N+1 trap. Use a supported expansion, grouped query, or existing
projection; otherwise block the field rather than displaying incomplete data.

### Aggregations with apply

Use `getAll<AggregateRow>({ apply: ... })`, not a computed column created only
for a dashboard and not a sum/count of the loaded client page:

```typescript
const result = await AccountsService.getAll<{ total: number }>({
  apply: 'aggregate($count as total)',
});
if (!result.success) throw result.error ?? new Error('Could not load account total');
```

Use exact approved aliases and result types; preserve null/empty semantics.
For per-parent totals, query the child table with a bounded parent filter,
group by the verified parent lookup, and merge by ID once per page/load.
Do not run an aggregate for each row or interpret `IOperationResult.count`
as an arbitrary business aggregate. A missing total is not automatically zero.

Dataverse supports only a subset of apply: the source limit is 50,000 records,
datetime grouping and ordering by aggregate values are unsupported. Surface
those failures; do not silently substitute partial client-side totals.
See [aggregate data](https://learn.microsoft.com/power-apps/developer/data-platform/webapi/query/aggregate-data).

### Column fidelity

| Column category | Required handling |
|---|---|
| Text, numbers, decimal, currency, GUID | Preserve generated raw types, precision, nullability, and formatting. |
| Date/time, date-only, timezone-independent | Apply metadata-aware formatting; never blanket-convert related dates to UTC. |
| Boolean, Choice, state/status | Keep raw values and option maps; use `formattedValue` on the actual related row. Do not write labels. |
| Multi-select Choice | Generated root normalization does not recursively normalize expanded rows. At the app-owned result boundary, reuse the SDK's `deserializeMultiSelectPicklistFields` for the metadata-proven related fields; test the wire and normalized shapes. |
| Lookup, owner/customer | Preserve `_<lookup>_value` IDs; use target-specific navigation properties and nullable projections, not virtual `*name` fields. |
| Formula/calculated/rollup | Reuse validated existing read-only columns. Expand does not replace arithmetic, conditions, rollup freshness, or offline dependencies. |
| File/Image | Preserve host pickers and generated upload/download methods. Expand is not binary transfer; never place bytes or expanded objects in scalar write payloads. |
| Secured/missing fields | Respect permissions. Distinguish an operation failure from a valid null/omitted value; never fabricate a column or privileged fallback. |

### Limits

- Formatted lookup annotations expose only the direct lookup's primary display
  value, not arbitrary related columns.
- Chained reads must be bounded and executed once per screen load, never per row.
- A formula/calculated column created manually in Power Apps can be reused only
  when Step 4a validates its source type and exact `FormulaDefinition`.
- This workflow never creates or updates formula definitions through code.

### How the screen-builder applies this

The screen-builder follows the approved resolution and verifies the relevant
service capability before scaffolding. It never silently changes an existing
app's query strategy because a newer SDK has been installed.

### How the data-model-architect proposes this

The screen-planner emits `related_entity_fields` with cardinality, archetype,
and `recommends: formatted-lookup | expand | apply | saved-query | chained-fetch |
external-projection-required`. Expand entries carry the exact navigation path,
selected fields, and execution target. Aggregate/saved-view contracts belong
in the screen's Data field; related entries use `apply` or `saved-query` to name
that verified result source. Saved views need an explicit unique row identity,
especially when joins can repeat parent records. The architect audits metadata and capabilities;
it never synthesizes formula definitions.

---

## Quick Reference

| Need | Generated-service option | Example |
|---|---|---|
| Limit page size | `maxPageSize` | `maxPageSize: 50` |
| Next page | `skipToken` | from `IOperationResult.skipToken` |
| Saved system view | `getSavedQuery<TResult>` | `maxPageSize` + unchanged `nextLink`; hook `cursorMode: 'nextLink'` |
| Aggregate/group | `apply` on `getAll<TResult>` | `aggregate($count as total)` |
| Filter server-side | `filter` | `contains(name, 'foo')` |
| Sort | `orderBy` | `['createdon desc', 'cr123_id asc']` |
| Reduce payload | `select` | `['id', 'name', 'status']` |
| Direct lookup display (list / hot) | formatted lookup annotation | `lookupName(record, 'cr3e9_gateid')` |
| Other cross-entity scalar | `expand` on `get` / `getAll` | exact metadata navigation + nested `$select` |
| Legacy detail fallback | chained `Service.get` | bounded load outside row rendering |

---

## Where This Is Enforced

- `shared/references/mobile-ui-patterns.md` — pagination is a required rule for List screens that query unbounded tables
- `screen-planner` — flags `pagination: cursor` in per-screen spec for List archetypes with unbounded data; emits `related_entity_fields` block per screen
- `screen-builder` — applies pagination pattern when spec says `pagination: cursor`; applies the Cross-entity Field Resolution rule on every UI field
- `data-model-architect` — Step 6a verifies every related field has a supported read path
- `/setup-datamodel` and `/add-dataverse` — never synthesize formula definitions; they validate any user-supplied computed dependency before reuse
