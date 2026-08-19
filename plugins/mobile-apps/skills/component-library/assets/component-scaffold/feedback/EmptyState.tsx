import type { ReactNode } from 'react';
import { Button, Heading, Text, XStack, YStack } from 'tamagui';

export type EmptyStateProps = {
  actionLabel?: string;
  actions?: ReactNode;
  children?: ReactNode;
  description: string;
  icon?: ReactNode;
  maxWidth?: number;
  minHeight?: number;
  onAction?: () => void;
  onSecondaryAction?: () => void;
  secondaryActionLabel?: string;
  title: string;
};

export function EmptyState({ actionLabel, actions, children, description, icon, maxWidth = 480, minHeight = 220, onAction, onSecondaryAction, secondaryActionLabel, title }: EmptyStateProps) {
  return (
    <YStack items="center" justify="center" gap="$3" minHeight={minHeight} padding="$5">
      {icon}
      <Heading size="$6" textAlign="center">{title}</Heading>
      <Text color="$color10" maxWidth={maxWidth} textAlign="center">{description}</Text>
      {children}
      <XStack flexWrap="wrap" gap="$2" justify="center">
        {actions}
        {actionLabel && onAction ? <Button onPress={onAction}>{actionLabel}</Button> : null}
        {secondaryActionLabel && onSecondaryAction ? <Button chromeless onPress={onSecondaryAction}>{secondaryActionLabel}</Button> : null}
      </XStack>
    </YStack>
  );
}