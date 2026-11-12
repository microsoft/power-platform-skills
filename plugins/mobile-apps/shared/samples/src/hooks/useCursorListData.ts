/**
 * useCursorListData — cursor-paginated list state for unbounded Dataverse tables.
 *
 * Use this for screens whose plan says `Pagination: cursor`. Bounded lookup
 * lists can keep using `useListData`.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { extractSkipToken } from '@/utils';

export interface CursorPageFetchArgs {
  pageSize: number;
  search: string;
  skipToken?: string;
  nextLink?: string;
}

export type CursorPageResult<T> =
  | T[]
  | {
      success?: boolean;
      items?: T[] | null;
      data?: T[] | null;
      value?: T[] | null;
      nextLink?: string | null;
      nextSkipToken?: string | null;
      nextSkiptoken?: string | null;
      skipToken?: string | null;
      skiptoken?: string | null;
      '@odata.nextLink'?: string | null;
      error?: { message?: string } | unknown;
    };

export interface UseCursorListDataOptions<T> {
  queryKey: readonly unknown[];
  fetchPage: (args: CursorPageFetchArgs) => Promise<CursorPageResult<T>>;
  pageSize?: number;
  cursorMode?: 'skipToken' | 'nextLink';
  initialSearch?: string;
  searchDebounceMs?: number;
  enabled?: boolean;
  mockData?: T[];
}

export interface UseCursorListDataReturn<T> {
  items: T[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  hasNextPage: boolean;
  error: string | null;
  query: string;
  setQuery: (query: string) => void;
  onRefresh: () => void;
  refetch: () => void;
  loadMore: () => void;
}

interface NormalizedCursorPage<T> {
  items: T[];
  nextLink: string | null;
  nextSkipToken?: string;
}

export function useCursorListData<T>({
  queryKey,
  fetchPage,
  pageSize = 50,
  cursorMode = 'skipToken',
  initialSearch = '',
  searchDebounceMs = 300,
  enabled = true,
  mockData,
}: UseCursorListDataOptions<T>): UseCursorListDataReturn<T> {
  const [query, setQuery] = useState(initialSearch);
  const debouncedQuery = useDebouncedValue(query.trim(), searchDebounceMs);
  const queryClient = useQueryClient();
  const cursorKey = useMemo(
    () => [...queryKey, { search: debouncedQuery, pageSize, cursorMode }],
    [queryKey, debouncedQuery, pageSize, cursorMode],
  );

  const cursorQuery = useInfiniteQuery({
    queryKey: cursorKey,
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => normalizePage(
      await fetchPage({
        pageSize,
        search: debouncedQuery,
        ...(cursorMode === 'nextLink' ? { nextLink: pageParam } : { skipToken: pageParam }),
      }),
      cursorMode,
    ),
    getNextPageParam: (lastPage: NormalizedCursorPage<T>) => (
      cursorMode === 'nextLink' ? lastPage.nextLink ?? undefined : lastPage.nextSkipToken
    ),
  });

  const items = useMemo(() => {
    if (cursorQuery.data) return cursorQuery.data.pages.flatMap((page: NormalizedCursorPage<T>) => page.items);
    return enabled ? [] : (mockData ?? []);
  }, [cursorQuery.data, enabled, mockData]);

  const error = cursorQuery.error
    ? cursorQuery.error instanceof Error
      ? cursorQuery.error.message
      : 'Failed to load data'
    : null;

  const loadMore = useCallback(() => {
    if (cursorQuery.hasNextPage && !cursorQuery.isFetchingNextPage) {
      void cursorQuery.fetchNextPage();
    }
  }, [cursorQuery]);

  const onRefresh = useCallback(() => {
    // Saved-view continuations belong to one query chain; restart at the first page.
    void queryClient.resetQueries({ queryKey: cursorKey, exact: true });
  }, [queryClient, cursorKey]);

  return {
    items,
    loading: cursorQuery.isLoading,
    refreshing: cursorQuery.isRefetching && !cursorQuery.isFetchingNextPage,
    loadingMore: cursorQuery.isFetchingNextPage,
    hasNextPage: Boolean(cursorQuery.hasNextPage),
    error,
    query,
    setQuery,
    onRefresh,
    refetch: onRefresh,
    loadMore,
  };
}

function normalizePage<T>(
  result: CursorPageResult<T>,
  cursorMode: 'skipToken' | 'nextLink',
): NormalizedCursorPage<T> {
  if (Array.isArray(result)) {
    return { items: result, nextLink: null };
  }

  if (result.success === false || result.error) {
    throw new Error(errorMessage(result.error));
  }

  const items = result.items ?? result.data ?? result.value;
  if (!Array.isArray(items)) throw new Error('Data response did not contain a record array');
  const nextLink = result.nextLink ?? result['@odata.nextLink'] ?? null;
  if (nextLink !== null && (typeof nextLink !== 'string' || nextLink.length === 0)) {
    throw new Error('Data response contained an invalid nextLink');
  }
  const nextSkipToken = result.nextSkipToken
    ?? result.nextSkiptoken
    ?? result.skipToken
    ?? result.skiptoken
    ?? (cursorMode === 'skipToken' ? extractSkipToken(nextLink) : undefined);
  if (cursorMode === 'nextLink' && nextSkipToken && !nextLink) {
    throw new Error('Saved-query pagination requires the complete nextLink, not a skip token');
  }

  return { items, nextLink, nextSkipToken };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message ?? 'Failed to load data');
  }
  return 'Failed to load data';
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timeoutId);
  }, [value, delayMs]);

  return debounced;
}