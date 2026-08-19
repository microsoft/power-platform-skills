import { Progress, Spinner, Text, XStack, YStack } from 'tamagui';

export type ProgressStateProps = {
  indeterminate?: boolean;
  label: string;
  showPercentage?: boolean;
  value?: number;
};

export function ProgressState({ indeterminate = false, label, showPercentage = false, value = 0 }: ProgressStateProps) {
  const boundedValue = Math.max(0, Math.min(100, value));

  return (
    <YStack gap="$2">
      <XStack justify="space-between" gap="$3">
        <Text>{label}</Text>
        {indeterminate ? <Spinner size="small" /> : showPercentage ? <Text>{Math.round(boundedValue)}%</Text> : null}
      </XStack>
      {!indeterminate ? (
        <Progress accessibilityLabel={label} max={100} value={boundedValue}>
          <Progress.Indicator animation="quick" />
        </Progress>
      ) : null}
    </YStack>
  );
}
