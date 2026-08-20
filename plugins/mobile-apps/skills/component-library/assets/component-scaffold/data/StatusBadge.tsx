import type { ComponentProps, ReactNode } from 'react';
import { Text, XStack } from 'tamagui';

export type StatusTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

type BadgeBackgroundColor = NonNullable<ComponentProps<typeof XStack>['bg']>;
type BadgeTextColor = NonNullable<ComponentProps<typeof Text>['color']>;

export type StatusBadgePalette = Partial<Record<StatusTone, {
  backgroundColor: BadgeBackgroundColor;
  color: BadgeTextColor;
}>>;

const defaultStatusPalette = {
  info: { backgroundColor: '$blue3', color: '$blue11' },
  success: { backgroundColor: '$green3', color: '$green11' },
  warning: { backgroundColor: '$yellow3', color: '$yellow11' },
  danger: { backgroundColor: '$red3', color: '$red11' },
  neutral: { backgroundColor: '$gray3', color: '$gray11' },
} satisfies Required<StatusBadgePalette>;

export type StatusBadgeProps = {
  backgroundColor?: BadgeBackgroundColor;
  color?: BadgeTextColor;
  icon?: ReactNode;
  label: string;
  palette?: StatusBadgePalette;
  size?: 'sm' | 'md';
  tone?: StatusTone;
};

export function StatusBadge({ backgroundColor = '$background', color = '$color', icon, label, palette, size = 'sm', tone = 'info' }: StatusBadgeProps) {
  const toneColors = palette?.[tone] ?? defaultStatusPalette[tone];
  const horizontalPadding: ComponentProps<typeof XStack>['px'] = size === 'sm' ? '$2' : '$3';
  const textSize: ComponentProps<typeof Text>['fontSize'] = size === 'sm' ? '$2' : '$3';

  return (
    <XStack bg={toneColors?.backgroundColor ?? backgroundColor} gap="$1" items="center" px={horizontalPadding} py="$1" rounded="$10">
      {icon}
      <Text color={toneColors?.color ?? color} fontSize={textSize} fontWeight="600">{label}</Text>
    </XStack>
  );
}
