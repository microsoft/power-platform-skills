# GenPage Edit Plan — Seattle Weather

## Page Under Edit

- App: Operations Hub (`aa112233-1122-1122-1122-aabbccdd1234`)
- Page: Seattle Weather (`bb223344-2233-2233-2233-bbccddee2345`)
- Downloaded to: `seattle-weather-edit/bb223344-2233-2233-2233-bbccddee2345/`
- Current data mode: mock (no `dataSources` in `config.json`, no `connectorBindings`)

## User Requirements (delta)

Pull the current conditions from the real MSN Weather connector instead of the
hard-coded numbers. Leave the five-day forecast alone.

## Connector Changes

Action: **add** a connector binding. The page currently has none.

| Logical Name | Connector | Dataset | Operations |
|---|---|---|---|
| `new_uxtest_msnweather` | `/providers/Microsoft.PowerApps/apis/shared_msnweather` | (none — REST connector) | `CurrentWeather` |

MSN Weather is a REST/action connector, so the page calls
`executeConnectorOperation('new_uxtest_msnweather', 'CurrentWeather', { … })` —
the REST pattern in `references/connectors.md`, not `queryConnectorTable`.

## Changes

1. Bind the **current conditions** card to the connector operation, with the
   existing hard-coded values kept as the fallback shown before the call resolves
   and whenever it is unavailable or fails.
2. Add a `Live` / `Sample` badge so the user can tell which they are looking at.
3. Surface a warning `MessageBar` when the connector call fails.

## Preservation Constraints

- The **five-day forecast strip keeps its inline sample data**. The `CurrentWeather`
  operation returns current conditions only, so replacing the forecast with connector
  data is not possible — dropping it would silently remove a feature the maker did
  not ask to lose.
- The page title, layout, Fluent tokens and the existing icon set are unchanged.
- `export default GeneratedComponent` and the `props.dataApi` / `props.pageInput`
  signature are unchanged.

## Deployment

- Upload with `--page-id bb223344-2233-2233-2233-bbccddee2345` and
  `--connectors seattle-weather-edit/connectors.json`.
- **No** `--add-to-sitemap` — the page is already in the sitemap.
- `--prompt` carries only this edit's delta, not the original page description.
