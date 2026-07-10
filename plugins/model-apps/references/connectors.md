# Connector Bindings

Connector-backed GenPages bind to Dataverse `connectionreference` rows by logical
name. The `connectorLogicalName` string in TSX **MUST** equal a
`connectorBindings[].logicalName` value in the page `config.json`, and that
logical name must exist as a connection reference in the target environment.

## `config.json` binding shape

The skill writes this array to working-dir `connectors.json`; `pac model genpage
upload --connectors` persists it into the page `config.json`.

```json
{
  "connectorBindings": [
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
- Never guess a logical name, dataset, table GUID, or operation name. Use the
  plan's `## Connector Bindings` values only.
- Keep non-connector pages unchanged; only emit connector code when the plan has
  connector bindings.

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
`response.body`, and keep the call inside the same `try`/`catch` as state updates.
