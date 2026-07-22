/**
 * Dataverse helpers — centralizes the three patterns that cause silent runtime
 * bugs when inlined at every call site. Always import from `@/utils`, never
 * re-implement these inline in screen files.
 */

import * as Crypto from 'expo-crypto';

/**
 * Read the OData formatted-value annotation Dataverse returns for a lookup
 * column. The `<lookup>name` virtual property is NOT a queryable Web API
 * attribute on custom entities — putting it in $select returns HTTP 400.
 * Instead, the SDK already requests `Prefer: odata.include-annotations=*`,
 * so each `_<lookup>_value` arrives paired with
 * `_<lookup>_value@OData.Community.Display.V1.FormattedValue`, which holds
 * the related record's primary name.
 *
 * Usage:
 *   const flightName = lookupName(record, 'cr3e9_flightid') ?? '—';
 */
export function lookupName(
  record: unknown,
  lookupLogicalName: string,
): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const key = `_${lookupLogicalName}_value@OData.Community.Display.V1.FormattedValue`;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read the OData formatted-value annotation for a non-lookup column
 * (picklist, boolean, status, datetime, money). Annotation key here is
 * `<column>@OData.Community.Display.V1.FormattedValue` — note no leading
 * underscore and no `_value` suffix, in contrast to lookups.
 *
 * Usage:
 *   const statusLabel = formattedValue(record, 'cr3e9_status') ?? '—';
 */
export function formattedValue(
  record: unknown,
  columnLogicalName: string,
): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const key = `${columnLogicalName}@OData.Community.Display.V1.FormattedValue`;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function extractSkipToken(nextLink: string | null | undefined): string | undefined {
  if (!nextLink) return undefined;
  try {
    return new URL(nextLink).searchParams.get('$skiptoken') ?? undefined;
  } catch {
    const match = nextLink.match(/[?&]\$skiptoken=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : undefined;
  }
}

export const extractSkiptoken = extractSkipToken;

export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

export function containsFilter(columnLogicalName: string, searchText: string): string | undefined {
  const trimmed = searchText.trim();
  if (!trimmed) return undefined;
  return `contains(${columnLogicalName}, '${escapeODataString(trimmed)}')`;
}

/**
 * Pre-generate a Dataverse primary-key GUID for create-then-navigate flows.
 * The Power Apps SDK's `*Service.create()` returns 204 No Content on success
 * with no record ID in the response — so any code that needs the new ID
 * immediately (detail route, walkaround stepper, child rows, file/photo
 * upload, or `router.replace`/`router.push` to the created record) MUST
 * supply the primary-key value in the create payload.
 *
 * Usage:
 *   import { newId, lookupName } from '@/utils';
 *   const inspectionId = newId();
 *   await Cr3e9_inspectionService.create({
 *     cr3e9_inspectionid: inspectionId,
 *     cr3e9_aircraftid: aircraftId,
 *     // ...
 *   } as any);
 *   router.replace(`/inspections/${inspectionId}`);
 *
 * Guardrails:
 * - Use only when the next step needs the new record ID immediately.
 * - For ordinary save → `router.back()` flows, let Dataverse generate the ID.
 * - Never encode names, business numbers, tenant/user identifiers, timestamps,
 *   or any meaningful/sensitive data in a primary key.
 */
export function newId(): string {
  return Crypto.randomUUID();
}
