# Generated Screen Code Idioms

Read this with one compiled screen build-pack entry. Validators reject the
mechanical violations; this file covers the small amount of implementation
context that static checks cannot fully infer.

## Generated services

Generated Power Apps services are the only data layer. Never call Dataverse,
Graph, or connector endpoints with `fetch`/`axios`.

Every generated operation returns a non-throwing result shape:

```ts
const result = await ItemsService.get(id);
if (!result.success) {
  console.error('[Items] get failed', result.error);
  throw new Error("Couldn't load this item.");
}
const item = result.data;
```

Check `success` after `get`, `getAll`, `create`, `update`, `delete`, upload, and
download operations. A `try/catch` alone is insufficient. User-facing copy is
friendly; raw details go only to development logs.
Do not return a raw generated-service result from React Query's `queryFn`;
unwrap it after the success check so consumers receive the record/list and
failures enter React Query's error state.

`create()` success may contain sparse data. When the next operation needs the
new ID, generate it before the create:

```ts
const id = newId();
const result = await ItemsService.create({ cr_itemid: id, ...payload });
if (!result.success) throw new Error("Couldn't create this item.");
router.push(`/(app)/items/${id}`);
```

Normal saves return with `router.back()`. Pre-generated IDs are for immediate
follow-up navigation, lookup binding, child creation, or file upload—not for
sample data or arbitrary meaningful IDs.

## Dataverse values and payloads

- Lookup labels: `lookupName(record, '<lookupLogicalName>')`; select the real
  `_<lookup>_value` field.
- Choice/status/date/money labels:
  `formattedValue(record, '<columnLogicalName>')`, then a generated option
  constant fallback when appropriate.
- Never select guessed `*idname`, `*statusname`, `*owneridname`, or other
  virtual shadow columns.
- Lookup writes use the exact navigation property and suffix:
  `'<navigationProperty>@odata.bind': '/<entitySet>(<guid>)'`.
- Do not include server-owned fields in create/update payloads. Keep any
  unavoidable generated-type cast inside one narrow write helper.
- Serialize Dataverse dates with `toISOString()`.

## Route and action intent

Use the Navigation Contracts row verbatim.

- Create-or-edit query mode is `?editId=<guid>`.
- Primary path identity is `[id]`; nested entities use `[<entity>Id]`.
- Singleton destinations use `router.navigate`.
- Entity drill-down uses `router.push`.
- Auth/guard redirects use `router.replace`.
- Normal successful form save uses `router.back`.

Dynamic route values are untrusted and may be arrays:

```ts
const params = useLocalSearchParams<{ id?: string | string[] }>();
const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
const id = normalizeDataverseGuid(rawId);
if (!id) return <ErrorState message="This link is invalid." onRetry={router.back} />;
```

Normalize before any Dataverse record operation. Do not use an inline RFC UUID
regex; valid Dataverse sequential GUIDs do not guarantee RFC version bits.

Navigation and submit actions are duplicate-tap safe. Set the lock before the
operation, disable the visible action, swap its label to a busy state, and
release the lock after failure or transition completion. An enabled button
must never silently `return` because required state is missing; disable it and
show the reason.

## Forms and progress

- Preserve entered values after validation, failed save, and refetch.
- Short dirty forms confirm cancel/back.
- Long or multi-step forms persist a local draft and offer resume/discard.
- iOS forms use `KeyboardAvoidingView`.
- Choice controls use generated constants. If a constant is genuinely absent,
  keep the raw value field with a visible `TODO(choice-missing)` rather than
  inventing values.

## Lists

- Bounded small lists may use `useListData` and client `useSearchFilter`.
- Cursor specs use `useCursorListData`/`useInfiniteQuery`, `maxPageSize`,
  `skipToken`, server filter, deterministic `orderBy` including a unique key,
  `select`, and `FlatList.onEndReached`.
- `ListEmptyComponent` stays inside `FlatList` so pull-to-refresh works when
  empty.
- `keyExtractor` uses a stable record ID, never the index.
- Loading skeletons preserve the populated layout's outer geometry.

## Mobile interaction

- One touch owner per row/card. If a child needs its own action, split the
  controls into siblings; decorative overlays use `pointerEvents="none"`.
- Primary actions stay bottom-reachable. Bottom UI clears both the tab bar and
  safe-area inset.
- Tamagui controls use ARIA props. Raw React Native controls use native
  accessibility props. Icon-only controls have a label and at least a 44pt
  effective target.
- Never disable font scaling for readable text.
- Use only tokens present in `tamagui.config.ts`; no raw hex in screens.
- Tamagui Button label color belongs on `Button.Text` or a shared button
  component, not an unverified semantic theme name.

## Native capabilities

Only use capabilities present in the approved plan and template allowlist.
Permissions have explicit denied/error states.

A screen may mount `BarcodeScannerView` only when its own per-screen spec
declares `Scanner surface: dedicated-full-screen` and the approved operational
pattern is `scan-geofence-gate`. Home may launch that route but never mount the
live viewfinder. Never import or render raw `CameraView` in a screen.

Scanner mutations use an in-flight ref lock, paused state, and a focus reset.
Manual entry flows through the same guarded mutation. Evidence capture includes
a visible `Take picture` action; gallery/file selection may be secondary.

## Validation

Before `DONE`, run the explicit mobile validator for the assigned file:

```bash
node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" \
  --project-root "<working_dir>" --file "<target_file>"
```

The orchestrator owns TypeScript, route-contract, wave, and cross-screen
validation. A builder does not run the app or edit shared/layout files.
