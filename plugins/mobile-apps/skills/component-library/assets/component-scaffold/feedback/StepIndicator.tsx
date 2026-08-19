import { Text, XStack, YStack } from 'tamagui';

export type IndicatorStep = {
  id: string;
  label: string;
};

export type StepIndicatorProps = {
  currentIndex: number;
  steps: IndicatorStep[];
};

export function StepIndicator({ currentIndex, steps }: StepIndicatorProps) {
  if (steps.length === 0) return null;

  const boundedIndex = Math.max(0, Math.min(steps.length - 1, currentIndex));

  return (
    <XStack
      accessibilityLabel={`Step ${boundedIndex + 1} of ${steps.length}: ${steps[boundedIndex].label}`}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 1, max: steps.length, now: boundedIndex + 1 }}
      items="flex-start"
      width="100%"
    >
      {steps.map((step, index) => {
        const complete = index < boundedIndex;
        const current = index === boundedIndex;

        return (
          <XStack flex={index === steps.length - 1 ? 0 : 1} items="flex-start" key={step.id}>
            <YStack items="center" gap="$2" width={72}>
              <YStack
                backgroundColor={complete || current ? '$color9' : '$backgroundStrong'}
                borderColor={current ? '$color11' : '$borderColor'}
                borderRadius={999}
                borderWidth={current ? 2 : 1}
                height={32}
                items="center"
                justify="center"
                width={32}
              >
                <Text color={complete || current ? '$background' : '$color'} fontWeight="700">{index + 1}</Text>
              </YStack>
              <Text color={current ? '$color' : '$color10'} size="$2" textAlign="center">
                {step.label}
              </Text>
            </YStack>
            {index < steps.length - 1 ? (
              <YStack backgroundColor={complete ? '$color9' : '$borderColor'} flex={1} height={2} marginTop={15} />
            ) : null}
          </XStack>
        );
      })}
    </XStack>
  );
}