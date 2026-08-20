import type { ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

export type RecordRowProps = {
  leading?: ReactNode;
  metadata?: string;
  onLongPress?: () => void;
  onPress?: () => void;
  subtitle?: string;
  title: string;
  trailing?: ReactNode;
};

export function RecordRow({ leading, metadata, onLongPress, onPress, subtitle, title, trailing }: RecordRowProps) {
  return (
    <Pressable accessibilityRole={onPress || onLongPress ? 'button' : undefined} onLongPress={onLongPress} onPress={onPress}>
      <XStack backgroundColor="$background" borderColor="$borderColor" borderRadius="$4" borderWidth={1} minHeight={56} items="center" gap="$3" paddingHorizontal="$3" paddingVertical="$2">
        {leading}
        <YStack flex={1} gap="$1">
          <Text fontWeight="600">{title}</Text>
          {subtitle ? <Text color="$color10">{subtitle}</Text> : null}
          {metadata ? <Text color="$color9" size="$2">{metadata}</Text> : null}
        </YStack>
        {trailing}
      </XStack>
    </Pressable>
  );
}
