import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Label, Text, YStack } from 'tamagui';

export type FormFieldProps = {
  children: ReactNode;
  error?: string;
  hint?: string;
  id: string;
  label: string;
  required?: boolean;
};

export function FormField({ children, error, hint, id, label, required }: FormFieldProps) {
  const message = error ?? hint;
  const messageId = `${id}-${error ? 'error' : 'hint'}`;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        'aria-describedby': message ? messageId : undefined,
        accessibilityHint: message,
      })
    : children;

  return (
    <YStack gap="$2">
      <Label htmlFor={id}>
        {label}{required ? ' *' : ''}
      </Label>
      {control}
      {message ? (
        <Text
          accessibilityRole={error ? 'alert' : undefined}
          color={error ? '$red10' : '$color10'}
          id={messageId}
          size="$2"
        >
          {message}
        </Text>
      ) : null}
    </YStack>
  );
}
