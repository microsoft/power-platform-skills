import type { ReactNode } from 'react';
import { Tabs, Text, XStack } from 'tamagui';

export type Segment = {
  badge?: number;
  disabled?: boolean;
  icon?: ReactNode;
  label: string;
  value: string;
};

export type SegmentedControlProps = {
  accessibilityLabel?: string;
  onValueChange: (value: string) => void;
  segments: Segment[];
  value: string;
};

export function SegmentedControl({ accessibilityLabel = 'View selection', onValueChange, segments, value }: SegmentedControlProps) {
  return (
    <Tabs value={value} onValueChange={onValueChange} orientation="horizontal">
      <Tabs.List backgroundColor="$backgroundStrong" borderColor="$borderColor" borderRadius="$4" borderWidth={1} flex={1} padding="$1" aria-label={accessibilityLabel}>
        {segments.map((segment) => (
          <Tabs.Tab
            accessibilityLabel={segment.badge === undefined ? segment.label : `${segment.label}, ${segment.badge}`}
            borderRadius="$3"
            disabled={segment.disabled}
            flex={1}
            key={segment.value}
            value={segment.value}
          >
            <XStack items="center" gap="$2">
              {segment.icon}
              <Text>{segment.label}</Text>
              {segment.badge !== undefined ? <Text color="$color10">{segment.badge}</Text> : null}
            </XStack>
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs>
  );
}
