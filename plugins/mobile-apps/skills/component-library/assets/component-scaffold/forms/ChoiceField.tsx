import type { ReactNode } from 'react';
import { Label, RadioGroup, Text, XStack, YStack } from 'tamagui';

export type Choice = { content?: ReactNode; description?: string; disabled?: boolean; label: string; value: string };

export type ChoiceFieldProps = {
  label: string;
  onValueChange: (value: string) => void;
  options: Choice[];
  value: string;
};

export function ChoiceField({ label, onValueChange, options, value }: ChoiceFieldProps) {
  return (
    <YStack gap="$2">
      <Label>{label}</Label>
      <RadioGroup backgroundColor="$background" borderColor="$borderColor" borderRadius="$4" borderWidth={1} overflow="hidden" value={value} onValueChange={onValueChange}>
        {options.map((option, optionIndex) => {
          const id = `choice-${option.value}`;
          return (
            <XStack
              borderBottomColor="$borderColor"
              borderBottomWidth={optionIndex < options.length - 1 ? 1 : 0}
              key={option.value}
              minHeight={48}
              items="center"
              gap="$3"
              paddingHorizontal="$3"
              paddingVertical="$2"
            >
              <RadioGroup.Item disabled={option.disabled} id={id} value={option.value}><RadioGroup.Indicator /></RadioGroup.Item>
              <YStack flex={1} opacity={option.disabled ? 0.5 : 1}>
                <Label htmlFor={id}>{option.label}</Label>
                {option.description ? <Text color="$color10" size="$2">{option.description}</Text> : null}
                {option.content}
              </YStack>
            </XStack>
          );
        })}
      </RadioGroup>
    </YStack>
  );
}
