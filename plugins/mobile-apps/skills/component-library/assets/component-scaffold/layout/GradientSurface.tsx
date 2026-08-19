import type { ComponentProps, ReactNode } from 'react';
import { LinearGradient, type LinearGradientProps } from 'expo-linear-gradient';
import { YStack } from 'tamagui';

export type GradientDirection = 'diagonal' | 'horizontal' | 'vertical';

export type GradientSurfaceProps = {
  children: ReactNode;
  colors: LinearGradientProps['colors'];
  direction?: GradientDirection;
  locations?: LinearGradientProps['locations'];
  minHeight?: number;
  padding?: ComponentProps<typeof YStack>['p'];
  radius?: number;
};

const directionPoints = {
  diagonal: { end: { x: 1, y: 1 }, start: { x: 0, y: 0 } },
  horizontal: { end: { x: 1, y: 0 }, start: { x: 0, y: 0 } },
  vertical: { end: { x: 0, y: 1 }, start: { x: 0, y: 0 } },
} as const;

export function GradientSurface({ children, colors, direction = 'vertical', locations, minHeight, padding = '$4', radius = 0 }: GradientSurfaceProps) {
  const points = directionPoints[direction];

  return (
    <LinearGradient
      colors={colors}
      end={points.end}
      locations={locations}
      start={points.start}
      style={{ borderRadius: radius, minHeight, overflow: 'hidden' }}
    >
      <YStack flex={1} p={padding}>{children}</YStack>
    </LinearGradient>
  );
}