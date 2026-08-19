import type { ChangeEvent, CSSProperties } from 'react';
import { FormField } from './FormField';
import type { DateTimeFieldProps } from './DateTimeField.types';

function formatValue(value: Date, mode: NonNullable<DateTimeFieldProps['mode']>) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const date = `${year}-${month}-${day}`;
  const time = `${hours}:${minutes}`;
  return mode === 'date' ? date : mode === 'time' ? time : `${date}T${time}`;
}

function parseValue(next: string, mode: NonNullable<DateTimeFieldProps['mode']>, current: Date) {
  if (mode === 'time') {
    const [hours, minutes] = next.split(':').map(Number);
    return new Date(current.getFullYear(), current.getMonth(), current.getDate(), hours, minutes);
  }
  const [date, time = '00:00'] = next.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes);
}

const inputStyle: CSSProperties = {
  background: 'transparent',
  border: '1px solid currentColor',
  borderRadius: 8,
  boxSizing: 'border-box',
  color: 'inherit',
  font: 'inherit',
  minHeight: 44,
  padding: '8px 12px',
  width: '100%',
};

export function DateTimeField({ disabled, error, hint, id, label, maximumDate, minimumDate, mode = 'date', onChange, required, value }: DateTimeFieldProps) {
  const update = (event: ChangeEvent<HTMLInputElement>) => {
    if (!event.target.value) return;
    const parsed = parseValue(event.target.value, mode, value);
    const inRange = (!minimumDate || parsed >= minimumDate) && (!maximumDate || parsed <= maximumDate);
    if (!Number.isNaN(parsed.getTime()) && inRange) onChange(parsed);
  };

  return (
    <FormField error={error} hint={hint} id={id} label={label} required={required}>
      <input
        disabled={disabled}
        id={id}
        max={maximumDate ? formatValue(maximumDate, mode) : undefined}
        min={minimumDate ? formatValue(minimumDate, mode) : undefined}
        onChange={update}
        required={required}
        style={inputStyle}
        type={mode === 'datetime' ? 'datetime-local' : mode}
        value={formatValue(value, mode)}
      />
    </FormField>
  );
}

export type { DateTimeFieldProps } from './DateTimeField.types';
