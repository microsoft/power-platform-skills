# Data Caching Pattern (Dataverse list/detail pages)

**Read this when:** a Dataverse page fetches data on mount AND the user is
likely to navigate away and return (e.g., list page paired with a detail page,
or a tabbed UI that can be re-opened). Do NOT apply blindly to every Dataverse
page — single-visit pages, forms with no fetching, and short-lived dialogs
don't need caching.

## Why caching is needed

The genpage platform **re-evaluates the module script on every navigation**.
Module-level variables (`let _cache = null`) reset on each visit. Without
caching, return visits re-fetch and re-show a loading spinner even when the
data hasn't changed.

## How the cache works

Persist data on the `window` object using the naming convention
`window.__pp<EntityName>Cache`. The `window` object survives module re-evaluation
within the browser tab's lifetime.

Always use a **single batched state object** (`{ records, loading, error }`)
to avoid intermediate renders in React 17.

## Pattern 1 — List page (array cache)

Use when a page shows a list/grid of records and the user may navigate away
(e.g., to a detail page) and return.

```typescript
// Module-level: read from window on eval (survives navigation)
let _recordsCache: MyRow[] | null = (window as any).__ppMyEntityCache ?? null;

// In component:
const [{ records, loading, error }, setData] = useState<{
    records: MyRow[];
    loading: boolean;
    error: string | null;
}>({ records: _recordsCache ?? [], loading: _recordsCache === null, error: null });

useEffect(() => {
    if (!dataApi) { setData(prev => ({ ...prev, loading: false })); return; }
    if (_recordsCache !== null) return; // already cached — skip fetch, no spinner
    (async () => {
        try {
            const result = await dataApi.queryTable("myentity", {
                select: ["name", "statuscode"],   // use VERIFIED column names
            });
            _recordsCache = result.rows;
            (window as any).__ppMyEntityCache = result.rows;
            setData({ records: result.rows, loading: false, error: null });
        } catch (err) {
            if (_recordsCache === null) {
                setData({ records: [], loading: false, error: "Unable to load records." });
            }
        }
    })();
}, [dataApi]);
```

## Pattern 2 — Detail page (per-record Map cache)

Use when a page receives a `recordId` via `pageInput` and displays a single
record. The Map keyed by `recordId` caches multiple detail views.

```typescript
// Module-level: IIFE re-attaches to the existing window Map on module re-eval
const _detailCache: Map<string, MyRow> = (() => {
    if (!(window as any).__ppMyEntityDetailCache) {
        (window as any).__ppMyEntityDetailCache = new Map<string, MyRow>();
    }
    return (window as any).__ppMyEntityDetailCache;
})();

// In component:
const recordId = pageInput?.recordId;
const cachedRecord = recordId ? (_detailCache.get(recordId) ?? null) : null;

const [{ record, loading, error }, setData] = useState({
    record: cachedRecord,
    loading: !!recordId && cachedRecord === null,
    error: null as string | null,
});

useEffect(() => {
    if (!dataApi || !recordId) return;
    if (_detailCache.has(recordId)) return; // cached — no spinner
    (async () => {
        try {
            const row = await dataApi.retrieveRow("myentity", {
                id: recordId,
                select: ["name", "statuscode"],   // use VERIFIED column names
            });
            _detailCache.set(recordId, row);
            setData({ record: row, loading: false, error: null });
        } catch (err) {
            if (!_detailCache.has(recordId)) {
                setData({ record: null, loading: false, error: "Unable to load record." });
            }
        }
    })();
}, [dataApi, recordId]);
```

## Cache invalidation

After a mutation (create/update/delete via `dataApi`), invalidate the
relevant cache(s) before refetching. Each cache lives at its own `window`
key — be precise about which one you're clearing:

```typescript
await dataApi.updateRow("myentity", recordId, changes);

// 1) Detail cache (Map keyed by recordId) — just evict the one row:
_detailCache.delete(recordId);

// 2) List cache (whole array) — evict the entire array so the list refetches
//    next time it mounts. The cache is at __ppMyEntityCache (NOT ...DetailCache):
delete (window as any).__ppMyEntityCache;
```

If the page only has a detail cache (no sibling list), skip step 2. If you
have a list but no detail page open, skip step 1.

## When NOT to use this pattern

- Forms that submit and navigate away (no return path)
- Mock-data pages (no real fetch to cache)
- Pages that must always show fresh data (real-time dashboards)
- Pages visited only once per session
- When the data set is large enough that `window` retention becomes a memory concern

## What to substitute in the snippets above

Replace these placeholders with values verified from `RuntimeTypes.ts`:

| Placeholder | Replace with |
|-------------|--------------|
| `MyRow` | The actual `TableRow<...>` type for your entity |
| `"myentity"` | The entity's logical name (singular, lowercase) |
| `__ppMyEntityCache` / `__ppMyEntityDetailCache` | `__pp<EntityName>Cache` — distinct per entity to avoid collisions |
| `select: [...]` | Actual column names from RuntimeTypes.ts |
