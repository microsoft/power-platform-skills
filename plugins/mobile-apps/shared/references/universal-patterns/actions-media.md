# Action and Media Patterns

## 28. Swipe-to-Act List Rows (iOS Mail style)

Used for: any list where quick actions (delete, archive, snooze) need to be fast.

```tsx
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import Animated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from 'react-native-reanimated'

function SwipeRow({ item, onDelete, onArchive }) {
  const translateX = useSharedValue(0)
  const ROW_HEIGHT = 72
  const DELETE_THRESHOLD = -120
  const ARCHIVE_THRESHOLD = 80

  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onUpdate((e) => {
      translateX.value = Math.max(-160, Math.min(80, e.translationX))
    })
    .onEnd(() => {
      if (translateX.value < DELETE_THRESHOLD) {
        translateX.value = withSpring(-500, { damping: 20 }, () => runOnJS(onDelete)(item.id))
      } else if (translateX.value > ARCHIVE_THRESHOLD) {
        translateX.value = withSpring(500, { damping: 20 }, () => runOnJS(onArchive)(item.id))
      } else {
        translateX.value = withSpring(0, { damping: 20 })
      }
    })

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }))

  const deleteOpacity = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.abs(translateX.value) / 80),
  }))

  return (
    <YStack height={ROW_HEIGHT} overflow="hidden">
      {/* Background actions */}
      <XStack position="absolute" inset={0} items="center" justify="space-between" px="$4">
        <Animated.View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, deleteOpacity]}>
          <Archive size={20} color="$green10" />
          <Text color="$green10" fontWeight="600" fontSize="$2">Archive</Text>
        </Animated.View>
        <Animated.View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, deleteOpacity]}>
          <Text color="$red10" fontWeight="600" fontSize="$2">Delete</Text>
          <Trash2 size={20} color="$red10" />
        </Animated.View>
      </XStack>

      {/* Foreground row */}
      <GestureDetector gesture={panGesture}>
        <Animated.View style={rowStyle}>
          <XStack height={ROW_HEIGHT} bg="$background" items="center" px="$4" gap="$3"
            borderBottomWidth={1} borderBottomColor="$borderColor">
            {/* Row content */}
            <YStack flex={1}>
              <Text fontWeight="600">{item.title}</Text>
              <Text fontSize="$2" color="$color9" numberOfLines={1}>{item.subtitle}</Text>
            </YStack>
            <Text fontSize="$1" color="$color8" fontFamily="$mono">{item.time}</Text>
          </XStack>
        </Animated.View>
      </GestureDetector>
    </YStack>
  )
}
```

**Rules:**
- Require `react-native-gesture-handler` (already in Expo template)
- Left swipe reveals destructive action (delete) — red background hint
- Right swipe reveals non-destructive action (archive/complete) — green
- Snap back if below threshold; animate off-screen and call action if past threshold
- Action label + icon fade in proportionally as user swipes — visual affordance
- Never swipe-to-delete without an undo option (toast with "Undo" for 3 seconds)

---

## 29. Media Mini-Player

Used for: streaming, podcasts, music — persistent playback control bar above the tab bar.

