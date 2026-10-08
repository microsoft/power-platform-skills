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

/**
 * Extracts the $skiptoken value from a Dataverse OData nextLink URL.
 * Falls back to regex parsing if the URL constructor fails.
 * 
 * @param nextLink The @odata.nextLink string returned by a paginated query
 * @returns The decoded skiptoken string, or undefined if not found
 */
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

/**
 * Escapes single quotes in a string for safe inclusion in an OData query.
 * Dataverse uses single quotes for string literals.
 *
 * @param value The string to escape
 * @returns The escaped string
 */
export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Builds an OData contains() filter expression for a text column.
 * Escapes the search text automatically.
 *
 * @param columnLogicalName The logical name of the Dataverse column
 * @param searchText The text to search for
 * @returns The OData filter string, or undefined if the text is empty
 */
export function containsFilter(columnLogicalName: string, searchText: string): string | undefined {
  const trimmed = searchText.trim();
  if (!trimmed) return undefined;
  return `contains(${columnLogicalName}, '${escapeODataString(trimmed)}')`;
}

/**
 * Normalizes Dataverse record IDs without enforcing RFC UUID version bits.
 * Dataverse sequential GUIDs can contain values such as `f111` in the third
 * group and remain valid record identifiers.
 */
export function normalizeDataverseGuid(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[{}]/g, '').toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : undefined;
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
 *   const payload: Pick<Parameters<typeof Cr3e9_inspectionService.create>[0], 'cr3e9_inspectionid' | 'cr3e9_aircraftid'> = {
 *     cr3e9_inspectionid: inspectionId,
 *     cr3e9_aircraftid: aircraftId,
 *     // ...
 *   };
 *   await Cr3e9_inspectionService.create(payload as Parameters<typeof Cr3e9_inspectionService.create>[0]);
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
