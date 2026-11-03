# Connector Bindings

Connector-backed GenPages bind to Dataverse `connectionreference` rows by logical
name. The `connectorLogicalName` string in TSX **MUST** equal a
`connectorBindings[].logicalName` value in the page `config.json`, and that
logical name must exist as a connection reference in the target environment.

> **No feature flag.** Connector authoring is always available. Pages emit connector code only when
> the plan carries actual connector bindings.

## Binding shape: `connectors.json` (array) vs page `config.json` (object)

The skill writes a **bare JSON array** of bindings to working-dir
`connectors.json`. `genpage-upload.js --connectors <connectors.json>` then
persists that array into the deployed page's `config.json` under a
`connectorBindings` property. The two files therefore have **different shapes** —
do not write the object wrapper to `connectors.json`.

**`connectors.json`** — what the skill writes (a JSON array; no wrapper object):

```json
[
  {
    "logicalName": "new_uxtest_sharepoint",
    "connectorId": "/providers/Microsoft.PowerApps/apis/shared_sharepointonline",
    "dataset": "https://host.sharepoint.com/sites/x",
    "tables": ["5709dd6f-c73e-4079-ad23-2334e45e0e13"],
    "tableDisplayNames": ["Pet"]
  },
  {
    "logicalName": "new_uxtest_msnweather",
    "connectorId": "/providers/Microsoft.PowerApps/apis/shared_msnweather",
    "dataset": "",
    "operations": ["CurrentWeather"]
  }
]
```

**page `config.json`** — what the upload writes into the deployed page (the same array
wrapped under `connectorBindings`; the skill never writes this file directly):

```json
{
  "connectorBindings": [ /* ...the identical array from connectors.json... */ ]
}
```

- `logicalName`: Dataverse connectionreference logical name; this is the TSX
  `connectorLogicalName` argument.
- `connectorId`: Power Platform API id, for example
  `/providers/Microsoft.PowerApps/apis/shared_sharepointonline`.
- `dataset`: for tabular connectors, the dataset key. SharePoint uses the site
  URL (for example `https://host.sharepoint.com/sites/x`).
- `tables`: tabular table identifiers. For SharePoint, use the list GUID, not
  the display name, so renames do not break the page.
- `tableDisplayNames`: user-facing names aligned by index with `tables`.
- `operations`: REST/action operation names for `executeConnectorOperation`.

## In an App Spec

An app a download reads is written with each page's `connectorBindings` in `pages[].connectorBindings`, and a
rebuild writes that list back onto the page (a spec that states none leaves the page's own). A spec states an
entry by the properties documented above — `logicalName`, `connectorId`, `dataset`, `tables`, `tableDisplayNames`,
`operations` — each with a value of a conservative shape known to be safe (an identifier, a GUID, a plain name or
label, an `http(s)` URL with no user-info, no query and no fragment, written in its canonical form), and by nothing else. A list in which any entry
holds anything else — a connection id, a credential, a property a binding holds beyond these — is left out of the
spec WHOLE, reported by its place and the vetted property (never a value or an unrecognized key), and stays on the
page, which a rebuild then leaves as it is (see `references/app-spec-schema.md` → `pages[]`). Never write a
credential or a connection id into `connectors.json`; a spec that states one is refused.
`/genpage` itself never reads or writes the spec. The spec carries the list and not what it names: the connection
reference — and the connection behind it — must already exist in the environment you rebuild into
(`create-connection-reference.js`, or a solution: `add-page-to-solution.js --connection-refs`, then
`solution-settings.js`). A rebuild reads the environment's references before it writes: one of that name for
**another connector** than the binding's `connectorId` stops it, before anything is written; one that is not there,
one that has no connection, and an operation in `operations` that a custom connector there does not define are
said by name; what the environment's answer did not prove (its row's connector or connection, or which custom
connector it is for) is said by name as not checked.

## Runtime requirements

- Always cast `dataApi` to an optional connector-method shape.
- Always presence-check the method before calling it.
- Always await calls in a `try` whose `catch` reports the failure through the page's
  `reportPageError` (rules.md → *Missing Error Handling*) into the panel's error state, rendered
  by `PageErrorBar` beside a graceful empty state. A failed operation response (`!response.ok`)
  is a failure too, though nothing was thrown: report it before reading `response.body`. Its
  envelope carries no message or code, so pass none — never invent an `error.code` — and the bar
  shows its fixed fallback copy.
