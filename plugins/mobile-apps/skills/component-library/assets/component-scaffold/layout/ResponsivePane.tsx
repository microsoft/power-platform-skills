import type { ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { XStack, YStack } from 'tamagui';

export type ResponsivePaneProps = {
  breakpoints?: { medium: number; large: number };
  primary: ReactNode;
  secondary?: ReactNode;
  tertiary?: ReactNode;
};

export function ResponsivePane({ breakpoints = { medium: 768, large: 1100 }, primary, secondary, tertiary }: ResponsivePaneProps) {
  const { width } = useWindowDimensions();

  if (!secondary || width < breakpoints.medium) {
    return <YStack flex={1}>{primary}</YStack>;
  }

  return (
    <XStack flex={1} gap="$4">
      <YStack flex={1}>{primary}</YStack>
      <YStack flex={1}>{secondary}</YStack>
      {tertiary && width >= breakpoints.large ? <YStack flex={1}>{tertiary}</YStack> : null}
    </XStack>
  );
}
