# Data reads — load only for a data-backed screen

Generated `@/generated/services/<Name>Service` is the data layer. Never call raw HTTP,
Graph, `fetch`, or axios. Use the supplied signatures/Generated Services snapshot;
inspect only needed methods and model declarations. If the snapshot is absent,
glob generated services as an older-plan fallback. Missing service/method is a
foreground prerequisite, not a guessed import, substitute service, or fake data.
Use supplied `data_coverage` or the plan's Information and interaction coverage to reconcile
every required fact, metric, filter and operation with actual interfaces. Do not drop missing
facts to make a screen compile or treat generation-pending business support as a mock.
Displaying public HTTPS image URLs through the installed image component is permitted by
[media sources](../../../shared/references/media-sources.md), not a connector-first violation.
Fetch records/URL fields through generated services; do not add an HTTP client to render imagery.

## Result and query boundaries

```tsx
const recordQuery = useQuery({
  queryKey: ['inspection', id],
  enabled: Boolean(id),
  queryFn: async () => {
    if (!id) throw new Error('Missing inspection ID');
    const result = await InspectionsService.get(id);
    if (!result.success) throw new Error(result.error?.message ?? 'Load failed');
    return result.data ?? null;
  },
});
```

Map errors to friendly domain copy in the screen, not `error.message`. Missing/invalid
ID, request failure, and successful “record no longer exists” are different states.
Use the shared `normalizeDataverseGuid` (see navigation reference) before this query.

Reuse the host's React Query provider and array keys: `['inspections', { filter }]`
and `['inspection', id]`. Mutations invalidate relevant list/detail keys. React Query
app focus and native route focus are not interchangeable: when the approved refresh
contract needs route-focus refresh beyond mutation invalidation, use
`useFocusEffect(useCallback(() => { void query.refetch(); }, [query.refetch]))`.
Do not add a parallel manual loader to a query-backed screen. Manual-loader fallback
uses `useFocusEffect`, not a mount-only `useEffect`; use existing shared list hooks.

## Shared queries and observer visibility

Queries with the same key share data and a query function, even when one observer is
disabled (for example a thumbnail row beside a full-size detail). Keep observer-local
visibility in `enabled`; never capture it in the shared `queryFn` access guard.
Authentication/record scope belongs in the query function and remains mandatory for
manual refetches. All observers use the same provider-derived access decision.

The following bounded helper only constructs options; callers supply the real generated
download callback and verified scope. It does not replace the host QueryClient:

```ts
// Shared image query example
import { normalizeDataverseGuid } from '@/utils';
import { readDataverseImage, type ImageDownloader } from '@/utils/dataverse-image';

export function imageQueryOptions<Column extends string>({
  recordId, column, scopeKey, imageVersion, canRead, download,
}: {
  recordId: string;
  column: Column;
  scopeKey: string;
  imageVersion: string;
  canRead: boolean;
  download: ImageDownloader<Column>;
}) {
  const id = normalizeDataverseGuid(recordId);
  return {
    queryKey: ['record-image', scopeKey, id, column, imageVersion, 'full'] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (!canRead || !scopeKey || !id) throw new Error('Image access is unavailable');
      if (signal.aborted) throw new Error('Image request cancelled');
      const bytes = await readDataverseImage(download, { id, column, resolution: 'full' });
      if (signal.aborted) throw new Error('Image request cancelled');
      return bytes;
    },
  };
}
```

Each consumer passes `{ ...options, enabled: canRead && isVisible }` to `useQuery`;
a thumbnail-only observer can stay disabled without poisoning a detail fetch. Put
every result-affecting input in the key (including resolution/version and the app's
account/environment scope), not visual state. Clear private query data on sign-out;
an opaque scope key is not authorization. A cancelled/late response must not restore
another record's image. Test two observers sharing a key, access denied, cancellation
and account/version changes. Never use a second cache or raw HTTP as the fix.

## Fields and cross-entity reads

- Use `select` for real columns, deterministic order for lists, generated model types
  for field names, and generated option constants for choice values.
- Display lookups via `lookupName(record, '<logicalLookupName>')`; select the exact
  `_<lookup>_value` property. Choices/statuses use `formattedValue` or generated option
  constants. Never invent `*idname`, `*statusname`, or inline annotation keys.
- Follow `related_entity_fields` recommendations: `formatted-lookup` uses annotations;
  `chained-fetch` performs one bounded related read in the load path, never inside
  `map`/`renderItem`; `external-projection-required` returns `BLOCKED` naming the field.
  See `shared/references/data-performance.md` → Cross-entity Reads only if needed.
- Generated services do not reliably support relationship traversal filters.
  Resolve the related table first, then filter the source using its exact read lookup
  GUID property. Use shared filter/escaping helpers for user-entered strings.
- A Profile bound to `systemuser` resolves token `oid` via
  `SystemusersService` / `azureactivedirectoryobjectid`, rejecting disabled, missing,
  or duplicate users. Inspect the profile model's exact systemuser lookup read key;
  never guess `_lookup_value` or fall back to email matching. Missing service/key blocks.
- Dataverse Image values selected with a record are thumbnails, not the retained full-size
  image. They can suit small rows/icons; do not stretch them into detail media. For larger
  surfaces inspect the generated `downloadImage(id, columnName, fullSize)` signature and
  request `fullSize: true` through that service when full-image storage is supported.
  See [image resolution](../../../shared/references/media-sources.md#dataverse-image-resolution).
  Never construct an authenticated URL or call raw HTTP to bypass the generated service.
- An approved URL/Text image field may hold a public HTTPS URL for direct image-component
  display with loading/error fallback. Dataverse Image/File columns hold bytes, never that URL.

Live `[]` is valid data, not a fixture trigger. Source mode must be explicit and
visible when showing fixtures. A failed request cannot become a successful empty state.
