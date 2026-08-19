import type { ReactNode } from 'react';
import { Input, XStack } from 'tamagui';
import { FormField } from './FormField';

export type TextFieldProps = {
  error?: string;
  hint?: string;
  id: string;
  inputMode?: 'decimal' | 'email' | 'numeric' | 'search' | 'tel' | 'text' | 'url';
  label: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  prefix?: ReactNode;
  required?: boolean;
  suffix?: ReactNode;
  value: string;
};

export function TextField({
  error,
  hint,
  id,
  inputMode,
  label,
  onChangeText,
  placeholder,
  prefix,
  required,
  suffix,
  value,
}: TextFieldProps) {
  return (
    <FormField error={error} hint={hint} id={id} label={label} required={required}>
      <XStack borderColor="$borderColor" borderWidth={1} items="center" paddingHorizontal={prefix || suffix ? '$3' : 0} radius="$4">
        {prefix}
        <Input
          aria-invalid={Boolean(error)}
          borderWidth={prefix || suffix ? 0 : 1}
          flex={1}
          id={id}
          inputMode={inputMode}
          minHeight={44}
          onChangeText={onChangeText}
          placeholder={placeholder}
          value={value}
        />
        {suffix}
      </XStack>
    </FormField>
  );
}
