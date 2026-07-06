/**
 * Dataverse choice-column helpers.
 * Import via `@/utils`.
 */

export type ChoiceMap<T extends number | string = number> = Record<T, string>;

/**
 * Resolve a Dataverse choice column value to its display label.
 * Returns '—' for null/undefined values.
 */
export function choiceLabel<T extends number | string>(
  value: T | undefined | null,
  map: ChoiceMap<T>,
): string {
  if (value == null) return '—';
  return map[value] ?? '—';
}

/**
 * Standard tone tokens for status-based UI (pills, badges, dots).
 *
 * Uses Tamagui's semantic color tokens (3 = subtle bg, 11 = readable fg) which
 * auto-invert in dark mode and meet WCAG AA contrast (≥4.5:1) by construction.
 *
 * Why tokens, not raw hex / rgba: rgba(...,0.10) backgrounds blend with whatever's
 * behind them — fg/bg contrast collapses in dark mode, and the chip can become
 * invisible when bg is a similar tint. The $blue3/$blue11 pair (and equivalents)
 * is Tamagui's tested high-contrast pairing across light + dark.
 *
 * Use with StatusPill or inline styling. Pass these strings directly to Tamagui
 * `bg=` / `col=` props — they resolve to the active theme's color.
 */
export const STATUS_TONES = {
  info:    { bg: '$blue3',   fg: '$blue11'   },
  success: { bg: '$green3',  fg: '$green11'  },
  danger:  { bg: '$red3',    fg: '$red11'    },
  warning: { bg: '$orange3', fg: '$orange11' },
  neutral: { bg: '$color3',  fg: '$color11'  },
} as const;

export type StatusTone = keyof typeof STATUS_TONES;
