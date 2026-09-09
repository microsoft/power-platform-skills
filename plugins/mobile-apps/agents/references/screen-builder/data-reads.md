# Data reads — load only for a data-backed screen

Generated `@/generated/services/<Name>Service` is the data layer. Never call raw HTTP,
Graph, `fetch`, or axios. Use the supplied signatures/Generated Services snapshot;
inspect only needed methods and model declarations. If the snapshot is absent,
glob generated services as an older-plan fallback. Missing service/method is a
foreground prerequisite, not a guessed import, substitute service, or fake data.

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
- Dataverse Image display selects the real image/base64 column and builds a data URI
  when present; no guessed URL or display shadow properties.

Live `[]` is valid data, not a fixture trigger. Source mode must be explicit and
visible when showing fixtures. A failed request cannot become a successful empty state.
