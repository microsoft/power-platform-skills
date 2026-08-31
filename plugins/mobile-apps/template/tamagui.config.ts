import { createTamagui } from '@tamagui/core';
import { defaultConfig } from '@tamagui/config/v5';
import { animations } from '@tamagui/config/v5-rn';

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
export type BrandColors = Partial<{
  bg: string;
  surface: string;
  primary: string;
  onPrimary: string;
  accent: string;
  border: string;
  text: string;
  textMuted: string;
  statusSuccess: string;
  statusWarning: string;
  statusDanger: string;
  statusInfo: string;
}>;

function parseColorChannels(color: string) {
  const hexMatch = color.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1].length === 3
      ? [...hexMatch[1]].map((value) => `${value}${value}`).join('')
      : hexMatch[1];
    return [0, 2, 4].map((offset) => (
      Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    ));
  }

  const rgbMatch = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgbMatch) {
    const values = rgbMatch.slice(1, 4).map(Number);
    if (values.some((value) => value < 0 || value > 255)) return null;
    if (rgbMatch[4] !== undefined && Number(rgbMatch[4]) !== 1) return null;
    return values.map((value) => value / 255);
  }

  const hslMatch = color.match(/^hsla?\(\s*([-\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!hslMatch) return null;
  if (hslMatch[4] !== undefined && Number(hslMatch[4]) !== 1) return null;
  const hue = ((Number(hslMatch[1]) % 360) + 360) % 360;
  const saturation = Number(hslMatch[2]) / 100;
  const lightness = Number(hslMatch[3]) / 100;
  if (saturation < 0 || saturation > 1 || lightness < 0 || lightness > 1) return null;
  const chroma = (1 - Math.abs((2 * lightness) - 1)) * saturation;
  const intermediate = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = lightness - (chroma / 2);
  const segment = Math.floor(hue / 60);
  const rgb = [
    [chroma, intermediate, 0],
    [intermediate, chroma, 0],
    [0, chroma, intermediate],
    [0, intermediate, chroma],
    [intermediate, 0, chroma],
    [chroma, 0, intermediate],
  ][segment];
  return rgb.map((value) => value + offset);
}

function readableForeground(background: string | undefined, fallback: string) {
  if (!background) return fallback;
  const channels = parseColorChannels(background);
  if (!channels) return fallback;
  const linearChannels = channels.map((value) => {
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = (0.2126 * linearChannels[0])
    + (0.7152 * linearChannels[1])
    + (0.0722 * linearChannels[2]);
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

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
    surface1: brand.surface ?? theme.color3,
    surface2: theme.color4,
    surface3: brand.border ?? theme.color5,
    mediaSurface: theme.color4,
    accentDeep: brand.primary ?? theme.blue11,
    accentBase: brand.primary ?? theme.blue10,
    accentSoft: brand.accent ?? theme.blue3,
    accentOnAccent: brand.onPrimary
      ?? readableForeground(brand.primary ?? theme.blue10, theme.color1),
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
