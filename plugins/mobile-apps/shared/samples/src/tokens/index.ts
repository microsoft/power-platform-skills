// Shared design tokens. Import via `@/tokens` — never hardcode hex in screen files.

export const gradients = {
  hero:    ['#0078d4', '#0a4f8f'] as const,
  danger:  ['#d23a3a', '#b81e1e'] as const,
  success: ['#107c10', '#054b05'] as const,
  warm:    ['#ca5010', '#8a3500'] as const,
  neutral: ['#323130', '#201f1e'] as const,
} as const;

export type GradientName = keyof typeof gradients;

export const shadows = {
  sm: { boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)' },
  md: { boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)' },
  lg: { boxShadow: '0 4px 16px rgba(0, 0, 0, 0.12)' },
} as const;
