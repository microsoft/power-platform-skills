import { Label, Switch, Text, XStack, YStack } from 'tamagui';

export type ToggleFieldProps = {
  checked: boolean;
  description?: string;
  id: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
  size?: '$2' | '$3' | '$4';
};

export function ToggleField({ checked, description, id, label, onCheckedChange, size = '$3' }: ToggleFieldProps) {
  return (
    <XStack minHeight={44} items="center" justify="space-between" gap="$3">
      <YStack flex={1}>
        <Label htmlFor={id}>{label}</Label>
        {description ? <Text color="$color10" size="$2">{description}</Text> : null}
      </YStack>
      <Switch checked={checked} id={id} onCheckedChange={onCheckedChange} size={size}>
        <Switch.Thumb animation="quick" />
      </Switch>
    </XStack>
  );
}