- Classify the kind from the plan, never from the response: a `queryConnectorTable` read, or an
  operation the plan records as a read, is `'read'` and may offer a named manual retry; any other
  operation is `'write'`, with no retry.
- Never guess a logical name, dataset, table GUID, operation name, field name,
  parameter name, or response field name. Use the plan's `## Connector Bindings`
  values only.
- Keep non-connector pages unchanged; only emit connector code when the plan has
  connector bindings.

## Field schema

`config.json.connectorBindings` stores where to fetch connector data, not the
table's column list. Connector rows are dynamically typed and passed through by
the runtime; there is no connector equivalent of Dataverse `RuntimeTypes.ts`.
Therefore the page-builder must declare the connector row interface inline from
the plan's discovered `Fields` list.

Rules:
- Build row interfaces only from `## Connector Bindings` → `Fields`.
- Mark every connector field optional with `?`; connector APIs can omit values
  row-by-row.
- Use the discovered field spelling exactly. Do not camel-case, singularize, or
  infer alternate display names.
- Use `unknown` for any field whose shape was not discovered with confidence.
- SharePoint choice columns come back as objects with a `Value` property.
- For SharePoint, record only maker/user-meaningful columns by default. Keep
  fields such as `Title`, `PetName`, `OwnerName`, `PetType`, `Created`, and
  `Modified`; drop system/synthetic fields unless the maker explicitly needs
  them: `{...}`-wrapped names (`{Identifier}`, `{IsFolder}`, `{Thumbnail}`),
  `ComplianceAssetId`, `OData__*`, and `*#Id` / `*#Claims` variants.
- SharePoint `type:"object"` choice columns should be represented as
  `{ Value?: string }`.

Example discovered SharePoint fields:

```typescript
type PetRow = { ID?: number; PetName?: string; OwnerName?: string; PetType?: { Value?: string }; Created?: string };
```

`Created` is represented as a string because connector date/time values arrive
serialized; parse/format it at the display boundary only when needed.

## Operation schema

REST/action connectors do not use `dataset`/`table`. The planner records the
selected operation, discovered `Parameters`, and discovered `Response` shape in
`## Connector Bindings` from `connector.js schema --operation`.

Rules:
- Build request parameter objects only from discovered `Parameters` plus the
  maker's provided values. Never invent parameter names.
- Declare the response interface from the discovered `Response` schema. Mark
  every field optional because connector responses are dynamic.
- If a response field shape is unclear, use `unknown`; if a nested object is
  discovered, model only the discovered nested properties.
- Check `response.ok` before casting/reading `response.body`.

Example:

```typescript
type WeatherResponse = { temperature?: number; conditions?: string; humidity?: number };
const parameters: { Location: string; units?: string } = { Location: 'Seattle', units: 'C' };
```

## Verified tabular pattern

A complete `PageBody` for a list read on mount, built on the page error block of rules.md. A
connector read is a real host read, so it uses the in-flight de-dupe and cache of
`references/data-caching.md` (Pattern 1), with keys unique to the page and the connector query:

