/**
 * Data layer core - the contract between screens and wherever their data comes from.
 *
 * `/create-mobile-app` builds and previews screens before any Dataverse table, connector, or
 * native wrapper exists. Screens therefore never import generated services or `src/native/`
 * directly; they call hooks and device actions from `@/hooks/data`. Each entity module there
 * owns one *source* object. During the preview it is `createMockSource(fixtures)`; once the data
 * model is applied, only that source is rewritten to call the generated service. Screen files
 * do not change when the data becomes real.
 *
 * This file is copied once by template preparation and is shared by every entity module.
 * Do not put app-specific types here. See
 * `shared/references/preview-data-layer.md` in the mobile-apps plugin for the full contract.
 */

import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

/** Arguments every `list` call receives. Mirrors `useCursorListData`'s `fetchPage` arguments. */
export interface ListArgs {
  pageSize: number;
  search: string;
  /** Opaque continuation token from the previous page; absent for the first page. */
  skipToken?: string;
}

/**
 * One page of records. `nextSkipToken` is the shape `useCursorListData` already understands, so
 * a source can be passed straight to it without an adapter in the hook.
 */
export interface ListPage<T> {
  items: T[];
  nextSkipToken?: string;
}

export type EntityOperation = 'list' | 'get' | 'create' | 'update' | 'remove';

export interface EntityOperations<T, Draft> {
  list(args: ListArgs): Promise<ListPage<T>>;
  get(id: string): Promise<T | null>;
  create(draft: Draft): Promise<T>;
  update(id: string, patch: Partial<Draft>): Promise<T>;
  remove(id: string): Promise<void>;
}

/**
 * The operations an entity actually supports. Declaring the subset (for example
 * `EntitySource<Site, SiteDraft, 'list' | 'get'>`) keeps the real adapter honest: it only has to
 * implement what screens use, and a screen cannot call an operation the data model never planned.
 */
export type EntitySource<
  T,
  Draft = Omit<T, 'id'>,
  Ops extends EntityOperation = EntityOperation,
> = Pick<EntityOperations<T, Draft>, Ops>;

/**
 * Result of a device action (camera, location, scanner, ...). Matches the discriminated-union
 * convention of the `src/native/` wrappers, so wiring a real wrapper is a mapping, not a redesign.
 */
export type DeviceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'cancelled' | 'denied' | 'unavailable' | 'error'; message?: string };

/**
 * Result of a create, update, or remove. Screens branch on `ok` and show `message` inline instead
 * of wrapping every call in try/catch, and the shape is identical for sample and real data.
 */
export type MutationResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

/**
 * The part of a generated service result an adapter needs. Declared structurally so this file does
 * not depend on `@microsoft/power-apps` types, which the preview never loads. Generated services
 * resolve (rather than reject) with `success: false` and an `error` on failure, e.g.
 *   { success: false, data: undefined, error: Error('Principal user is missing prvReadcr123_inspection') }
 */
export interface ServiceResult<T> {
  success?: boolean;
  data: T;
  error?: unknown;
  skipToken?: string;
  count?: number;
}

/** Returns `data`, or throws so `useSourceMutation` and React Query surface the failure. */
export function unwrapResult<T>(result: ServiceResult<T>, fallback = 'Request failed'): T {
  if (result.error || result.success === false) {
    throw new Error(errorMessage(result.error, fallback));
  }
  return result.data;
}

export interface MockSourceOptions<T, Draft> {
  /** Fields matched by `list({ search })`, case-insensitively. Omit to ignore search. */
  searchFields?: readonly (keyof T)[];
  /** Order applied to every `list` result. */
  sort?: (a: T, b: T) => number;
  /**
   * Builds a stored record from a create draft. Needed when the record has fields the form does
   * not supply, such as a derived display name or a default status.
   */
  fromDraft?: (draft: Draft, id: string) => T;
  /**
   * Simulated round trip. Without it the preview never shows a loading state, so a screen whose
   * skeleton or spinner is broken looks fine until it meets a real network.
   */
  latencyMs?: number;
}

let mockIdCounter = 0;

/** Not a GUID and not meant to be: preview ids only need to be unique within one session. */
function nextMockId(): string {
  mockIdCounter += 1;
  return `preview-${Date.now().toString(36)}-${mockIdCounter}`;
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function matchesSearch<T>(record: T, search: string, fields: readonly (keyof T)[]): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle || fields.length === 0) return true;
  return fields.some((field) => {
    const value = record[field];
    return value !== null && value !== undefined && String(value).toLowerCase().includes(needle);
  });
}

