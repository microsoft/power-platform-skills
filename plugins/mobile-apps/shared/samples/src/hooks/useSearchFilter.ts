/**
 * useSearchFilter — client-side search + filter for list screens.
 *
 * Usage:
 *   const { query, setQuery, filtered } = useSearchFilter(items, ['name', 'serial']);
 */

import { useState, useMemo } from 'react';

export function useSearchFilter<T>(
  items: T[],
  keys: (keyof T)[],
): {
  query: string;
  setQuery: (q: string) => void;
  filtered: T[];
} {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((item) =>
      keys.some((key) => {
        const val = item[key];
        return typeof val === 'string' && val.toLowerCase().includes(q);
      }),
    );
  }, [items, query, keys]);

  return { query, setQuery, filtered };
}
