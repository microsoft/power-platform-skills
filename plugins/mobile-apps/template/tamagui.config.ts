import { createTamagui } from '@tamagui/core';
import { createSystemFont, defaultConfig } from '@tamagui/config/v5';
import { animations } from '@tamagui/config/v5-rn';

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
// Replace or extend this Tamagui config value only.
const monoFont = createSystemFont({
  font: {
    family: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
});

const lightStatusColors = {
  statusOverdueBg: '#FDECEA',
  statusCompleteBg: '#E6F4EA',
  statusInProgressBg: '#E8F0FE',
  statusPendingBg: '#FEF7E0',
  statusDraftBg: '#F1F3F4',
  statusCancelledBg: '#F1F3F4',
  statusOverdue: '#C5221F',
  statusComplete: '#137333',
  statusInProgress: '#1A73E8',
  statusPending: '#B06000',
  statusDraft: '#5F6368',
  statusCancelled: '#5F6368',
} as const;

const darkStatusColors = {
  statusOverdueBg: '#3B1210',
  statusCompleteBg: '#12351F',
  statusInProgressBg: '#102A43',
  statusPendingBg: '#3A2A0A',
  statusDraftBg: '#28282C',
  statusCancelledBg: '#28282C',
  statusOverdue: '#FF8A84',
  statusComplete: '#75D69C',
  statusInProgress: '#8EC8FF',
  statusPending: '#F5C46B',
  statusDraft: '#B4B4BC',
  statusCancelled: '#B4B4BC',
} as const;

type BrandColors = Partial<{
  bg: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  primary: string;
  primaryStrong: string;
  accent: string;
  onPrimary: string;
  statusSuccess: string;
  statusSuccessSoft: string;
  statusWarning: string;
  statusWarningSoft: string;
  statusDanger: string;
  statusDangerSoft: string;
  statusInfo: string;
  statusInfoSoft: string;
}>;

function withSemanticAliases(
  theme: typeof defaultConfig.themes.light,
  statusColors: typeof lightStatusColors | typeof darkStatusColors,
  brand: BrandColors = {},
) {
  return {
    ...theme,
    surface0: brand.bg ?? theme.background,
    surface1: brand.surface ?? theme.color2,
    surface2: brand.surfaceMuted ?? theme.color3,
    surface3: brand.border ?? theme.color4,
    accentDeep: brand.primaryStrong ?? theme.blue8,
    accentBase: brand.primary ?? theme.blue10,
    accentSoft: brand.accent ?? theme.blue3,
    accentOnAccent: brand.onPrimary ?? theme.color1,
    statusComplete: brand.statusSuccess ?? statusColors.statusComplete,
    statusCompleteBg: brand.statusSuccessSoft ?? statusColors.statusCompleteBg,
    statusPending: brand.statusWarning ?? statusColors.statusPending,
    statusPendingBg: brand.statusWarningSoft ?? statusColors.statusPendingBg,
    statusOverdue: brand.statusDanger ?? statusColors.statusOverdue,
    statusOverdueBg: brand.statusDangerSoft ?? statusColors.statusOverdueBg,
    statusInProgress: brand.statusInfo ?? statusColors.statusInProgress,
    statusInProgressBg: brand.statusInfoSoft ?? statusColors.statusInProgressBg,
    statusDraft: statusColors.statusDraft,
    statusDraftBg: statusColors.statusDraftBg,
    statusCancelled: statusColors.statusCancelled,
    statusCancelledBg: statusColors.statusCancelledBg,
  };
}

const themes = {
  ...defaultConfig.themes,
  light: withSemanticAliases(defaultConfig.themes.light, lightStatusColors),
  dark: withSemanticAliases(defaultConfig.themes.dark, darkStatusColors),
};

const customConfig = {
  ...defaultConfig,
  animations,
  fonts: {
    ...defaultConfig.fonts,
    mono: monoFont,
  },
  themes,
};
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME THE COMMENT

/**
 * Tamagui configuration.
 * @tamagui/config/v5 provides a fully-configured design system including
 * tokens, themes (light/dark), fonts, animations, and shorthands.
 */
export const tamaguiConfig = createTamagui(customConfig);
export default tamaguiConfig;

export type Conf = typeof tamaguiConfig;
declare module 'tamagui' {
  interface TamaguiCustomConfig extends Conf {}
}
