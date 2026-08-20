import type { ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Button, Card, Text, XStack, YStack } from 'tamagui';
import { AppImage, type AppImageProps } from '../media/AppImage';

export type DataCardAction = {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
};

export type DataCardProps = {
  actions?: ReactNode;
  icon?: ReactNode;
  imageAccessibilityLabel?: string;
  imageSource?: AppImageProps['source'];
  metadata?: ReactNode;
  onPress?: () => void;
  primaryAction?: DataCardAction;
  secondaryAction?: DataCardAction;
  subtitle?: string;
  title: string;
};

export function DataCard({ actions, icon, imageAccessibilityLabel, imageSource, metadata, onPress, primaryAction, secondaryAction, subtitle, title }: DataCardProps) {
  const content = (
    <XStack gap="$2" items="flex-start" p="$3">
      {icon}
      <YStack flex={1} gap="$1.5">
        <Text fontSize="$6" fontWeight="700">{title}</Text>
        {subtitle ? <Text color="$color10">{subtitle}</Text> : null}
        {metadata}
      </YStack>
    </XStack>
  );

  return (
    <Card bg="$background" borderColor="$borderColor" borderWidth={1} elevation="$1" overflow="hidden" rounded="$4">
      {imageSource ? (
        <AppImage accessibilityLabel={imageAccessibilityLabel ?? title} source={imageSource} />
      ) : null}
      {onPress ? (
        <Pressable accessibilityLabel={title} accessibilityRole="button" onPress={onPress}>
          {content}
        </Pressable>
      ) : content}
      {actions || primaryAction || secondaryAction ? (
        <XStack bg="$backgroundHover" borderTopColor="$borderColor" borderTopWidth={1} gap="$2" p="$3">
          {actions}
          {secondaryAction ? (
            <Button accessibilityLabel={secondaryAction.accessibilityLabel} chromeless disabled={secondaryAction.disabled} onPress={secondaryAction.onPress}>
              {secondaryAction.label}
            </Button>
          ) : null}
          {primaryAction ? (
            <Button accessibilityLabel={primaryAction.accessibilityLabel} disabled={primaryAction.disabled} onPress={primaryAction.onPress}>
              {primaryAction.label}
            </Button>
          ) : null}
        </XStack>
      ) : null}
    </Card>
  );
}