```tsx
// Persistent mini-player — rendered in root layout above tab bar
const theme = useTheme()
const playIconColor = isPlaying ? theme.background.val : 'white'

{currentTrack && (
  <Pressable onPress={() => router.push('/player')} style={{ position: 'absolute', bottom: 84, left: 8, right: 8 }}>
    <Animated.View entering={SlideInDown.duration(300)} exiting={SlideOutDown.duration(200)}>
      <XStack bg="$color2" rounded="$4" px="$3" py="$2" items="center" gap="$3"
        borderWidth={1} borderColor="$borderColor"
        boxShadow="0 4px 12px rgba(0, 0, 0, 0.12)">

        {/* Album art */}
        <YStack width={44} height={44} rounded="$3" bg="$color4" overflow="hidden">
          <Image source={{ uri: currentTrack.artwork }} style={{ width: 44, height: 44 }} contentFit="cover" />
        </YStack>

        {/* Track info — scrolling ticker if too long */}
        <YStack flex={1}>
          <Text fontWeight="600" fontSize="$3" numberOfLines={1}>{currentTrack.title}</Text>
          <Text fontSize="$2" color="$color9" numberOfLines={1}>{currentTrack.artist}</Text>
        </YStack>

        {/* Controls */}
        <XStack items="center" gap="$1">
          <Button size="$3" circular chromeless icon={<SkipBack color={theme.color12.val} />} onPress={previous} />
          <Button size="$3" circular
            bg={isPlaying ? '$color12' : '$blue10'}
            onPress={togglePlay}
            icon={isPlaying ? <Pause color={playIconColor} /> : <Play color={playIconColor} />}
          />
          <Button size="$3" circular chromeless icon={<SkipForward color={theme.color12.val} />} onPress={next} />
        </XStack>
      </XStack>

      {/* Progress bar */}
      <YStack height={2} bg="$color3" mt={-2} mx="$1" rounded={1} overflow="hidden">
        <YStack height={2} bg="$blue10" width={`${(position / duration) * 100}%`} />
      </YStack>
    </Animated.View>
  </Pressable>
)}
```

**Full-screen player:**
```tsx
const theme = useTheme()

<YStack flex={1} bg="$background" items="center" pt="$10" pb="$8" gap="$6">
  {/* Large artwork */}
  <Animated.View entering={ZoomIn.duration(400)}>
    <YStack width={280} height={280} rounded="$6" bg="$color4" overflow="hidden"
      boxShadow="0 8px 24px rgba(0, 0, 0, 0.3)">
      <Image source={{ uri: currentTrack.artwork }} style={{ width: 280, height: 280 }} contentFit="cover" />
    </YStack>
  </Animated.View>

  {/* Track info */}
  <YStack items="center" gap="$1" px="$6">
    <H3 fontWeight="700" text="center">{currentTrack.title}</H3>
    <Text color="$color9" fontSize="$4">{currentTrack.artist}</Text>
  </YStack>

  {/* Scrubber */}
  <YStack width="100%" px="$6" gap="$1">
    <YStack height={4} bg="$color3" rounded={2} overflow="hidden">
      <YStack height={4} bg="$blue10" width={`${(position / duration) * 100}%`} />
    </YStack>
    <XStack justify="space-between">
      <Text fontSize="$1" color="$color9" fontFamily="$mono">{formatTime(position)}</Text>
      <Text fontSize="$1" color="$color9" fontFamily="$mono">-{formatTime(duration - position)}</Text>
    </XStack>
  </YStack>

  {/* Playback controls */}
  <XStack items="center" gap="$5">
    <Button size="$4" circular chromeless icon={<Shuffle color={shuffle ? theme.blue10.val : theme.color9.val} />} onPress={toggleShuffle} />
    <Button size="$5" circular chromeless icon={<SkipBack color={theme.color12.val} />} onPress={previous} />
    <Button size="$6" circular bg="$color12" onPress={togglePlay}
      icon={isPlaying ? <Pause color={theme.background.val} /> : <Play color={theme.background.val} />} pressStyle={{ scale: 0.95 }} />
    <Button size="$5" circular chromeless icon={<SkipForward color={theme.color12.val} />} onPress={next} />
    <Button size="$4" circular chromeless icon={<Repeat color={repeat ? theme.blue10.val : theme.color9.val} />} onPress={toggleRepeat} />
  </XStack>
</YStack>
```

**Rules:**
- Mini-player sits 84px above bottom (above tab bar), slides in/out with `SlideInDown`/`SlideOutDown`
- Progress bar is part of the mini-player card — no separate element
- Full-screen player: artwork scales in (`ZoomIn`) for cinematic feel
- Scrubber shows elapsed + remaining (negative) — not total duration

---
