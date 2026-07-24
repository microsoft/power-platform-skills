import { createTamagui } from '@tamagui/core';
import { defaultConfig } from '@tamagui/config/v5';
import { animations } from '@tamagui/config/v5-rn';

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME THE COMMENT
// Replace or extend this Tamagui config value only.
const customConfig = {
  ...defaultConfig,
  animations,
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
