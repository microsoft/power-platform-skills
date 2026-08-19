import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { XStack } from 'tamagui';
import { FormField } from './FormField';
import type { DateTimeFieldProps } from './DateTimeField.types';

export function DateTimeField({ disabled, error, hint, id, label, maximumDate, minimumDate, mode = 'date', onChange, required, value }: DateTimeFieldProps) {
  const update = (_event: DateTimePickerEvent, next?: Date) => next && onChange(next);
  const pickerProps = { disabled, maximumDate, minimumDate, onChange: update, value };

  return (
    <FormField error={error} hint={hint} id={id} label={label} required={required}>
      {mode === 'datetime' ? (
        <XStack gap="$3"><DateTimePicker {...pickerProps} mode="date" /><DateTimePicker {...pickerProps} mode="time" /></XStack>
      ) : <DateTimePicker {...pickerProps} mode={mode} />}
    </FormField>
  );
}

export type { DateTimeFieldProps } from './DateTimeField.types';