# Preview data layer

`/create-mobile-app` shows the user a running app before any Dataverse table, connector, or native wrapper exists.
Screens are built against the **data layer** in `src/hooks/data/` and run on **sample data** in a web preview.
Once the data model, connectors, and device capabilities are applied, only the data layer is rewired.
Screen files stay untouched when the data becomes real.

This reference is the single source of truth for the data layer.
The orchestrator, `screen-planner`, `screen-builder`, `data-model-architect`, and `/edit-app` point here.

## The boundary

Screens and shared components import data and device behaviour from `@/hooks/data` only.
The data layer is the one place that imports generated services (`@/generated/...`), native wrappers (`@/native/...`), and fixtures.
[`scripts/check-data-layer.js`](../../scripts/check-data-layer.js) enforces this and reports what is still on sample data:

```bash
node "${PLUGIN_ROOT}/scripts/check-data-layer.js" --project-root '<working_dir>'                  # preview: boundary only
node "${PLUGIN_ROOT}/scripts/check-data-layer.js" --project-root '<working_dir>' --require-wired  # after wiring
```

An app created before the data layer existed has no `src/hooks/data/`.
The checker reports `status: absent` and its screens keep importing generated services directly; keep that shape when editing such an app.

There is no `@/data` path alias.
The host TypeScript config owns the alias map, and a local `paths` entry would replace it rather than extend it, so the layer lives under the existing `@/hooks` alias.

## Layout

| File | Owner | Contents |
|---|---|---|
| `src/hooks/data/core.ts` | Template preparation (shared sample) | `EntitySource`, `createMockSource`, `useSourceQuery`, `useSourceMutation`, `unwrapResult`, `DeviceResult`, `MutationResult`, `daysFromToday`. Never edited per app. |
| `src/hooks/data/<entity>.ts` | Orchestrator | One module per Data Contract entity: domain type, draft type, the source, and the entity's hooks. |
| `src/hooks/data/device.ts` | Orchestrator | One function per Data Contract device action. Only when the contract lists device actions. |
| `src/hooks/data/fixtures/<entity>.ts` | Orchestrator | Sample records. Deleted once nothing imports them. |
| `src/hooks/data/index.ts` | Orchestrator | Barrel: `export *` from every entity module and `device.ts`, plus `export type { DeviceResult, MutationResult } from './core'`. |

## Data Contract

`screen-planner` writes `### Data Contract` into `## Screens` during the graph phase, and the user approves it with the screen graph.
It describes data in the app's own words: camelCase fields, plain types, and the operations screens need.
It names no table, column, publisher prefix, connector, or service; the data model gate maps it to those later.

```markdown
### Data Contract

#### Inspection
- **Purpose:** One scheduled safety inspection at a site.
- **Fields:** `title: string` · `status: 'scheduled' | 'inProgress' | 'complete'` · `scheduledFor: date` · `site: Site` · `siteName: string (from Site)` · `notes?: text` · `photo?: image`
- **Operations:** list (cursor; search: title, siteName; order: scheduledFor asc) · get · create · update
- **Queries:** `stats(today)` → `{ open: number; overdue: number }` (Home)
- **Sample records:** 24

#### Device actions
- `capturePhoto()` → `{ uri: string }` - Inspection detail "Take picture"; capability: camera
```

Field types are `string`, `text`, `number`, `integer`, `decimal`, `currency`, `boolean`, `date`, `datetime`, `email`, `phone`, `url`, `image`, `file`, a quoted literal union for a fixed choice, or another entity's name for a reference.
`?` marks an optional field, and `(from <Entity>)` marks a read-only display value derived from a reference.
Every entity has an implicit `id: string`.
Operations are `list` (with `cursor` or `bounded`, search fields, and default order), `get`, `create`, `update`, and `remove`; list only what some screen uses.
**Queries** are named reads beyond those operations, such as dashboard counts, with the screen that uses them.
Each device action names its result shape, the screen and control that trigger it, and the native capability it will need.

## Entity module

Every entity module has the same four parts, in this order.
This is the complete pattern for a cursor list, a record read, a dashboard query, and mutations:

```ts
import { useCursorListData } from '@/hooks';
import { createMockSource, useSourceMutation, useSourceQuery, type EntitySource } from './core';
import { inspectionFixtures } from './fixtures/inspections';
import { siteFixtures } from './fixtures/sites';

// 1. Domain types - the Data Contract fields, verbatim. Dates are ISO strings; image/file are URIs.
export type InspectionStatus = 'scheduled' | 'inProgress' | 'complete';
export interface Inspection {
  id: string;
  title: string;
  status: InspectionStatus;
  scheduledFor: string;
  siteId: string;
  siteName: string;
  notes?: string;
  photoUri?: string;
}
export type InspectionDraft = Omit<Inspection, 'id' | 'siteName'>;
export interface InspectionStats { open: number; overdue: number }

// 2. Source type - exactly the contract's operations, plus its named queries.
interface InspectionSource
  extends EntitySource<Inspection, InspectionDraft, 'list' | 'get' | 'create' | 'update'> {
  stats(today: string): Promise<InspectionStats>;
}

// 3. The source, between markers. Only this block changes at wiring time.
// DATA SOURCE START - preview
const sample = createMockSource<Inspection, InspectionDraft>(inspectionFixtures, {
  searchFields: ['title', 'siteName'],
  sort: (a, b) => a.scheduledFor.localeCompare(b.scheduledFor),
  fromDraft: (draft, id) => ({
    ...draft,
    id,
    siteName: siteFixtures.find((site) => site.id === draft.siteId)?.name ?? '',
  }),
});
const inspectionSource: InspectionSource = {
  list: sample.list,
  get: sample.get,
  create: sample.create,
  update: sample.update,
  async stats(today) {
    const { items } = await sample.list({ pageSize: 1000, search: '' });
    const open = items.filter((item) => item.status !== 'complete');
    return { open: open.length, overdue: open.filter((item) => item.scheduledFor < today).length };
  },
};
// DATA SOURCE END

// 4. Hooks - the only exports screens call. Their names and return shapes never change.
const KEY = ['inspections'] as const;

export function useInspectionList() {
  return useCursorListData<Inspection>({
    queryKey: KEY,
    fetchPage: ({ pageSize, search, skipToken }) => inspectionSource.list({ pageSize, search, skipToken }),
  });
}

export function useInspection(id: string | undefined) {
  const query = useSourceQuery([...KEY, 'item', id], () => inspectionSource.get(id ?? ''), { enabled: Boolean(id) });
  return { ...query, item: query.data ?? null };
}

export function useInspectionStats(today: string) {
  return useSourceQuery([...KEY, 'stats', today], () => inspectionSource.stats(today));
}

export function useInspectionMutations() {
  const { saving, run } = useSourceMutation(KEY);
  return {
    saving,
    create: (draft: InspectionDraft) => run(() => inspectionSource.create(draft)),
    update: (id: string, patch: Partial<InspectionDraft>) => run(() => inspectionSource.update(id, patch)),
  };
}
```

Hook names follow the contract: `use<Entity>List` (wrapping `useCursorListData` for `cursor` lists or `useListData` for `bounded` ones), `use<Entity>(id)`, `use<Entity><Query>`, and `use<Entity>Mutations`.
Every mutation returns a `MutationResult`, so a screen branches on `result.ok` and renders `result.message` inline.
Mutations invalidate the entity's query key, so a list the user returns to already shows the new record.
A reference field is stored as `<name>Id` beside its `(from <Entity>)` display value, as `siteId` and `siteName` are above.

## Device actions

`device.ts` holds one exported function per contract device action, each between markers:

```ts
import { previewDeviceResult, type DeviceResult } from './core';

export interface CapturedPhoto { uri: string }

// An inline image keeps the preview offline and lets the capture flow run end to end. It is a
// PNG, not an SVG: React Native's Image cannot draw SVG on a device, and react-native-web
// re-encodes any `data:image/svg+xml;utf8,` URI, so an already-encoded SVG never loads on web.
const SAMPLE_PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAIAAAAy3EnLAAAAFElEQVR42mO4cP0eSYhhVMPQ1AAA3VmTMIic8vEAAAAASUVORK5CYII=';

// DEVICE ACTION START - preview capturePhoto
export function capturePhoto(): Promise<DeviceResult<CapturedPhoto>> {
  return previewDeviceResult({ uri: SAMPLE_PHOTO });
}
// DEVICE ACTION END
```

