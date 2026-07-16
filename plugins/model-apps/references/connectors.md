# Connector Bindings

Connector-backed GenPages bind to Dataverse `connectionreference` rows by logical
name. The `connectorLogicalName` string in TSX **MUST** equal a
`connectorBindings[].logicalName` value in the page `config.json`, and that
logical name must exist as a connection reference in the target environment.

> **Gated behind the `connectors` feature flag (default OFF).** This reference is
> only used when connector support is enabled — see the Feature Flags section in
> the plugin `AGENTS.md` and `feature-flags.json`. When OFF, pages are Dataverse /
> mock-data only and no connector code is emitted.

## Binding shape: `connectors.json` (array) vs page `config.json` (object)

The skill writes a **bare JSON array** of bindings to working-dir
`connectors.json`. `pac model genpage upload --connectors <connectors.json>` then
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

**page `config.json`** — what `pac` writes into the deployed page (the same array
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

## Runtime requirements

- Always cast `dataApi` to an optional connector-method shape.
- Always presence-check the method before calling it.
- Always wrap calls in `try`/`catch` and set a graceful empty/error state.
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
`## Connector Bindings` from `get-connector-schema --operation`.

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

```typescript
const connectorApi = dataApi as unknown as { queryConnectorTable?: (connectorLogicalName: string, dataset: string, table: string, options: Record<string, unknown>) => Promise<{ rows: Row[] }>; };
if (typeof connectorApi.queryConnectorTable !== 'function') { return; }
const result = await connectorApi.queryConnectorTable('new_uxtest_sharepoint', 'https://host.sharepoint.com/sites/x', '<list-guid>', { top: 50 });
```

Use this for connectors exposed as tables/lists. The `dataset` and `table`
arguments come from `## Connector Bindings` (`Dataset` and `Tables (GUIDs)`).

## Verified REST/action pattern

```typescript
const connectorApi = dataApi as unknown as { executeConnectorOperation?: (connectorLogicalName: string, operationName: string, parameters: Record<string, unknown>) => Promise<{ ok: boolean; body: unknown }>; };
if (typeof connectorApi.executeConnectorOperation !== 'function') { return; }
const response = await connectorApi.executeConnectorOperation('new_uxtest_msnweather', 'CurrentWeather', { Location: 'Seattle', units: 'C' });
```

Use this for REST-style connector operations. Check `response.ok` before reading
`response.body`, cast it to the response interface declared from the plan's
`Response` schema, and keep the call inside the same `try`/`catch` as state
updates.
