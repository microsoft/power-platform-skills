import { YStack } from 'tamagui';

export type SkeletonProps = {
  accessibilityLabel?: string;
  height?: number;
  radius?: number;
  width?: number | `${number}%`;
};

export function Skeleton({ accessibilityLabel = 'Loading content', height = 20, radius = 6, width = '100%' }: SkeletonProps) {
  return (
    <YStack
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="progressbar"
      animation="quick"
      backgroundColor="$backgroundStrong"
      height={height}
      opacity={0.7}
      radius={radius}
      width={width}
    />
  );
}