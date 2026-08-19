import { Text, XStack } from 'tamagui';

export type NumericBadgeProps = {
  accessibilityLabel?: string;
  backgroundColor?: string;
  color?: string;
  max?: number;
  value: number;
};

export function NumericBadge({ accessibilityLabel, backgroundColor = '$backgroundStrong', color = '$color', max = 99, value }: NumericBadgeProps) {
  const boundedValue = Math.max(0, Math.floor(value));
  const label = boundedValue > max ? `${max}+` : String(boundedValue);

  return (
    <XStack accessibilityLabel={accessibilityLabel ?? `${boundedValue} items`} backgroundColor={backgroundColor} minHeight={22} minWidth={22} items="center" justify="center" paddingHorizontal="$2" radius="$10">
      <Text color={color} fontSize="$2" fontWeight="700">{label}</Text>
    </XStack>
  );
}