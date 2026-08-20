import type { ReactNode } from 'react';
import { Heading, Text, XStack, YStack } from 'tamagui';

export type AppHeaderProps = {
  actions?: ReactNode;
  divider?: boolean;
  leading?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  subtitle?: string;
  title: string;
};

const headingSizes = { sm: '$5', md: '$7', lg: '$9' } as const;

export function AppHeader({ actions, divider = false, leading, size = 'md', subtitle, title }: AppHeaderProps) {
  return (
    <XStack borderBottomColor="$borderColor" borderBottomWidth={divider ? 1 : 0} minHeight={48} items="center" gap="$2" paddingBottom={divider ? '$2' : 0}>
      {leading}
      <YStack flex={1} gap="$1">
        <Heading size={headingSizes[size]}>{title}</Heading>
        {subtitle ? <Text color="$color10">{subtitle}</Text> : null}
      </YStack>
      {actions ? <XStack items="center" gap="$2">{actions}</XStack> : null}
    </XStack>
  );
}
