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
  sm: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2,  elevation: 1 },
  md: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8,  elevation: 3 },
  lg: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 6 },
} as const;
