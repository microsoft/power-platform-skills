import type { ReactNode } from 'react';
import { Button } from 'tamagui';

export type IconButtonProps = {
  accessibilityLabel: string;
  icon: ReactNode;
  disabled?: boolean;
  onPress: () => void;
  size?: number;
  variant?: 'filled' | 'outlined' | 'ghost';
};

export function IconButton({ accessibilityLabel, icon, disabled, onPress, size = 44, variant = 'ghost' }: IconButtonProps) {
  return (
    <Button
      accessibilityLabel={accessibilityLabel}
      backgroundColor={variant === 'filled' ? '$backgroundStrong' : 'transparent'}
      borderColor="$borderColor"
      borderWidth={variant === 'outlined' ? 1 : 0}
      circular
      disabled={disabled}
      height={size}
      width={size}
      onPress={onPress}
    >
      {icon}
    </Button>
  );
}
