---
name: add-geolocation
description: Internal helper for one-shot coordinates or continuous/background GPS using release-matched geolocation controls; tracking adds durable storage and Dataverse sync.
user-invocable: false
disable-model-invocation: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

# Add Geolocation

Internal helper for `/add-native location` (one-shot), `/add-native geolocation`,
`/add-native location-tracking`, and `/add-native background-location` (tracking).
Preserve the requested mode; ask once if intent is unclear.

Read [release lifecycle](../../../shared/references/mobile-release-lifecycle.md)
and [native controls](../references/native-controls.md). Do not use
`GeolocationExtension`, HostingSDK, PCF, Launch URI, or Cordova bridge paths.
Do not substitute another library's `configureSync` / `HttpSyncContract` API.

## 1. Verify the app and resolved release

```bash
test -f app.config.js && test -f power.config.json && test -f package.json && test -d src
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root "<working_dir>"
```

Unknown/missing records block native mutation. Do not install packages, edit
native config, or run local native builds. Match the installed public README,
exports, and types to the resolved inventory before generating any wrapper.
Use `@microsoft/power-apps-native-controls/geolocation` only when that aggregate
is included in the verified release. Use the legacy
`@microsoft/power-apps-native-bglocation` import only when the matching leaf
is actually included. Pick one literal import at generation time, never both.

The public runtime exports are `BgLocationClient`, `geoService`, `AuthMethod`,
and `ConnectionType`. Controls 0.2.0 uses background-location 0.2.3; do not copy
APIs from a newer leaf. Package facts are not evidence of a released player/base.

## 2. One-shot location — no tracking setup

For a single coordinate read, write `src/native/location.ts`. This path needs
**no `app_id`, data source, target table, or `startTracking`**. Skip Steps 3–5.
Check the selected version's location permission requirements; native binary
inclusion, OS declarations, runtime grants, and use are distinct.

Conditional example for a resolved release that contains the aggregate:

```ts
import { Platform } from 'react-native';

export async function getCurrentLocation() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return { ok: false as const, reason: 'UNSUPPORTED_PLATFORM' as const };
  }

  try {
    const { BgLocationClient } =
      await import('@microsoft/power-apps-native-controls/geolocation');
    const value = await new BgLocationClient().getCurrentLocation();
    return { ok: true as const, value };
  } catch {
    return { ok: false as const, reason: 'LOCATION_FAILED' as const };
  }
}
```

Refine permission/error results only from the installed public contract. Do not
guess fields or classify errors by matching arbitrary native error text. Screens
show an appropriate denied/unsupported/failure state without exposing raw errors.
If the resolved release instead supports `expo-location`, use its installed
one-shot contract with the same platform and result guards, not tracking setup.

## 3. Continuous tracking — permissions and ownership first

For background-location **0.2.3**, `startTracking` uses background permissions
even with `trackInBackground: false`. Do not promise foreground-only tracking
permissions. Missing OS declarations require another verified base, not a
runtime fallback or per-customer wrapping option.

Tracking is shared. `stopTracking()` and `isTracking()` have no `app_id`
parameter. Before code generation, record a single app-level tracking owner,
explicit user start/stop actions, and how other screens observe status.
Do not start duplicate sessions, reconfigure an already owned session, or stop
tracking on an unrelated screen's unmount. A JS ownership flag does not prove
ownership of a native session surviving a JS restart; reconcile native status
through the installed API before starting/stopping.

Use MSAL only; do not expose OneAuth or an auth selector. Read the installed
`geoService(dataSource, app_id)` contract, `AuthMethod.MSAL`,
`ConnectionType.Dataverse`, permissions, and persistence behavior. The tracking
target must include `connectionUrl`, `trackInBackground`, and
`persistAcrossRestarts` as required by that version. Optional interval,
distance, and notification settings must come from its types, not guesses.

## 4. Verify the tracking Dataverse target

This check is **tracking-only**, never a prerequisite for a one-shot read.
Use the package's default entity set `msdyn_locationrecords` and default field
map. Do not invent a custom table, create the table, or route missing-table
provisioning through `/add-dataverse`.

```bash
ENV_JSON=$(node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$(node -e "console.log(require('./power.config.json').environmentId)")")
ENV_URL=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.environmentUrl || '')" "$ENV_JSON")
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "$ENV_URL" GET \
  "EntityDefinitions?\$filter=EntitySetName eq 'msdyn_locationrecords'&\$select=LogicalName,EntitySetName"
```

- One row: capture its logical name and check the mapped columns below.
- Empty `value: []`: `BLOCKED (target table missing)`. Ask for the supported
  geolocation table provisioning/setup mechanism, then re-run this workflow.
- Auth/environment failure: `UNVERIFIED (target table not checked)`. Stop.

```bash
node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "$ENV_URL" GET \
  "EntityDefinitions(LogicalName='<logicalName>')/Attributes?\$select=LogicalName,AttributeType"
```

Confirm the installed README's default `fieldMap` columns and their types:

```text
msdyn_locationrecordid, msdyn_appid, msdyn_latitude, msdyn_longitude,
msdyn_altitude, msdyn_accuracy, msdyn_heading, msdyn_speed, msdyn_timestamp
```

Missing active columns block tracking. Do not report the target as ready or
silently substitute another table.

## 5. Write the tracking wrapper from installed docs/types

Create or patch `src/native/geolocation.ts` only after the preceding gates pass.
Screens import the wrapper, not the control. Require a native platform guard
before lazy imports inside `try`/`catch`; return discriminated results and never
throw. Preserve native capture, durable pending storage, and native upload
without depending on JavaScript being alive. Do not replace native behavior
with JS timers, upload loops, or a made-up adapter contract.

Use only verified public methods from the installed version. Keep
`geoService(dataSource, app_id)` initialization and the shared tracking owner
together; do not synthesize `stopTracking(app_id)` or `isTracking(app_id)`.
Do not add data sources or tracking side effects to the one-shot wrapper.

## 6. Validate and summarize

```bash
npx --no-install tsc --noEmit
```

Report the mode, resolved release/package version, wrapper path, permission
requirements, ownership decision for tracking, and whether native device
validation was performed. Tracking additionally requires verified table and
columns. Type-check success alone never means native execution is validated.

Update `memory-bank.md` only with completed wrapper work and explicit remaining
limitations. On any failed prerequisite, report `BLOCKED` / `UNVERIFIED`, not
`READY`; do not claim packages, players, or bases are available without evidence.
