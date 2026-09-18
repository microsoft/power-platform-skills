import { useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from 'tamagui';
import type { PhotoReference, SampleImageAsset } from './model';
import { resolveImagePresentation } from './repositories/prototype-images';
import { getBundledSampleImage } from './sample-images';

export interface PrototypeImageProps {
  photo?: PhotoReference | null;
  alt: string;
  fallback?: string;
  aspectRatio?: number;
  creditDisplay?: 'full' | 'compact';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function PrototypeImage({ photo, alt, fallback, aspectRatio, creditDisplay = 'full', style, testID }: PrototypeImageProps) {
  const presentation = resolveImagePresentation(photo, alt, fallback);
  const bundledSource = getBundledSampleImage(presentation.asset);
  // A new record/source remounts its load state; a late event from an old image
  // must not mark the current photo ready (including during candidate previews).
  return <ImageFrame key={JSON.stringify([photo?.status, photo?.id,
    photo?.status === 'ready' ? photo.sample?.recordId : null, presentation.uri, bundledSource])}
    {...presentation} bundledSource={bundledSource} aspectRatio={aspectRatio}
    creditDisplay={creditDisplay} style={style} testID={testID} />;
}

  function ImageFrame({ uri, asset, alt, fallback, bundledSource, aspectRatio, creditDisplay, style, testID }: {
  uri: string | null;
  asset: SampleImageAsset | null;
  alt: string;
  fallback: string;
  bundledSource?: ImageSourcePropType;
  aspectRatio?: number;
  creditDisplay: 'full' | 'compact';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const theme = useTheme();
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>(uri ? 'loading' : 'failed');
  const [creditError, setCreditError] = useState(false);
  const [creditsExpanded, setCreditsExpanded] = useState(false);
  const openCredit = (url: string) => {
    setCreditError(false);
    void Linking.openURL(url).catch(() => setCreditError(true));
  };
  const loading = state === 'loading';
  const credit = asset?.provenance;
  const frameRatio = typeof aspectRatio === 'number' && Number.isFinite(aspectRatio) && aspectRatio >= 0.1 && aspectRatio <= 10
    ? aspectRatio : asset?.aspectRatio ?? 1.5;
  return <View style={style} testID={testID}>
    <View style={[styles.frame, { aspectRatio: frameRatio, backgroundColor: theme.color2.get() }]}>
      {uri && state !== 'failed' ? <Image
        source={bundledSource ?? { uri }}
        resizeMode={asset?.fit ?? 'cover'}
        style={[styles.image, loading && styles.hidden]}
        accessible={!loading}
        accessibilityRole="image"
        accessibilityLabel={alt}
        importantForAccessibility={loading ? 'no' : 'auto'}
        onLoadStart={() => setState((current) => current === 'failed' ? current : 'loading')}
        onLoad={() => setState((current) => current === 'failed' ? current : 'loaded')}
        onError={() => setState('failed')}
      /> : null}
      {state !== 'loaded' ? <View
        style={styles.fallback}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${alt}. ${loading ? 'Loading image' : fallback}`}
        accessibilityState={{ busy: loading }}
        accessibilityLiveRegion="polite"
      >
        {loading ? <ActivityIndicator accessible={false} color={theme.color12.get()} /> : null}
        <Text style={[styles.fallbackText, { color: theme.color12.get() }]}>{loading ? 'Loading image' : fallback}</Text>
      </View> : null}
    </View>
    {credit && creditDisplay === 'compact' ? <Pressable
      accessibilityRole="button" accessibilityLabel={`Photo credits: ${credit.creator}, ${credit.license}`}
      accessibilityState={{ expanded: creditsExpanded }} onPress={() => setCreditsExpanded(current => !current)}
      style={[styles.creditToggle, { backgroundColor: theme.color2.get() }]}
    >
      <Text style={[styles.creditText, { color: theme.color11.get() }]}>Photo: {credit.creator} · {credit.license}</Text>
      <Text style={[styles.linkText, { color: theme.color11.get() }]}>{creditsExpanded ? 'Hide credits' : 'View credits'}</Text>
    </Pressable> : null}
    {credit && (creditDisplay === 'full' || creditsExpanded) ? <View style={[styles.credits, { backgroundColor: theme.color2.get() }]}>
      <Text style={[styles.creditText, { color: theme.color11.get() }]}>{credit.attribution} · {credit.creator}</Text>
      <Text style={[styles.creditText, { color: theme.color11.get() }]}>{credit.changes}</Text>
      <View style={styles.links}>
        <Pressable accessibilityRole="link" accessibilityLabel={`Image source: ${credit.attribution}`}
          onPress={() => openCredit(credit.sourcePage)} style={styles.link}>
          <Text style={[styles.linkText, { color: theme.color11.get() }]}>Image source</Text>
        </Pressable>
        <Pressable accessibilityRole="link" accessibilityLabel={`Image license: ${credit.license}`}
          onPress={() => openCredit(credit.licenseUrl)} style={styles.link}>
          <Text style={[styles.linkText, { color: theme.color11.get() }]}>{credit.license}</Text>
        </Pressable>
      </View>
      {creditError ? <Text accessibilityRole="alert" style={[styles.creditText, { color: theme.color12.get() }]}>Could not open the image credit link.</Text> : null}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  frame: { position: 'relative', width: '100%', overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  hidden: { opacity: 0 },
  fallback: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 12, gap: 8 },
  fallbackText: { textAlign: 'center' },
  credits: { padding: 8, gap: 4 },
  creditToggle: { minHeight: 48, padding: 8, gap: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' },
  creditText: { fontSize: 12 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  link: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 4 },
  linkText: { fontSize: 12, textDecorationLine: 'underline' },
});
