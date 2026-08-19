import { useState } from 'react';
import { Image, type ImageProps, type ImageSource } from 'expo-image';
import { Spinner, Text, YStack } from 'tamagui';

export type AppImageProps = {
  accessibilityLabel: string;
  aspectRatio?: number;
  cachePolicy?: ImageProps['cachePolicy'];
  contentFit?: ImageProps['contentFit'];
  contentPosition?: ImageProps['contentPosition'];
  onLoad?: () => void;
  placeholder?: ImageSource;
  recyclingKey?: string;
  source: ImageSource;
};

export function AppImage({ accessibilityLabel, aspectRatio = 16 / 9, cachePolicy = 'memory-disk', contentFit = 'cover', contentPosition, onLoad, placeholder, recyclingKey, source }: AppImageProps) {
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  if (failed) {
    return (
      <YStack aspectRatio={aspectRatio} backgroundColor="$backgroundStrong" items="center" justify="center" padding="$3">
        <Text color="$color10">Image unavailable</Text>
      </YStack>
    );
  }

  return (
    <YStack aspectRatio={aspectRatio} overflow="hidden">
      <Image
        accessibilityLabel={accessibilityLabel}
        cachePolicy={cachePolicy}
        contentFit={contentFit}
        contentPosition={contentPosition}
        onError={() => { setFailed(true); setLoading(false); }}
        onLoad={() => { setLoading(false); onLoad?.(); }}
        placeholder={placeholder}
        recyclingKey={recyclingKey}
        source={source}
        style={{ height: '100%', width: '100%' }}
        transition={150}
      />
      {loading && !placeholder ? (
        <YStack position="absolute" inset={0} items="center" justify="center">
          <Spinner accessibilityLabel="Loading image" />
        </YStack>
      ) : null}
    </YStack>
  );
}
