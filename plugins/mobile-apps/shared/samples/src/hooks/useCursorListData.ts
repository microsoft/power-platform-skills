/**
 * useCursorListData — cursor-paginated list state for unbounded Dataverse tables.
 *
 * Use this for screens whose plan says `Pagination: cursor`. Bounded lookup
 * lists can keep using `useListData`.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
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
  initialSearch = '',
  searchDebounceMs = 300,
  enabled = true,
  mockData,
}: UseCursorListDataOptions<T>): UseCursorListDataReturn<T> {
  const [query, setQuery] = useState(initialSearch);
  const debouncedQuery = useDebouncedValue(query.trim(), searchDebounceMs);

  const cursorQuery = useInfiniteQuery({
    queryKey: [...queryKey, { search: debouncedQuery, pageSize }],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => normalizePage(
      await fetchPage({
        pageSize,
        search: debouncedQuery,
        skipToken: pageParam,
      }),
    ),
    getNextPageParam: (lastPage: NormalizedCursorPage<T>) => (
      lastPage.nextSkipToken ?? extractSkipToken(lastPage.nextLink) ?? undefined
    ),
  });

  const items = useMemo(() => {
    const loadedItems = cursorQuery.data?.pages.flatMap((page: NormalizedCursorPage<T>) => page.items) ?? [];
    return loadedItems.length > 0 ? loadedItems : (mockData ?? []);
  }, [cursorQuery.data?.pages, mockData]);

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
    void cursorQuery.refetch();
  }, [cursorQuery]);

  const refetch = useCallback(() => {
    void cursorQuery.refetch();
  }, [cursorQuery]);

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
    refetch,
    loadMore,
  };
}

function normalizePage<T>(result: CursorPageResult<T>): NormalizedCursorPage<T> {
  if (Array.isArray(result)) {
    return { items: result, nextLink: null };
  }

  if (result.error) {
    throw new Error(errorMessage(result.error));
  }

  const items = result.items ?? result.data ?? result.value ?? [];
  const nextLink = result.nextLink ?? result['@odata.nextLink'] ?? null;
  const nextSkipToken = result.nextSkipToken
    ?? result.nextSkiptoken
    ?? result.skipToken
    ?? result.skiptoken
    ?? extractSkipToken(nextLink);

  return { items, nextLink, nextSkipToken };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'Failed to load data');
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