---
name: add-geolocation
description: Internal implementation skill invoked by /add-native for native background GPS tracking with durable storage and Dataverse sync using @microsoft/power-apps-native-bglocation.
user-invocable: false
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion
model: sonnet
---

**Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../../shared/shared-instructions.md)** - read first.

# Add Geolocation

Internal helper for `/add-native geolocation`, `/add-native location-tracking`, `/add-native background-location`, `/add-native gps-tracking`, and `/add-native @microsoft/power-apps-native-bglocation`.

Use this only for continuous/background GPS tracking with native durable storage and inline Dataverse upload. For a single foreground coordinate read, use `/add-native location` (`expo-location`) instead.

Hard rules:
- Auth is MSAL-only. Do not expose OneAuth or an auth selector.
- Use `geoService(dataSource, app_id)` and `BgLocationClient`.
- Do not use `GeolocationExtension`, HostingSDK, PCF, Launch URI, or CordovaV2 bridge paths.
- Do not install packages or edit native config.
- The control is not usable until its Dataverse target table and mapped columns are verified.

## 1. Verify app and package

```bash
test -f app.config.js && test -f power.config.json && test -f package.json && test -d src
node -e "const p=require('./package.json'); const m='@microsoft/power-apps-native-bglocation'; if (!p.dependencies?.[m]) { console.error('MISSING: ' + m); process.exit(1); } console.log('OK: geolocation package present');"
```

If either check fails, stop. The template/app must already ship the native package.

## 2. Verify the Dataverse target table first

This control uses the package default Dataverse entity set:

```text
msdyn_locationrecords
```

Do not ask the user for a table name and do not invent a custom table. `msdyn_locationrecords` must already exist before the control can be used.

```bash
ENV_JSON=$(node "${CLAUDE_SKILL_DIR}/../../../scripts/resolve-environment.js" "$(node -e "console.log(require('./power.config.json').environmentId)")")
ENV_URL=$(node -e "const j=JSON.parse(process.argv[1]); process.stdout.write(j.environmentUrl || '')" "$ENV_JSON")

TABLE="msdyn_locationrecords"
node "${CLAUDE_SKILL_DIR}/../../../scripts/dataverse-request.js" "$ENV_URL" GET \
  "EntityDefinitions?\$filter=EntitySetName eq '$TABLE'&\$select=LogicalName,EntitySetName"
```

Required result:
- One row returned: capture `LogicalName` and verify columns.
- Empty `value: []`: stop. Mark `BLOCKED (target table missing)`. Do not create the table, do not route to `/add-dataverse`, and do not report the control as usable. Tell the user to run the geolocation-control table provisioning/setup mechanism, then re-run `/add-native geolocation`.
- Auth/environment error: stop. Mark `UNVERIFIED (target table not checked)`. Do not report the control as usable.

When the table exists, verify every mapped column exists:

```bash
node "${CLAUDE_SKILL_DIR}/../../../scripts/dataverse-request.js" "$ENV_URL" GET \
  "EntityDefinitions(LogicalName='<logicalName>')/Attributes?\$select=LogicalName,AttributeType"
```

Required default `fieldMap` columns from the package README:

```text
msdyn_locationrecordid, msdyn_appid, msdyn_latitude, msdyn_longitude,
msdyn_altitude, msdyn_accuracy, msdyn_heading, msdyn_speed, msdyn_timestamp
```

If any active `fieldMap` column is missing, stop. Mark `BLOCKED (target columns missing)` and tell the user to fix the control table through the geolocation-control table provisioning/setup mechanism.

## 3. Write `src/native/geolocation.ts`

Create or patch `src/native/geolocation.ts` so screens import this wrapper, not the package directly.

The target config must require the README's two tracking flags:
- `trackInBackground: boolean`
- `persistAcrossRestarts: boolean`

```ts
// src/native/geolocation.ts
import {
  geoService,
  BgLocationClient,
  AuthMethod,
  ConnectionType,
} from '@microsoft/power-apps-native-bglocation';
import type {
  DataverseDataSource,
  LocationData,
  PermissionStatus,
} from '@microsoft/power-apps-native-bglocation';

export type { LocationData, PermissionStatus } from '@microsoft/power-apps-native-bglocation';

export type GeoTrackingTarget = Omit<DataverseDataSource, 'authMethod' | 'connectionType'>;

export type GeoResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: 'NATIVE_MODULE_MISSING' | 'PERMISSION_DENIED' | 'TRACKING_FAILED';
      message?: string;
    };

let activeClient: BgLocationClient | null = null;

function client(): BgLocationClient {
  return activeClient ?? new BgLocationClient();
}

function dataSource(target: GeoTrackingTarget): DataverseDataSource {
  return {
    ...target,
    authMethod: AuthMethod.MSAL,
    connectionType: ConnectionType.Dataverse,
  };
}

function fail(error: unknown): Extract<GeoResult<never>, { ok: false }> {
  const message = error instanceof Error ? error.message : String(error);
  if (/native|module|not.*link|undefined is not an object|null is not an object/i.test(message)) {
    return { ok: false, reason: 'NATIVE_MODULE_MISSING', message };
  }
  if (/permission|denied|authoriz|not granted/i.test(message)) {
    return { ok: false, reason: 'PERMISSION_DENIED', message };
  }
  return { ok: false, reason: 'TRACKING_FAILED', message };
}

export async function startTracking(
  app_id: string,
  target: GeoTrackingTarget,
): Promise<GeoResult<void>> {
  try {
    activeClient = geoService(dataSource(target), app_id);
    await activeClient.startTracking();
    return { ok: true, value: undefined };
  } catch (error) {
    activeClient = null;
    return fail(error);
  }
}

export async function stopTracking(): Promise<GeoResult<void>> {
  try {
    await client().stopTracking();
    activeClient = null;
    return { ok: true, value: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function isTracking(): Promise<GeoResult<boolean>> {
  try {
    return { ok: true, value: await client().isTracking() };
  } catch (error) {
    return fail(error);
  }
}

export async function getPermissionStatus(): Promise<GeoResult<PermissionStatus>> {
  try {
    return { ok: true, value: await client().getPermissionStatus() };
  } catch (error) {
    return fail(error);
  }
}

export async function getCurrentLocation(): Promise<GeoResult<LocationData>> {
  try {
    return { ok: true, value: await client().getCurrentLocation() };
  } catch (error) {
    return fail(error);
  }
}
```

## 4. Usage shape

Screens must pass `connectionUrl`, `trackInBackground`, and `persistAcrossRestarts`. Do not pass `tableName` or `fieldMap`; the control uses the default `msdyn_locationrecords` table and default `msdyn_*` field map. `intervalMs`, `distanceFilterMeters`, and `notification` are optional.

```ts
const target: GeoTrackingTarget = {
  connectionUrl: 'https://org.crm.dynamics.com',
  trackInBackground: true,
  persistAcrossRestarts: false,
};

await startTracking('my-wrap-app', target);
```

## 5. Type-check and summary

```bash
npx tsc --noEmit
```

Only after table + columns are verified and TypeScript passes, report:

```text
Geolocation status : READY
Package present    : @microsoft/power-apps-native-bglocation
Wrapper            : src/native/geolocation.ts
Required config    : connectionUrl, trackInBackground, persistAcrossRestarts
Auth               : MSAL only
Target table       : <TABLE> verified
Native config      : not changed
```

If table verification failed, report `BLOCKED` or `UNVERIFIED` instead and do not update `memory-bank.md` as if the control is ready.
