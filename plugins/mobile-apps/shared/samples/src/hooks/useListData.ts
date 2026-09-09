/**
 * useListData — eliminates the load/refresh/error boilerplate from every list screen.
 *
 * Usage:
 *   const { items, loading, refreshing, error, onRefresh, refetch } = useListData(
 *     () => CategoryService.getAll({ orderBy: ['name asc'], top: 50 }),
 *     { source: 'live' }
 *   );
 *   // Preview only: { source: 'fixture', mockData: MOCK_CATEGORIES }.
 *   // Label fixture data visibly; it is never a fallback for a live response.
 *
 * For unbounded Dataverse tables such as inspections, visits, work orders, or
 * tickets, use `useCursorListData` instead.
 */

import { useState, useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

interface ServiceResult<T> {
  /** Generated services expose success; plain app-owned adapters may omit it. */
  success?: boolean;
  data?: T[] | null;
  error?: { message?: string } | unknown;
}

interface UseListDataOptions<T> {
  /** Explicit preview/demo mode; live is the default even when mockData is supplied. */
  source?: 'live' | 'fixture';
  /** Used only with source: 'fixture'; the live service is not called in that mode. */
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
  const sourceRef = useRef(opts?.source ?? 'live');
  sourceRef.current = opts?.source ?? 'live';
  const itemsSourceRef = useRef(sourceRef.current);
  const loadVersionRef = useRef(0);

  const load = useCallback(async (isRefresh = false) => {
    const version = ++loadVersionRef.current;
    const source = sourceRef.current;
    try {
      if (!isRefresh) setLoading(true);
      setError(null);
      if (itemsSourceRef.current !== source) setItems([]);
      itemsSourceRef.current = source;

      if (source === 'fixture') {
        setItems(mockDataRef.current ?? []);
        return;
      }

      const result = await fetchRef.current();
      if (version !== loadVersionRef.current || source !== sourceRef.current) return;
      if (result.success === false || result.error) {
        throw new Error('Failed to load data');
      }
      setItems(result.data ?? []);
    } catch (e) {
      if (version !== loadVersionRef.current || source !== sourceRef.current) return;
      console.error('[useListData] load failed', e);
      setError("Couldn't load the list. Try again.");
    } finally {
      if (version === loadVersionRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [opts?.source]);

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

  return {
    items: itemsSourceRef.current === sourceRef.current ? items : [],
    loading, refreshing, error, onRefresh, refetch,
  };
}
