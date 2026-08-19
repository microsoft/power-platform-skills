import { Text, TextArea, XStack } from 'tamagui';
import { FormField } from './FormField';

export type TextAreaFieldProps = {
  error?: string;
  id: string;
  label: string;
  maxLength?: number;
  onChangeText: (value: string) => void;
  placeholder?: string;
  value: string;
};

export function TextAreaField({ error, id, label, maxLength, onChangeText, placeholder, value }: TextAreaFieldProps) {
  return (
    <FormField error={error} id={id} label={label}>
      <TextArea id={id} maxLength={maxLength} minHeight={112} onChangeText={onChangeText} placeholder={placeholder} value={value} />
      {maxLength ? <XStack justify="flex-end"><Text color="$color10" size="$2">{value.length}/{maxLength}</Text></XStack> : null}
    </FormField>
  );
}
