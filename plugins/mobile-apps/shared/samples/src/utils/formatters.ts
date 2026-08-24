/**
 * Date & time formatting utilities.
 * Import via `@/utils` — never re-define formatDate inline in screen files.
 */

export function formatDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function formatRelative(iso: string | undefined | null): string {
  if (!iso) return '—';
  try {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diffMs = now - then;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return formatDate(iso);
  } catch {
    return iso;
  }
}

/** Format money from the record's ISO 4217 currency code; never assume a symbol. */
export function formatCurrency(
  amount: number | undefined | null,
  currencyCode: string | undefined | null,
  locale?: string,
): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  const code = String(currencyCode || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  }
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'symbol',
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}
