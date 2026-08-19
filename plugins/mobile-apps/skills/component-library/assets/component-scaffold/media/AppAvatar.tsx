import type { ReactNode } from 'react';
import { Avatar, Text, YStack } from 'tamagui';

export type AppAvatarProps = {
  accessibilityLabel: string;
  badge?: ReactNode;
  fallback: string;
  source?: string;
  size?: '$3' | '$4' | '$5' | '$6' | '$7';
};

export function AppAvatar({ accessibilityLabel, badge, fallback, size = '$5', source }: AppAvatarProps) {
  return (
    <YStack position="relative">
      <Avatar circular size={size}>
        {source ? <Avatar.Image accessibilityLabel={accessibilityLabel} src={source} /> : null}
        <Avatar.Fallback items="center" justify="center">
          <Text fontWeight="600">{fallback}</Text>
        </Avatar.Fallback>
      </Avatar>
      {badge ? <YStack bottom={-2} position="absolute" right={-2}>{badge}</YStack> : null}
    </YStack>
  );
}
