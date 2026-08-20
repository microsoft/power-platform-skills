import type { ReactNode } from 'react';
import { Button, Spinner, XStack } from 'tamagui';

export type AsyncButtonProps = {
  children: string;
  disabled?: boolean;
  icon?: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  onPress: () => void;
};

export function AsyncButton({ children, disabled, icon, loading = false, loadingLabel = 'Working', onPress }: AsyncButtonProps) {
  return (
    <Button
      accessibilityState={{ busy: loading, disabled: disabled || loading }}
      disabled={disabled || loading}
      minHeight={44}
      onPress={onPress}
    >
      <XStack items="center" gap="$2">
        {loading ? <Spinner size="small" /> : icon}
        {loading ? loadingLabel : children}
      </XStack>
    </Button>
  );
}
