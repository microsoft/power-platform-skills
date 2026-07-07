import { createTamagui } from '@tamagui/core';
import { config } from '@tamagui/config/v3';

/**
 * Tamagui configuration.
 * @tamagui/config/v3 provides a fully-configured design system including
 * tokens, themes (light/dark), fonts, animations, and shorthands.
 */
export const tamaguiConfig = createTamagui(config);
export default tamaguiConfig;

export type Conf = typeof tamaguiConfig;
declare module '@tamagui/core' {
  interface TamaguiCustomConfig extends Conf {}
}
