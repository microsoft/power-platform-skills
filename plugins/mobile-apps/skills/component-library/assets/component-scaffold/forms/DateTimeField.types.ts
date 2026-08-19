export type DateTimeFieldProps = {
  disabled?: boolean;
  error?: string;
  hint?: string;
  id: string;
  label: string;
  maximumDate?: Date;
  minimumDate?: Date;
  mode?: 'date' | 'time' | 'datetime';
  onChange: (value: Date) => void;
  required?: boolean;
  value: Date;
};