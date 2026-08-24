import { createFont, createTamagui } from '@tamagui/core'
import { defaultConfig } from '@tamagui/config/v5'
import { Platform } from 'react-native'

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME
// Replace or extend this Tamagui config value only.
import { animations } from '@tamagui/config/v5-rn'

const systemSansFamily = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  default: 'system-ui',
}) ?? 'system-ui'

const systemBodyFont = createFont({
  family: systemSansFamily,
  size: { 1: 11, 2: 12, 3: 14, 4: 16, 5: 18, 6: 22, 7: 28, 8: 34, 9: 42 },
  lineHeight: { 1: 16, 2: 18, 3: 20, 4: 24, 5: 28, 6: 28, 7: 34, 8: 40, 9: 48 },
  weight: { 4: '400', 5: '500', 6: '600', 7: '700' },
  letterSpacing: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 },
})

const customConfig = {
  ...defaultConfig,
  animations,
  fonts: {
    ...defaultConfig.fonts,
    heading: systemBodyFont,
    body: systemBodyFont,
  },
}
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME

export const tamaguiConfig = createTamagui(customConfig)

export default tamaguiConfig

export type Conf = typeof tamaguiConfig

declare module '@tamagui/core' {
  interface TamaguiCustomConfig extends Conf {}
}
