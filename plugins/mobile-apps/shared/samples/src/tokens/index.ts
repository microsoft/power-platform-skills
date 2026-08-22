// Shared design tokens. Import via `@/tokens` — never hardcode hex in screen files.

export const gradients = {
  imageScrim: ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0.72)'] as const,
  chartArea: ['rgba(20, 125, 146, 0.32)', 'rgba(20, 125, 146, 0.02)'] as const,
} as const;

export type GradientName = keyof typeof gradients;

export const shadows = {
  sm: { boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)' },
  md: { boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)' },
  lg: { boxShadow: '0 4px 16px rgba(0, 0, 0, 0.12)' },
} as const;
