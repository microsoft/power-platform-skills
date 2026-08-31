import { createTamagui } from '@tamagui/core';
import { defaultConfig } from '@tamagui/config/v5';
import { animations } from '@tamagui/config/v5-rn';

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
export type BrandColors = Partial<{
  bg: string;
  surface: string;
  primary: string;
  accent: string;
  border: string;
  text: string;
  textMuted: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
  statusInfo: string;
}>;

/**
 * Stable semantic aliases used by the template and generated screens.
 * Design-system integration may refine values, but it must preserve these names.
 */
export function withSemanticAliases(
  theme: typeof defaultConfig.themes.light,
  brand: BrandColors = {},
) {
  return {
    ...theme,
    surface0: brand.bg ?? theme.background,
    surface1: brand.surface ?? theme.color2,
    surface2: theme.color3,
    surface3: brand.border ?? theme.color4,
    mediaSurface: theme.color3,
    accentDeep: brand.primary ?? theme.blue11,
    accentBase: brand.primary ?? theme.blue10,
    accentSoft: brand.accent ?? theme.blue3,
    accentOnAccent: theme.color1,
    text0: brand.text ?? theme.color12,
    text1: brand.textMuted ?? theme.color11,
    text2: theme.color10,
    text3: theme.color9,
    statusComplete: brand.statusSuccess ?? theme.green11,
    statusCompleteBg: theme.green3,
    statusPending: brand.statusWarning ?? theme.yellow11,
    statusPendingBg: theme.yellow3,
    statusOverdue: brand.statusDanger ?? theme.red11,
    statusOverdueBg: theme.red3,
    statusInProgress: brand.statusInfo ?? theme.blue11,
    statusInProgressBg: theme.blue3,
    statusDraft: theme.color10,
    statusDraftBg: theme.color3,
    statusCancelled: theme.red11,
    statusCancelledBg: theme.red3,
  };
}

const themes = {
  ...defaultConfig.themes,
  light: withSemanticAliases(defaultConfig.themes.light),
  dark: withSemanticAliases(defaultConfig.themes.dark),
};

const fonts = {
  ...defaultConfig.fonts,
  // The baseline template has no separate monospace asset. Keep the semantic
  // role valid until design-system supplies an approved runtime font family.
  mono: defaultConfig.fonts.body,
};

const customConfig = {
  ...defaultConfig,
  animations,
  themes,
  fonts,
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
declare module '@tamagui/core' {
  interface TamaguiCustomConfig extends Conf {}
}
