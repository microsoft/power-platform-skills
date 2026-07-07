/**
 * Text manipulation utilities.
 * Import via `@/utils`.
 */

export function truncate(str: string | undefined | null, max = 40): string {
  if (!str) return '—';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural ?? singular + 's'}`;
}
