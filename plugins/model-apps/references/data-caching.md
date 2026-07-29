# Data Fetching Pattern (Dataverse pages — de-dupe + cache)

**Read this when:** a page fetches Dataverse data on mount via `props.dataApi`.
This is the default for **any** data-backed page — not only list/detail pages.
The in-flight de-dupe below is what makes a page survive the genpage host's
**double mount** (see below); the resolved cache additionally skips the spinner
on return navigation. Skip this ONLY for pages that never fetch on mount:
mock-data pages, forms with no initial fetch, and short-lived dialogs.

## Why this pattern is needed

Two independent platform behaviors make a naive on-mount fetch run more than once:

1. **The host double-mounts the page on open.** When a generative page opens,
   the PowerApps webplayer host launches the hosted app twice — a cached mount,
   then a cache-bypassing re-mount ~300ms later (observed as two
   `POST .../powerapps/apps/<app>/launch` calls, the second with
   `bypass-cache=true`). Each fresh mount re-runs the data effect. This happens
   **even when the effect's dependency array is correct**, so it cannot be fixed
   by tuning deps alone — it must be de-duped.
2. **`dataApi` is a new reference every render.** The host hands a fresh
   `dataApi` object on each render. Putting `dataApi` in a `useEffect` /
   `useMemo` / `useCallback` dependency array therefore re-fires the effect on
   every render (not just on mount). **Never put `dataApi` in a dependency
   array** — depend on a readiness boolean instead (see the pattern).

`window` state survives both the module re-evaluation the host does on
navigation AND the double-mount (the second mount runs in the same window), so
the fix lives on `window`:

- **In-flight promise** (`window.__pp<Entity>Inflight`) — concurrent mounts share
  ONE pending fetch, so the double-mount makes a single network round-trip.
- **Resolved cache** (`window.__pp<Entity>Cache`) — once resolved, later mounts
  and return visits read the cache: no re-fetch, no spinner.

Always use a **single batched state object** (`{ records, loading, error }`) and
one `setData(...)` call to avoid intermediate renders in React 17.

## Pattern 1 — List / array cache

Use for any page that fetches a set of rows on mount.

```typescript
// Module-level key aliases. The VALUES live on `window` (the single source of
// truth) so they stay coherent across module re-evaluation and the double-mount.
// IMPORTANT: make each key UNIQUE PER PAGE + QUERY (include the page name), never
// entity-only — two different pages that query the same entity with different
// select/filter must NOT share a cache or in-flight entry, or the second page
// reads the first's rows (missing columns) or awaits the wrong query. `MyEntity`
// below stands for "<PageName>_<entity>", e.g. "AccountOverview_account".
const winAny = window as any;
const CACHE_KEY = "__ppMyEntityCache";
const INFLIGHT_KEY = "__ppMyEntityInflight";

// In component:
const dataReady = !!dataApi;   // the host may hand `dataApi` after first render
const [{ records, loading, error }, setData] = useState<{
    records: MyRow[];
    loading: boolean;
    error: string | null;
}>(() => {
    const cached = winAny[CACHE_KEY] as MyRow[] | undefined;
    return { records: cached ?? [], loading: cached === undefined, error: null };
});

useEffect(() => {
    if (!dataReady) return;   // wait until the host hands us the DataAPI

    // Read the AUTHORITATIVE window cache (never a module-local snapshot): the
    // other mount may have resolved it between this mount's render and this
    // effect, and a module re-eval can leave a local copy stale. Sync state on a
    // hit (reference compare avoids a redundant render) so we never stick on the
    // spinner and we pick up an invalidated/replaced array.
    const cached = winAny[CACHE_KEY] as MyRow[] | undefined;
    if (cached !== undefined) {
        if (records !== cached) setData({ records: cached, loading: false, error: null });
        return;
    }
    let cancelled = false;

    // De-dupe the host double-mount: share ONE in-flight promise on `window` so a
    // racing second mount awaits it instead of firing a duplicate query.
    let inflight = winAny[INFLIGHT_KEY] as Promise<MyRow[]> | undefined;
    if (!inflight) {
        inflight = dataApi
            .queryTable("myentity", { select: ["name", "statuscode"] })  // VERIFIED columns
            .then((result: { rows: MyRow[] }) => {
                winAny[CACHE_KEY] = result.rows;   // window = source of truth
                return result.rows;
            })
            // Clear only if still ours — a concurrent refresh may have replaced
            // this entry with a newer promise we must not delete.
            .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
        winAny[INFLIGHT_KEY] = inflight;
    }

    inflight
        .then((rows) => { if (!cancelled) setData({ records: rows, loading: false, error: null }); })
        .catch(() => { if (!cancelled) setData({ records: [], loading: false, error: "Unable to load records." }); });

    return () => { cancelled = true; };
    // Depend on readiness only — NOT `dataApi` (a new ref each render would
    // re-fire this effect every render). `dataReady` flips false->true once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [dataReady]);
```

## Pattern 2 — Detail / per-record Map cache

Use when a page receives a `recordId` via `pageInput` and displays one record.
The Maps are keyed by `recordId` so multiple detail views cache independently.

