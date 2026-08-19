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
      <RadioGroup value={value} onValueChange={onValueChange} gap="$2">
        {options.map((option) => {
          const id = `choice-${option.value}`;
          return (
            <XStack key={option.value} minHeight={44} items="center" gap="$3">
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
