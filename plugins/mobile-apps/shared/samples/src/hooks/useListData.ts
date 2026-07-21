/**
 * useListData — eliminates the load/refresh/error boilerplate from every list screen.
 *
 * Usage:
 *   const { items, loading, refreshing, error, onRefresh, refetch } = useListData(
 *     () => CategoryService.getAll({ orderBy: ['name asc'], top: 50 }),
 *     { mockData: MOCK_CATEGORIES }
 *   );
 *
 * For unbounded Dataverse tables such as inspections, visits, work orders, or
 * tickets, use `useCursorListData` instead.
 */

import { useState, useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

interface ServiceResult<T> {
  data?: T[] | null;
  error?: { message?: string } | unknown;
}

interface UseListDataOptions<T> {
  /** Fallback data when the service returns an error or empty result */
  mockData?: T[];
  /** Skip auto-fetch on focus (useful for dependent queries) */
  manual?: boolean;
}

interface UseListDataReturn<T> {
  items: T[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  refetch: () => void;
}

export function useListData<T>(
  fetchFn: () => Promise<ServiceResult<T>>,
  opts?: UseListDataOptions<T>,
): UseListDataReturn<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Latch caller-supplied values in refs so deps stay stable across renders.
  // Callers typically pass inline closures and fresh opts objects — without
  // refs the useCallback deps churn on every render causing an infinite loop.
  const fetchRef = useRef(fetchFn);
  fetchRef.current = fetchFn;
  const mockDataRef = useRef(opts?.mockData);
  mockDataRef.current = opts?.mockData;
  const manualRef = useRef(opts?.manual);
  manualRef.current = opts?.manual;

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (!isRefresh) setLoading(true);
      setError(null);

      const result = await fetchRef.current();

      if (result.error) {
        const msg = typeof result.error === 'object' && result.error !== null && 'message' in result.error
          ? String((result.error as { message: string }).message)
          : 'Failed to load data';
        setError(msg);
        if (mockDataRef.current) setItems(mockDataRef.current);
      } else {
        const data = result.data ?? [];
        setItems(data.length > 0 ? data : (mockDataRef.current ?? []));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unexpected error');
      if (mockDataRef.current) setItems(mockDataRef.current);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!manualRef.current) {
        void load(false);
      }
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load(true);
  }, [load]);

  const refetch = useCallback(() => {
    void load(false);
  }, [load]);

  return { items, loading, refreshing, error, onRefresh, refetch };
}
