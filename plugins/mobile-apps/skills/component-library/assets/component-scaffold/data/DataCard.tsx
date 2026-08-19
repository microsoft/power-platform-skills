import type { ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { AppImage, type AppImageProps } from '../media/AppImage';

export type DataCardProps = {
  actions?: ReactNode;
  imageAccessibilityLabel?: string;
  imageSource?: AppImageProps['source'];
  metadata?: ReactNode;
  onPress?: () => void;
  subtitle?: string;
  title: string;
};

export function DataCard({ actions, imageAccessibilityLabel, imageSource, metadata, onPress, subtitle, title }: DataCardProps) {
  const content = (
    <YStack gap="$2" padding="$4">
      <Text fontWeight="700" size="$6">{title}</Text>
      {subtitle ? <Text color="$color10">{subtitle}</Text> : null}
      {metadata}
    </YStack>
  );

  return (
    <YStack backgroundColor="$background" borderColor="$borderColor" borderRadius="$4" borderWidth={1} overflow="hidden">
      {imageSource ? (
        <AppImage accessibilityLabel={imageAccessibilityLabel ?? title} source={imageSource} />
      ) : null}
      {onPress ? (
        <Pressable accessibilityLabel={title} accessibilityRole="button" onPress={onPress}>
          {content}
        </Pressable>
      ) : content}
      {actions ? <XStack gap="$2" padding="$4" paddingTop="$0">{actions}</XStack> : null}
    </YStack>
  );
}