import { Slider, Text, XStack, YStack } from 'tamagui';

export type RangeSliderProps = {
  disabled?: boolean;
  label: string;
  maximum?: number;
  minimum?: number;
  onValueChange: (value: [number, number]) => void;
  step?: number;
  value: [number, number];
};

export function RangeSlider({ disabled, label, maximum = 100, minimum = 0, onValueChange, step = 1, value }: RangeSliderProps) {
  return (
    <YStack gap="$2">
      <XStack justify="space-between" gap="$3">
        <Text>{label}</Text>
        <Text color="$color10">{value[0]} - {value[1]}</Text>
      </XStack>
      <Slider
        accessibilityLabel={label}
        disabled={disabled}
        max={maximum}
        min={minimum}
        onValueChange={(nextValue) => onValueChange([nextValue[0], nextValue[1]])}
        step={step}
        value={value}
      >
        <Slider.Track><Slider.TrackActive /></Slider.Track>
        <Slider.Thumb circular index={0} size="$2" />
        <Slider.Thumb circular index={1} size="$2" />
      </Slider>
    </YStack>
  );
}