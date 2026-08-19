import { useRef, useState, type ReactNode } from 'react';
import { type NativeScrollEvent, type NativeSyntheticEvent, ScrollView } from 'react-native';
import { Button, Text, XStack, YStack } from 'tamagui';

export type ContentCarouselProps<Item> = {
  accessibilityLabel: string;
  data: readonly Item[];
  gap?: number;
  itemWidth: number;
  keyExtractor: (item: Item, index: number) => string;
  renderItem: (item: Item, index: number) => ReactNode;
};

export function ContentCarousel<Item>({ accessibilityLabel, data, gap = 12, itemWidth, keyExtractor, renderItem }: ContentCarouselProps<Item>) {
  const scrollRef = useRef<ScrollView>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const interval = itemWidth + gap;

  const moveTo = (index: number) => {
    const nextIndex = Math.max(0, Math.min(data.length - 1, index));
    scrollRef.current?.scrollTo({ animated: true, x: nextIndex * interval });
    setActiveIndex(nextIndex);
  };

  const handleScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setActiveIndex(Math.max(0, Math.min(data.length - 1, Math.round(event.nativeEvent.contentOffset.x / interval))));
  };

  if (data.length === 0) return null;

  return (
    <YStack accessibilityLabel={accessibilityLabel} gap="$3">
      <ScrollView
        contentContainerStyle={{ columnGap: gap }}
        decelerationRate="fast"
        horizontal
        onMomentumScrollEnd={handleScrollEnd}
        ref={scrollRef}
        showsHorizontalScrollIndicator={false}
        snapToInterval={interval}
      >
        {data.map((item, index) => (
          <YStack key={keyExtractor(item, index)} width={itemWidth}>
            {renderItem(item, index)}
          </YStack>
        ))}
      </ScrollView>
      <XStack items="center" justify="space-between">
        <Button disabled={activeIndex === 0} minHeight={44} onPress={() => moveTo(activeIndex - 1)}>Previous</Button>
        <YStack items="center" gap="$1">
          {data.length <= 7 ? (
            <XStack accessible={false} gap="$1.5" items="center">
              {data.map((item, index) => (
                <YStack
                  backgroundColor={index === activeIndex ? '$color9' : '$borderColor'}
                  borderRadius={999}
                  height={8}
                  key={keyExtractor(item, index)}
                  width={8}
                />
              ))}
            </XStack>
          ) : null}
          <Text>{activeIndex + 1} of {data.length}</Text>
        </YStack>
        <Button disabled={activeIndex === data.length - 1} minHeight={44} onPress={() => moveTo(activeIndex + 1)}>Next</Button>
      </XStack>
    </YStack>
  );
}