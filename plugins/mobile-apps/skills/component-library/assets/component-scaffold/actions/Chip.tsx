import type { ReactNode } from 'react';
import { Button, XStack } from 'tamagui';

export type ChipProps = {
  backgroundColor?: string;
  borderColor?: string;
  disabled?: boolean;
  icon?: ReactNode;
  label: string;
  onPress?: () => void;
  selected?: boolean;
  selectedBackgroundColor?: string;
  trailing?: ReactNode;
};

export function Chip({ backgroundColor = '$background', borderColor = '$borderColor', disabled, icon, label, onPress, selected = false, selectedBackgroundColor = '$backgroundStrong', trailing }: ChipProps) {
  return (
    <Button
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled }}
      backgroundColor={selected ? selectedBackgroundColor : backgroundColor}
      borderColor={borderColor}
      borderWidth={1}
      disabled={disabled}
      minHeight={36}
      onPress={onPress}
      paddingHorizontal="$3"
      radius="$10"
    >
      <XStack items="center" gap="$2">{icon}{label}{trailing}</XStack>
    </Button>
  );
}