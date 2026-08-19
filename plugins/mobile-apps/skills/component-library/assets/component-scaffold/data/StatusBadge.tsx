import type { ReactNode } from 'react';
import { Text, XStack } from 'tamagui';

export type StatusTone = 'info' | 'success' | 'danger' | 'warning' | 'neutral';

export type StatusBadgePalette = Partial<Record<StatusTone, {
  backgroundColor: string;
  color: string;
}>>;

export type StatusBadgeProps = {
  backgroundColor?: string;
  color?: string;
  icon?: ReactNode;
  label: string;
  palette?: StatusBadgePalette;
  size?: 'sm' | 'md';
  tone?: StatusTone;
};

export function StatusBadge({ backgroundColor = '$backgroundStrong', color = '$color', icon, label, palette, size = 'sm', tone = 'info' }: StatusBadgeProps) {
  const toneColors = palette?.[tone];
  return (
    <XStack backgroundColor={toneColors?.backgroundColor ?? backgroundColor} gap="$1" items="center" paddingHorizontal={size === 'sm' ? '$2' : '$3'} paddingVertical="$1" radius="$3">
      {icon}
      <Text color={toneColors?.color ?? color} fontWeight="600" size={size === 'sm' ? '$2' : '$3'}>{label}</Text>
    </XStack>
  );
}