/**
 * An in-memory source over sample records, used only while the app runs on preview data.
 *
 * Mutations change a session copy of the fixtures, so a create or edit form can be exercised end
 * to end in the web preview; a reload restores the original records. The `skipToken` is the next
 * offset as a string, which keeps cursor pagination observable with small fixture sets.
 */
export function createMockSource<T extends { id: string }, Draft = Omit<T, 'id'>>(
  fixtures: readonly T[],
  options: MockSourceOptions<T, Draft> = {},
): EntityOperations<T, Draft> {
  const { searchFields = [], sort, fromDraft, latencyMs = 250 } = options;
  let records: T[] = fixtures.map((record) => ({ ...record }));

  const toRecord = fromDraft ?? ((draft: Draft, id: string) => ({ ...draft, id }) as unknown as T);

  return {
    async list({ pageSize, search, skipToken }) {
      await wait(latencyMs);
      const matching = records.filter((record) => matchesSearch(record, search, searchFields));
      const ordered = sort ? [...matching].sort(sort) : matching;
      const offset = Math.max(0, Number.parseInt(skipToken ?? '0', 10) || 0);
      const end = offset + Math.max(1, pageSize);
      return {
        items: ordered.slice(offset, end),
        nextSkipToken: end < ordered.length ? String(end) : undefined,
      };
    },

    async get(id) {
      await wait(latencyMs);
      return records.find((record) => record.id === id) ?? null;
    },

    async create(draft) {
      await wait(latencyMs);
      const created = toRecord(draft, nextMockId());
      records = [created, ...records];
      return created;
    },

    async update(id, patch) {
      await wait(latencyMs);
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) throw new Error(`No sample record with id ${id}`);
      const updated = { ...records[index], ...patch } as T;
      records = records.map((record, i) => (i === index ? updated : record));
      return updated;
    },

    async remove(id) {
      await wait(latencyMs);
      records = records.filter((record) => record.id !== id);
    },
  };
}

/**
 * Wraps a preview device action so it behaves like a real one: it takes time, and it returns the
 * same result shape. Use it for every stub in `device.ts` until the native wrapper is wired.
 */
export async function previewDeviceResult<T>(value: T, latencyMs = 400): Promise<DeviceResult<T>> {
  await wait(latencyMs);
  return { ok: true, value };
}

/**
 * An ISO date (`yyyy-mm-dd`) relative to today, for sample records. Fixed calendar dates go stale:
 * a week after generation every "upcoming" sample is overdue and the dashboard lies.
 */
export function daysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface SourceQueryState<T> {
  data: T | undefined;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * A single-record or aggregate read (`get`, a dashboard count, ...). Built on the host's React
 * Query client so every entity hook shares one cache, and so a mutation can invalidate it by key.
 * Return `null` from `load` for "not found"; React Query rejects `undefined` as query data.
 */
export function useSourceQuery<T>(
  queryKey: readonly unknown[],
  load: () => Promise<T>,
  options: { enabled?: boolean } = {},
): SourceQueryState<T> {
  const query = useQuery({ queryKey, queryFn: load, enabled: options.enabled ?? true });
  const { refetch } = query;
  return {
    data: query.data,
    loading: query.isLoading,
    refreshing: query.isRefetching,
    error: query.error ? errorMessage(query.error, 'Failed to load data') : null,
    refetch: useCallback(() => {
      void refetch();
    }, [refetch]),
  };
}

/**
 * Runs mutations for one entity and refreshes everything cached under its key afterwards, so a
 * list a user returns to already shows the record they just created. Adapters signal failure by
 * throwing; this turns that into a `MutationResult` the screen can render.
 */
export function useSourceMutation(invalidateKey: readonly unknown[]) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  // Latched in a ref, as `useListData` does with its fetcher: callers pass an inline array, and
  // depending on it directly would hand screens a new `run` on every render.
  const keyRef = useRef(invalidateKey);
  keyRef.current = invalidateKey;

  const run = useCallback(
    async <R>(action: () => Promise<R>): Promise<MutationResult<R>> => {
      setSaving(true);
      try {
        const value = await action();
        await queryClient.invalidateQueries({ queryKey: keyRef.current });
        return { ok: true, value };
      } catch (error) {
        return { ok: false, message: errorMessage(error, 'Could not save your changes') };
      } finally {
        setSaving(false);
      }
    },
    [queryClient],
  );

  return { saving, run };
}