```typescript
const winAny = window as any;
// Re-attach to the existing window Maps on module re-eval.
const _detailCache: Map<string, MyRow> =
    winAny.__ppMyEntityDetailCache ?? (winAny.__ppMyEntityDetailCache = new Map());
const _detailInflight: Map<string, Promise<MyRow>> =
    winAny.__ppMyEntityDetailInflight ?? (winAny.__ppMyEntityDetailInflight = new Map());

// In component:
const recordId = pageInput?.recordId;
const dataReady = !!dataApi && !!recordId;
const cachedRecord = recordId ? (_detailCache.get(recordId) ?? null) : null;

const [{ record, loading, error }, setData] = useState(() => ({
    record: cachedRecord,
    loading: !!recordId && cachedRecord === null,
    error: null as string | null,
}));

useEffect(() => {
    if (!dataReady) return;
    const id = recordId as string;

    // Sync from the authoritative window Map on a hit — the other mount may have
    // resolved it between this mount's render and this effect, or `recordId` may
    // have changed in place. Reference compare avoids a redundant render.
    const hit = _detailCache.get(id);
    if (hit !== undefined) {
        if (record !== hit) setData({ record: hit, loading: false, error: null });
        return;
    }
    let cancelled = false;

    // Share one in-flight fetch per recordId across concurrent mounts.
    let pending = _detailInflight.get(id);
    if (!pending) {
        pending = dataApi
            .retrieveRow("myentity", { id, select: ["name", "statuscode"] })  // VERIFIED columns
            .then((row: MyRow) => { _detailCache.set(id, row); return row; })
            // Delete only if still ours (a concurrent refresh may have replaced it).
            .finally(() => { if (_detailInflight.get(id) === pending) _detailInflight.delete(id); });
        _detailInflight.set(id, pending);
    }

    pending
        .then((row) => { if (!cancelled) setData({ record: row, loading: false, error: null }); })
        .catch(() => { if (!cancelled) setData({ record: null, loading: false, error: "Unable to load record." }); });

    return () => { cancelled = true; };
    // Readiness + recordId only — never `dataApi`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [dataReady, recordId]);
```

## Cache invalidation and manual refresh

After a mutation (create/update/delete), or when a manual refresh control fires,
evict the relevant cache(s) **and any in-flight promise** before refetching, then
bump a `reloadKey` state so the effect re-runs. Clear the in-flight entry too —
otherwise the effect reuses the stale pending promise instead of fetching fresh:

```typescript
await dataApi.updateRow("myentity", recordId, changes);
const w = window as any;

// Detail: evict just the one row + its in-flight entry.
_detailCache.delete(recordId);
_detailInflight.delete(recordId);

// List: evict the whole array + its in-flight promise so the next mount refetches.
delete w.__ppMyEntityCache;
delete w.__ppMyEntityInflight;

// Then trigger a re-run (readiness dep won't change, so use an explicit key):
setReloadKey((k) => k + 1);   // add `reloadKey` to the effect's dep array
```

When a page has a manual refresh button or a `reloadKey`, add it to the effect's
dependency array alongside `dataReady` (e.g. `[dataReady, reloadKey]`).

> **Concurrency note.** Because the effect reads the `window` cache as the source
> of truth, deleting the cache key here makes the next mount refetch. One residual
> edge case: if you invalidate while an *earlier* fetch is still in flight, that
> earlier promise can still write its (now stale) result into the cache when it
> resolves. For pages with frequent mutations racing initial loads, gate cache
> writes behind a `window.__pp<Entity>Gen` counter you bump on every invalidation,
> and only write the cache when the captured generation still matches. For the
> common single-load-then-mutate flow this is unnecessary.

## Scope — de-dupe always, cache when it helps

The **in-flight de-dupe** (and readiness-only deps) applies to **any page that
fetches on mount** — it is the fix for the host double-mount, so don't skip it.

Skip the whole pattern only for pages that **never fetch on mount**:
- Mock-data pages (no real fetch)
- Forms with no initial fetch

For the **resolved cache** specifically, keep the de-dupe but drop (or
short-TTL) the persisted array/Map when:
- The page must always show fresh data (real-time dashboards) — clear
  `__pp<Entity>Cache` after first paint, or refetch on a timer.
- The data set is large enough that `window` retention is a memory concern.

## What to substitute in the snippets above

Replace these placeholders with values verified from `RuntimeTypes.ts`:

| Placeholder | Replace with |
|-------------|--------------|
| `MyRow` | The actual `TableRow<...>` type for your entity |
| `"myentity"` | The entity's logical name (singular, lowercase) |
| `__ppMyEntityCache` / `__ppMyEntityDetailCache` | Unique per **page + query** — include the page name, not just the entity, so two pages querying the same entity with different select/filter don't collide (e.g. `__ppAccountOverview_accountCache`) |
| `__ppMyEntityInflight` / `__ppMyEntityDetailInflight` | The in-flight promise — same page+query scoping as the cache key |
| `select: [...]` | Actual column names from RuntimeTypes.ts |
