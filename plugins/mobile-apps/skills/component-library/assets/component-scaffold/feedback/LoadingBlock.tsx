import { Spinner, Text, YStack } from 'tamagui';
import { Skeleton } from './Skeleton';

export type LoadingBlockProps = {
  label?: string;
  minHeight?: number;
  variant?: 'spinner' | 'skeleton';
};

export function LoadingBlock({ label = 'Loading', minHeight = 160, variant = 'spinner' }: LoadingBlockProps) {
  if (variant === 'skeleton') {
    return <Skeleton accessibilityLabel={label} height={minHeight} />;
  }

  return (
    <YStack
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      minHeight={minHeight}
      items="center"
      justify="center"
      gap="$3"
    >
      <Spinner size="large" />
      <Text color="$color10">{label}</Text>
    </YStack>
  );
}
