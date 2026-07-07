import { defaultConfig } from '@tamagui/config/v4'
import { createTamagui } from 'tamagui'

// Start from the v4 default. Customize by extending — see
// shared/references/tamagui-custom-tokens.md for how.
export const tamaguiConfig = createTamagui(defaultConfig)

export default tamaguiConfig

export type Conf = typeof tamaguiConfig

declare module 'tamagui' {
  interface TamaguiCustomConfig extends Conf {}
}
