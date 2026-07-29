import { createTamagui } from '@tamagui/core'
import { defaultConfig } from '@tamagui/config/v5'

// CUSTOMIZATION START - DO NOT REMOVE OR RENAME
// Replace or extend this Tamagui config value only.
import { animations } from '@tamagui/config/v5-rn'

const customConfig = {
  ...defaultConfig,
  animations,
}
// CUSTOMIZATION END - DO NOT REMOVE OR RENAME

export const tamaguiConfig = createTamagui(customConfig)

export default tamaguiConfig

export type Conf = typeof tamaguiConfig

declare module '@tamagui/core' {
  interface TamaguiCustomConfig extends Conf {}
}
