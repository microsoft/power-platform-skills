import type { ReactNode } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

export type BannerSeverity = 'info' | 'success' | 'warning' | 'error';

export type InlineBannerProps = {
  action?: ReactNode;
  icon?: ReactNode;
  message: string;
  onDismiss?: () => void;
  severity?: BannerSeverity;
  title?: string;
};

export function InlineBanner({ action, icon, message, onDismiss, severity = 'info', title }: InlineBannerProps) {
  const assertive = severity === 'error';

  return (
    <XStack
      accessibilityRole="alert"
      accessibilityLiveRegion={assertive ? 'assertive' : 'polite'}
      aria-live={assertive ? 'assertive' : 'polite'}
      backgroundColor="$backgroundStrong"
      borderColor="$borderColor"
      borderWidth={1}
      gap="$3"
      padding="$3"
      radius="$4"
      items="center"
    >
      {icon}
      <YStack flex={1} gap="$1">
        {title ? <Text fontWeight="700">{title}</Text> : null}
        <Text>{message}</Text>
      </YStack>
      {action}
      {onDismiss ? <Button chromeless onPress={onDismiss}>Close</Button> : null}
    </XStack>
  );
}
