/**
 * Data Caching Across Navigations
 *
 * The genpage platform re-evaluates the module script on every navigation,
 * resetting module-level variables. These patterns persist data on `window`
 * so return visits render instantly without a loading spinner.
 *
 * Naming convention: window.__pp<EntityName>Cache to avoid collisions.
 * Always use a single batched state object ({ records, loading, error })
 * to avoid intermediate renders in React 17.
 */

// =============================================================================
// 1. LIST PAGE — array cache
// =============================================================================
// Use when a page shows a list/grid of records and the user may navigate
// away (e.g., to a detail page) and return.

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
            const result = await dataApi.queryTable("myentity", { select: [...] });
            _recordsCache = result.rows;
            (window as any).__ppMyEntityCache = result.rows; // persist through navigation
            setData({ records: result.rows, loading: false, error: null });
        } catch (err) {
            if (_recordsCache === null) {
                setData({ records: [], loading: false, error: "Unable to load records." });
            }
        }
    })();
}, [dataApi]);


// =============================================================================
// 2. DETAIL PAGE — per-record Map cache
// =============================================================================
// Use when a page receives a recordId via pageInput and displays a single
// record. The Map keyed by recordId caches multiple detail views.

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
    record: cachedRecord, loading: !!recordId && cachedRecord === null, error: null as string | null,
});

useEffect(() => {
    if (!dataApi || !recordId) return;
    if (_detailCache.has(recordId)) return; // cached — no spinner
    (async () => {
        try {
            const row = await dataApi.retrieveRow("myentity", { id: recordId, select: [...] });
            _detailCache.set(recordId, row);
            setData({ record: row, loading: false, error: null });
        } catch (err) {
            if (!_detailCache.has(recordId)) {
                setData({ record: null, loading: false, error: "Unable to load record." });
            }
        }
    })();
}, [dataApi, recordId]);