```typescript
type DocumentRow = { ID?: number; Title?: string; Modified?: string };
type ConnectorTableApi = {
  queryConnectorTable?: (connectorLogicalName: string, dataset: string, table: string, options: Record<string, unknown>) => Promise<{ rows: DocumentRow[] }>;
};

const winAny = window as any;
const CACHE_KEY = '__ppTeamDocuments_documentsCache';
const INFLIGHT_KEY = '__ppTeamDocuments_documentsInflight';

function PageBody(props: GeneratedComponentProps) {
  const { dataApi, pageInput } = props;
  void pageInput;
  const connectorApi = dataApi as unknown as ConnectorTableApi;
  const dataReady = !!dataApi;
  const [reloadKey, setReloadKey] = React.useState(0);
  const [{ documents, loading, error }, setData] = React.useState<{ documents: DocumentRow[]; loading: boolean; error: PageErrorView | null }>(() => {
    const cached = winAny[CACHE_KEY] as DocumentRow[] | undefined;
    return { documents: cached ?? [], loading: cached === undefined, error: null };
  });

  function retryLoad() {
    delete winAny[CACHE_KEY];
    delete winAny[INFLIGHT_KEY];
    setReloadKey((key) => key + 1);
  }

  React.useEffect(() => {
    if (!dataReady) return;
    // An older runtime without the method has no connector data to show: an empty list, not a failure.
    if (typeof connectorApi.queryConnectorTable !== 'function') { setData({ documents: [], loading: false, error: null }); return; }
    const cached = winAny[CACHE_KEY] as DocumentRow[] | undefined;
    if (cached !== undefined) {
      if (documents !== cached) setData({ documents: cached, loading: false, error: null });
      return;
    }
    let cancelled = false;
    let inflight = winAny[INFLIGHT_KEY] as Promise<DocumentRow[]> | undefined;
    if (!inflight) {
      inflight = connectorApi
        .queryConnectorTable('new_uxtest_sharepoint', 'https://contoso.sharepoint.com/sites/docs', '<list-guid>', { top: 50 })
        .then((result) => {
          winAny[CACHE_KEY] = result.rows;
          return result.rows;
        })
        .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
      winAny[INFLIGHT_KEY] = inflight;
    }
    inflight
      .then((rows) => { if (!cancelled) setData({ documents: rows, loading: false, error: null }); })
      .catch((failure) => { if (!cancelled) setData({ documents: [], loading: false, error: reportPageError(PAGE_NAME, 'loadDocuments', undefined, failure, 'read', retryLoad) }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataReady, reloadKey]);

  return (
    <div>
      <PageErrorBar error={error} />
      {loading ? <Spinner label="Loading documents" /> : documents.map((row) => <Text key={String(row.ID)}>{row.Title}</Text>)}
    </div>
  );
}
```

Use this for connectors exposed as tables/lists. The `dataset` and `table`
arguments come from `## Connector Bindings` (`Dataset` and `Tables (GUIDs)`).

## Verified REST/action pattern

A complete `PageBody` for an operation the user starts. `CurrentWeather` only reads, so its
failure is a `'read'` with a named retry; an operation the plan does not record as a read is a
`'write'` with no retry.

```typescript
type WeatherResponse = { temperature?: number; conditions?: string; humidity?: number };
type ConnectorOperationApi = {
  executeConnectorOperation?: (connectorLogicalName: string, operationName: string, parameters: Record<string, unknown>) => Promise<{ ok: boolean; body: unknown }>;
};

function PageBody(props: GeneratedComponentProps) {
  const { dataApi, pageInput } = props;
  void pageInput;
  const connectorApi = dataApi as unknown as ConnectorOperationApi;
  const [weather, setWeather] = React.useState<{ weather: WeatherResponse | null; error: PageErrorView | null }>({ weather: null, error: null });

  function retryWeather() {
    void loadWeather();
  }

  async function loadWeather() {
    if (typeof connectorApi.executeConnectorOperation !== 'function') return;
    try {
      const response = await connectorApi.executeConnectorOperation('new_uxtest_msnweather', 'CurrentWeather', { Location: 'Seattle', units: 'C' });
      if (!response.ok) { setWeather({ weather: null, error: reportPageError(PAGE_NAME, 'loadWeather', undefined, undefined, 'read', retryWeather) }); return; }
      setWeather({ weather: response.body as WeatherResponse, error: null });
    } catch (error) {
      setWeather({ weather: null, error: reportPageError(PAGE_NAME, 'loadWeather', undefined, error, 'read', retryWeather) });
    }
  }

  return (
    <div>
      <PageErrorBar error={weather.error} />
      <Button onClick={() => void loadWeather()}>Show the weather</Button>
      {weather.weather?.conditions && <Text>{weather.weather.conditions}</Text>}
    </div>
  );
}
```

Use this for REST-style connector operations. Check `response.ok` before reading
`response.body`, cast it to the response interface declared from the plan's
`Response` schema, and keep the call inside the same `try`/`catch` as state
updates.
