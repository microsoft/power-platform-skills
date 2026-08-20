import type { ReactNode } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { XStack } from 'tamagui';

export type BottomActionBarProps = {
  align?: 'left' | 'center' | 'right' | 'space-between';
  divider?: boolean;
  gap?: number;
  padding?: number;
  primary: ReactNode;
  secondary?: ReactNode;
};

const alignment = { left: 'flex-start', center: 'center', right: 'flex-end', 'space-between': 'space-between' } as const;

export function BottomActionBar({ align = 'right', divider = true, gap = 8, padding = 12, primary, secondary }: BottomActionBarProps) {
  return (
    <SafeAreaView edges={['bottom']}>
      <XStack
        bg="$background"
        borderTopColor="$borderColor"
        borderTopWidth={divider ? 1 : 0}
        elevation="$2"
        gap={gap}
        p={padding}
        justify={alignment[align]}
      >
        {secondary}
        {primary}
      </XStack>
    </SafeAreaView>
  );
}
