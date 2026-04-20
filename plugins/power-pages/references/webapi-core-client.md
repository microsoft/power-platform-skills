# Web API Core Client Template

This reference contains the complete `powerPagesApi.ts` template — the centralized Power Pages Web API client shared by all table services. Create this file at `src/shared/powerPagesApi.ts` (or reuse an existing one detected in Step 1.3).

Adapt imports and style to match the project's existing TypeScript conventions (semicolons, quotes, etc.).

## Complete File

```typescript
// src/shared/powerPagesApi.ts
// Centralized Power Pages Web API client with token management, retry logic, and OData helpers.

// ── Anti-Forgery Token ────────────────────────────────────────────────────────
// Power Pages Web API requires a __RequestVerificationToken header on every
// mutating request. The token is fetched once from /_layout/tokenhtml and
// reused for all subsequent requests. It is only re-fetched when a 403 response
// with the anti-forgery error code (90040107) indicates the token has expired.
// No Authorization/Bearer header is needed — authenticated users get cookie-based
// session auth automatically.

let cachedAntiForgeryToken: string | null = null;

const fetchAntiForgeryToken = async (): Promise<string> => {
  if (cachedAntiForgeryToken) {
    return cachedAntiForgeryToken;
  }

  try {
    const response = await fetch('/_layout/tokenhtml', {});
    if (response.status !== 200) {
      throw new Error(`Failed to fetch token: ${response.status}`);
    }

    const tokenResponse = await response.text();
    const valueString = 'value="';
    const terminalString = '" />';
    const valueIndex = tokenResponse.indexOf(valueString);

    if (valueIndex === -1) {
      throw new Error('Token not found in response');
    }

    const token = tokenResponse.substring(
      valueIndex + valueString.length,
      tokenResponse.indexOf(terminalString, valueIndex)
    );

    cachedAntiForgeryToken = token || '';
    return cachedAntiForgeryToken;
  } catch (error) {
    console.warn('Failed to fetch anti-forgery token:', error);
    return '';
  }
};

/** Invalidate the cached token so the next request re-fetches it. */
const invalidateAntiForgeryToken = (): void => {
  cachedAntiForgeryToken = null;
};

// ── Header Builder ────────────────────────────────────────────────────────────

export const buildPowerPagesHeaders = async (
  incoming?: HeadersInit,
  options?: { accept?: string | null; contentType?: string | null; prefer?: string | null }
): Promise<Headers> => {
  const antiForgeryToken = await fetchAntiForgeryToken();
  const headers = new Headers({
    __RequestVerificationToken: antiForgeryToken,
  });

  if (options?.accept !== null) {
    headers.set('Accept', options?.accept ?? 'application/json');
  }
  if (options?.contentType !== null) {
    headers.set('Content-Type', options?.contentType ?? 'application/json');
  }
  if (options?.prefer !== null) {
    headers.set(
      'Prefer',
      options?.prefer ?? 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"'
    );
  }

  if (incoming) {
    const extra = new Headers(incoming);
    extra.forEach((value, key) => headers.set(key, value));
  }

  return headers;
};

// ── Response Parsing ──────────────────────────────────────────────────────────

export const parseResponseBody = async <T>(response: Response): Promise<T | null> => {
  if (response.status === 204 || response.status === 202) return null;

  const text = await response.text();
  if (!text || text.trim() === '') return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    console.warn('Failed to parse response body as JSON');
    return null;
  }
};

// ── Create Response Helper ────────────────────────────────────────────────

/**
 * Extract the created record ID from a POST response.
 * Power Pages Web API may return the entity in the body (when Prefer: return=representation
 * is honored) or just a success status with the record URL in the Location header.
 */
export const extractRecordId = (response: Response): string | null => {
  const location = response.headers.get('Location') ?? response.headers.get('OData-EntityId');
  if (!location) return null;
  const match = location.match(/\(([0-9a-fA-F-]{36})\)/);
  return match ? match[1] : null;
};

// ── Retry Helpers ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

const isTransientError = (status: number): boolean =>
  status === 429 || (status >= 500 && status < 600);

// ── Core Fetch Wrapper ────────────────────────────────────────────────────────

export async function powerPagesFetch<T>(
  url: string,
  options?: RequestInit & { signal?: AbortSignal }
): Promise<T | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const headers = await buildPowerPagesHeaders(options?.headers);

    const response = await fetch(url, { ...options, headers });

    // On 401, the user's session has expired — do not retry, prompt re-authentication
    if (response.status === 401) {
      throw new Error('Session expired. Please sign in again.');
    }

    // On 403, check if it's an anti-forgery token error — only retry for that
    if (response.status === 403 && attempt < MAX_RETRIES) {
      const errorCode = await extractErrorCode(response.clone());
      if (errorCode === WebApiErrorCode.AntiForgeryTokenInvalid) {
        invalidateAntiForgeryToken();
        continue;
      }
      // Not a token error — this is a real permission denial, don't retry
    }

    if (isTransientError(response.status) && attempt < MAX_RETRIES) {
      const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      await sleep(delay, options?.signal);
      continue;
    }

    if (!response.ok) {
      let message = `Request failed with status ${response.status}`;
      try {
        const payload = await response.json();
        if (payload?.error?.message) message = payload.error.message;
      } catch { /* ignore parse errors */ }
      throw new Error(message);
    }

    return parseResponseBody<T>(response);
  }

  throw new Error('Max retries exceeded');
}

/**
 * Like powerPagesFetch but returns the raw Response object.
 * Useful when you need headers (e.g. OData-EntityId from POST).
 */
export async function powerPagesFetchResponse(
  url: string,
  options?: RequestInit & { signal?: AbortSignal }
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const headers = await buildPowerPagesHeaders(options?.headers);

    const response = await fetch(url, { ...options, headers });

    // On 401, the user's session has expired — do not retry, prompt re-authentication
    if (response.status === 401) {
      throw new Error('Session expired. Please sign in again.');
    }

    // On 403, check if it's an anti-forgery token error — only retry for that
    if (response.status === 403 && attempt < MAX_RETRIES) {
      const errorCode = await extractErrorCode(response.clone());
      if (errorCode === WebApiErrorCode.AntiForgeryTokenInvalid) {
        invalidateAntiForgeryToken();
        continue;
      }
      // Not a token error — this is a real permission denial, don't retry
    }

    if (isTransientError(response.status) && attempt < MAX_RETRIES) {
      const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      await sleep(delay, options?.signal);
      continue;
    }

    if (!response.ok) {
      let message = `Request failed with status ${response.status}`;
      try {
        const payload = await response.json();
        if (payload?.error?.message) message = payload.error.message;
      } catch { /* ignore */ }
      throw new Error(message);
    }

    return response;
  }

  throw new Error('Max retries exceeded');
}

// ── Web API Error Codes ──────────────────────────────────────────────────────
// These hex codes are returned by the Power Pages Web API on errors.
// Use them to provide specific error messages in the UI.

export const WebApiErrorCode = {
  ReadPermissionDenied: '90040120',
  WritePermissionDenied: '90040102',
  CreatePermissionDenied: '90040103',
  DeletePermissionDenied: '90040104',
  AppendPermissionDenied: '90040105',
  AppendToPermissionDenied: '90040106',
  AntiForgeryTokenInvalid: '90040107',
  ResourceNotFound: '9004010c',
  CdsError: '9004010d',
} as const;

/**
 * Extract the error code from a Web API Response object.
 * Reads the JSON body: { error: { code: "90040120", message: "..." } }
 * Returns the hex code string (e.g., '90040120') or undefined.
 * Use response.clone() before passing if you need to read the body again.
 */
const extractErrorCode = async (response: Response): Promise<string | undefined> => {
  try {
    const payload = await response.json();
    const code = payload?.error?.code;
    return typeof code === 'string' ? code.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Parse the error code from a caught Error object.
 * Returns the hex code string (e.g., '90040120') or undefined.
 */
export const parseErrorCode = (error: unknown): string | undefined => {
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = (error as Error).message;
    const match = msg.match(/[0-9a-f]{8}/i);
    return match?.[0]?.toLowerCase();
  }
  return undefined;
};

/**
 * Check if an error is a permission denied error (any CRUD operation).
 */
export const isPermissionError = (error: unknown): boolean => {
  const code = parseErrorCode(error);
  return code !== undefined && [
    WebApiErrorCode.ReadPermissionDenied,
    WebApiErrorCode.WritePermissionDenied,
    WebApiErrorCode.CreatePermissionDenied,
    WebApiErrorCode.DeletePermissionDenied,
    WebApiErrorCode.AppendPermissionDenied,
    WebApiErrorCode.AppendToPermissionDenied,
  ].includes(code as any);
};

// ── OData URL Builder ─────────────────────────────────────────────────────────

export const buildODataUrl = (
  entitySet: string,
  query?: Record<string, string | undefined>
): string => {
  if (!query) return `/_api/${entitySet}`;

  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      const encoded = encodeURIComponent(value).replace(/%2C/g, ',');
      parts.push(`${key}=${encoded}`);
    }
  }

  return parts.length > 0 ? `/_api/${entitySet}?${parts.join('&')}` : `/_api/${entitySet}`;
};

export const escapeODataString = (value: string): string =>
  value.replace(/'/g, "''");

// ── OData Types ───────────────────────────────────────────────────────────────

export interface ODataCollectionResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.count'?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  totalCount: number;
  nextLink?: string;
}

/**
 * Response shape for expanded collection-valued navigation properties.
 * Each expanded collection includes an @odata.nextLink for paging through
 * additional related records when the query uses nested $expand.
 */
export interface ExpandedCollection<T> {
  items: T[];
  nextLink?: string;
}

/**
 * Parse an expanded collection-valued navigation property from a raw OData entity.
 * Extracts both the array of related records and the @odata.nextLink for paging.
 *
 * @param entity - The parent entity object from the OData response
 * @param property - The navigation property name (e.g., 'cr4fc_order_lines')
 * @returns The related records array and optional nextLink for further paging
 */
export const parseExpandedCollection = <T>(
  entity: Record<string, unknown>,
  property: string
): ExpandedCollection<T> => {
  const raw = entity[property];
  return {
    items: Array.isArray(raw) ? (raw as T[]) : [],
    nextLink: entity[`${property}@odata.nextLink`] as string | undefined,
  };
};

// ── Formatted Value Helper ────────────────────────────────────────────────────

/**
 * Extract a formatted value from an OData entity.
 * Formatted values are returned when the Prefer header includes
 * odata.include-annotations="OData.Community.Display.V1.FormattedValue".
 * Useful for option set labels and lookup display names.
 */
export const getFormattedValue = (
  record: Record<string, unknown>,
  logicalName: string
): string | undefined =>
  record[`${logicalName}@OData.Community.Display.V1.FormattedValue`] as string | undefined;

// ── Pagination Helper ─────────────────────────────────────────────────────────

const MAX_PAGINATION_ITERATIONS = 100;

export const fetchAllPages = async <T>(initialUrl: string, pageSize = 100): Promise<T[]> => {
  let nextUrl: string | undefined = initialUrl;
  const results: T[] = [];
  let iterations = 0;

  while (nextUrl) {
    if (++iterations > MAX_PAGINATION_ITERATIONS) {
      console.error('Exceeded maximum pagination iterations');
      break;
    }

    // Prefer: odata.maxpagesize is required on every request (including nextLink cursors)
    // to ensure @odata.nextLink is returned for subsequent pages.
    const response = await powerPagesFetch<ODataCollectionResponse<T>>(nextUrl, {
      headers: {
        'Prefer': `odata.include-annotations="OData.Community.Display.V1.FormattedValue",odata.maxpagesize=${pageSize}`,
      },
    });
    if (!response) break;

    results.push(...(response.value ?? []));
    nextUrl = response['@odata.nextLink'];
  }

  return results;
};

// ── Lookup Binding Helper ─────────────────────────────────────────────────────

/**
 * Set or clear a lookup relationship on a request body using @odata.bind.
 *
 * @param body - The request body object to modify
 * @param navigationProperty - The navigation property name (e.g., 'cr4fc_Category')
 * @param entitySetName - The target entity set (e.g., 'cr4fc_categories')
 * @param id - The target record ID. Pass null to unbind, undefined to skip.
 */
export const bindLookup = (
  body: Record<string, unknown>,
  navigationProperty: string,
  entitySetName: string,
  id?: string | null
): void => {
  if (id === null) {
    body[`${navigationProperty}@odata.bind`] = null;
  } else if (id) {
    body[`${navigationProperty}@odata.bind`] = `/${entitySetName}(${id})`;
  }
};

// ── Expand Builder ────────────────────────────────────────────────────────────

/**
 * Options for expanding a navigation property.
 * Single-valued (lookup) navigation properties support: $select, $expand (nested).
 * Collection-valued (one-to-many) navigation properties support: $select, $filter, $orderby, $top.
 * Note: $orderby and $top are NOT supported when the query contains any nested $expand.
 */
export interface ExpandOption {
  /** Navigation property name — must match exact Dataverse schema name (case-sensitive) */
  property: string;
  /** Columns to select from the related entity */
  select?: string[];
  /** Filter expression for collection-valued navigation properties */
  filter?: string;
  /** Order expression for collection-valued navigation properties (not supported with nested $expand) */
  orderBy?: string;
  /** Max records for collection-valued navigation properties (not supported with nested $expand) */
  top?: number;
  /** Nested expand options for single-valued navigation properties */
  expand?: ExpandOption[];
}

/**
 * Build an OData $expand clause from structured options.
 * Handles nested expand for single-valued navigation properties and
 * query options ($select, $filter, $orderby, $top) for collection-valued navigation properties.
 *
 * @example Single-valued with nested expand (lookup → lookup → lookup):
 * buildExpandClause([{
 *   property: 'cr4fc_Contact',
 *   select: ['fullname'],
 *   expand: [{
 *     property: 'parentcustomerid_account',
 *     select: ['name'],
 *     expand: [{ property: 'createdby', select: ['fullname'] }]
 *   }]
 * }])
 * // → "cr4fc_Contact($select=fullname;$expand=parentcustomerid_account($select=name;$expand=createdby($select=fullname)))"
 *
 * @example Collection-valued with filter and ordering:
 * buildExpandClause([{
 *   property: 'cr4fc_order_lines',
 *   select: ['cr4fc_quantity', 'cr4fc_unitprice'],
 *   filter: 'cr4fc_quantity gt 0',
 *   orderBy: 'cr4fc_unitprice desc',
 *   top: 10,
 * }])
 * // → "cr4fc_order_lines($select=cr4fc_quantity,cr4fc_unitprice;$filter=cr4fc_quantity gt 0;$orderby=cr4fc_unitprice desc;$top=10)"
 *
 * @example Multiple expands (single + collection):
 * buildExpandClause([
 *   { property: 'cr4fc_Category', select: ['cr4fc_categoryid', 'cr4fc_name'] },
 *   { property: 'cr4fc_product_reviews', select: ['cr4fc_rating', 'cr4fc_comment'], top: 5 },
 * ])
 * // → "cr4fc_Category($select=cr4fc_categoryid,cr4fc_name),cr4fc_product_reviews($select=cr4fc_rating,cr4fc_comment;$top=5)"
 */
export const buildExpandClause = (options: ExpandOption[]): string =>
  options.map(formatExpandOption).join(',');

const formatExpandOption = (opt: ExpandOption): string => {
  const parts: string[] = [];

  if (opt.select?.length) {
    parts.push(`$select=${opt.select.join(',')}`);
  }
  if (opt.filter) {
    parts.push(`$filter=${opt.filter}`);
  }
  if (opt.orderBy) {
    parts.push(`$orderby=${opt.orderBy}`);
  }
  if (opt.top !== undefined) {
    parts.push(`$top=${opt.top}`);
  }
  if (opt.expand?.length) {
    parts.push(`$expand=${buildExpandClause(opt.expand)}`);
  }

  return parts.length > 0
    ? `${opt.property}(${parts.join(';')})`
    : opt.property;
};

// ── File Column Helpers ───────────────────────────────────────────────────────

/**
 * Download a file or image column value as an object URL.
 * Returns null if no file is stored (404).
 */
export const fetchFileColumnUrl = async (
  table: string,
  recordId: string,
  column: string
): Promise<string | null> => {
  const headers = await buildPowerPagesHeaders(undefined, {
    accept: '*/*',
    contentType: 'application/octet-stream',
    prefer: null,
  });

  const response = await fetch(`/_api/${table}(${recordId})/${column}/$value`, { headers });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`File download failed: ${response.status}`);

  const blob = await response.blob();
  return URL.createObjectURL(blob);
};

/**
 * Upload a file or image to a file column.
 * Note: Upload uses the column URL directly (no /$value), unlike download.
 */
export const uploadFileColumn = async (
  table: string,
  recordId: string,
  column: string,
  file: Blob,
  fileName?: string
): Promise<void> => {
  const headers = await buildPowerPagesHeaders(
    {
      'If-Match': '*',
      ...(fileName ? { 'x-ms-file-name': fileName } : {}),
    },
    {
      accept: 'application/json',
      contentType: 'application/octet-stream',
      prefer: null,
    }
  );

  const response = await fetch(`/_api/${table}(${recordId})/${column}`, {
    method: 'PATCH',
    headers,
    body: await file.arrayBuffer(),
  });

  if (!response.ok) throw new Error(`File upload failed: ${response.status}`);
};
```