Preview implementations return a representative success, so the user can walk the whole flow in the browser: a placeholder image, a fixed coordinate, a sample barcode value.
They never touch a device API.

A capability that renders its own view (today only the barcode scanner, `src/native/barcodeScanner.tsx`) is a component, not a function.
In the preview the screen shows a clearly labelled placeholder with a **Use sample code** button that calls a `scanBarcode()` device action.
At wiring time that one screen is rebuilt to embed the real `src/native/barcodeScanner.tsx` view; it is the only native import a screen may make, and `check-data-layer.js` allows exactly that module.

## Sample data

Fixtures read like the real app: domain-specific names, plausible values, and every status and edge the screens style (an overdue item, an empty optional field, a long title).
Use `daysFromToday(n)` from `core.ts` for dates, so "upcoming" and "overdue" stay true whenever the preview runs.
Match the contract's **Sample records** count, defaulting to 12 for cursor lists and 6 for bounded ones; enough to scroll and paginate, few enough to read.
Reference fields point at ids that exist in the referenced entity's fixtures.

## Wiring

Wiring replaces each `preview` block once its real source exists.
Its inputs are the approved data model mapping (`## Data Model` → `### Data Contract Mapping`), the generated models and services, the approved connectors, and the `src/native/` wrappers.

For each entity module:

1. Replace the `DATA SOURCE START - preview` block with an adapter that implements the same `InspectionSource` type, and change the marker to the real binding: `dataverse <table logical name>`, `connector <connector API name>`, or `local` for data that intentionally stays on the device.
2. Map records both ways in the adapter (`toInspection(record)`, `toRecord(draft)`), using exactly the column, choice, and lookup names from the mapping and the generated model.
3. Call `unwrapResult(result)` on every service result, so a failed call throws and the screen's existing error UI shows it.
4. Implement named queries with server-side support where it exists, such as `count: true` for dashboard totals, rather than counting a capped page.
5. Remove the fixture import, and delete fixture files nothing imports.

```ts
// DATA SOURCE START - dataverse cr123_inspection
function toInspection(record: Cr123_inspections): Inspection {
  return {
    id: record.cr123_inspectionid,
    title: record.cr123_name ?? '',
    status: STATUS_BY_VALUE[record.cr123_status ?? VALUE_BY_STATUS.scheduled] ?? 'scheduled',
    scheduledFor: (record.cr123_scheduledfor ?? '').slice(0, 10),
    siteId: record._cr123_siteid_value ?? '',
    siteName: record['_cr123_siteid_value@OData.Community.Display.V1.FormattedValue'] ?? '',
    notes: record.cr123_notes ?? undefined,
  };
}

const inspectionSource: InspectionSource = {
  async list({ pageSize, search, skipToken }) {
    const result = await Cr123_inspectionsService.getAll({
      maxPageSize: pageSize,
      select: SELECT,
      orderBy: ['cr123_scheduledfor asc', 'cr123_inspectionid asc'],
      ...(search ? { filter: containsFilter('cr123_name', search) } : {}),
      ...(skipToken ? { skipToken } : {}),
    });
    return { items: unwrapResult(result).map(toInspection), nextSkipToken: result.skipToken };
  },
  // get, create, update, stats ...
};
// DATA SOURCE END
```

Domain types, hook names, and hook return shapes stay exactly as they were; that is what keeps every screen compiling unchanged.
When the real source genuinely needs a different shape, change the type and fix each failing screen, and record why in `memory-bank.md`.

Device actions are wired the same way: the block calls the `src/native/` wrapper, maps its result to the action's `DeviceResult`, and the marker becomes `native <capability> <action name>`.
A device action whose capability was declined at the architecture gate is removed together with the control that triggers it; that is a screen change, so it goes through `screen-builder`.

An entity or action whose source was deferred keeps its `preview` block.
It is reported in the run summary and `memory-bank.md` as still on sample data, by name, so the user never mistakes it for real data.

Wiring is complete when `npx --no-install tsc --noEmit` is clean and `check-data-layer.js --require-wired` exits `0`, or reports only the entities the user explicitly deferred.
