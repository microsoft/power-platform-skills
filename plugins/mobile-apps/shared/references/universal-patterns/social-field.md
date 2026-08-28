# Social and Field Patterns

## 11. Gamification Patterns

### Streak Counter
```tsx
import { Ionicons } from '@expo/vector-icons'

<XStack items="center" gap="$2" bg="$color2" rounded="$4" px="$3" py="$2">
  <Ionicons name="flame" size={24} color="#e55a00" />
  <YStack>
    <Text fontWeight="700" fontSize="$4">{streakDays} days</Text>
    <Text fontSize="$1" color="$color9">Current streak</Text>
  </YStack>
</XStack>
```

### Milestone Celebration
```tsx
import { Ionicons } from '@expo/vector-icons'

// Trigger after task completion (Peak-End Rule)
{showCelebration && (
  <Animated.View entering={BounceIn.duration(600)}>
    <YStack items="center" gap="$3" p="$5">
      <Ionicons name="trophy" size={64} color="#e55a00" />
      <H3 fontWeight="700" text="center">Milestone reached!</H3>
      <Text color="$color9" text="center">{milestoneMessage}</Text>
      <Button theme="blue" size="$4" onPress={dismiss}>Continue</Button>
    </YStack>
  </Animated.View>
)}
```

### Leaderboard Row
```tsx
<XStack items="center" gap="$3" p="$3" bg={rank <= 3 ? '$color2' : 'transparent'} rounded="$3">
  <Text width={28} fontWeight="700" fontSize="$4" color={rank <= 3 ? '$blue10' : '$color9'} text="center">
    {rank}
  </Text>
  <YStack width={36} height={36} rounded={18} bg="$color4" items="center" justify="center" overflow="hidden">
    {avatar ? <Image source={{ uri: avatar }} style={{ width: 36, height: 36 }} /> : <User size={20} color="$color9" />}
  </YStack>
  <YStack flex={1}>
    <Text fontWeight="600">{name}</Text>
    <Text fontSize="$1" color="$color9">{subtitle}</Text>
  </YStack>
  <Text fontWeight="700" fontFamily="$mono">{score}</Text>
</XStack>
```

---

## 12. Conversation Thread / Activity Feed

Used for: enterprise collaboration, CRM, project management.

```tsx
// Activity feed item
<XStack gap="$3" px="$4" py="$3">
  <YStack width={32} height={32} rounded={16} bg="$color4" items="center" justify="center">
    <User size={16} color="$color9" />
  </YStack>
  <YStack flex={1} gap="$1">
    <XStack items="center" gap="$2">
      <Text fontWeight="600" fontSize="$2">{author}</Text>
      <Text fontSize="$1" color="$color8">{timeAgo}</Text>
    </XStack>
    <Text fontSize="$2" color="$color10">{message}</Text>
    {/* Reply thread indicator */}
    {replyCount > 0 && (
      <Pressable onPress={() => expandThread(id)}>
        <XStack items="center" gap="$1" mt="$1">
          <MessageCircle size={14} color="$blue10" />
          <Text fontSize="$1" color="$blue10" fontWeight="600">{replyCount} replies</Text>
        </XStack>
      </Pressable>
    )}
  </YStack>
</XStack>
```

---

## 13. Cart Animation / Action Confirmation

Used for: e-commerce, any "add to collection" action.

```tsx
// Badge bounce on add
const scale = useSharedValue(1)

function onAddToCart() {
  addItem(item)
  scale.value = withSequence(
    withTiming(1.4, { duration: 150 }),
    withTiming(1, { duration: 200 })
  )
}

// Cart icon with animated badge
<YStack>
  <ShoppingCart size={24} color="$color12" />
  {cartCount > 0 && (
    <Animated.View style={[badgeStyle, useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))]}>
      <Text fontSize={10} color="white" fontWeight="700">{cartCount}</Text>
    </Animated.View>
  )}
</YStack>
```

---

## 14. Photo Annotation / Before-After

Used for: field inspections, maintenance, real estate.

### Before/After Pair
```tsx
<XStack gap="$3">
  <YStack flex={1} gap="$1">
    <Text fontSize="$1" color="$color8" fontWeight="600" textTransform="uppercase" letterSpacing={1}>Before</Text>
    <YStack height={180} bg="$color4" rounded="$3" overflow="hidden">
      <Image source={{ uri: beforeUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
    </YStack>
    <Text fontSize="$1" color="$color8">{beforeDate}</Text>
  </YStack>
  <YStack flex={1} gap="$1">
    <Text fontSize="$1" color="$color8" fontWeight="600" textTransform="uppercase" letterSpacing={1}>After</Text>
    <YStack height={180} bg="$color4" rounded="$3" overflow="hidden">
      <Image source={{ uri: afterUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
    </YStack>
    <Text fontSize="$1" color="$color8">{afterDate}</Text>
  </YStack>
</XStack>
```

---

## 15. Enlarged Touch Targets for Field Use

For field/industrial apps where users wear gloves or work in harsh conditions.

**Minimum sizes:**
- Standard buttons: `size="$5"` (60pt) instead of `size="$4"` (48pt)
- Critical actions (emergency stop, submit): `size="$6"` (72pt)
- Body text: minimum `fontSize="$4"` (16px), prefer `fontSize="$5"` (18px)
- Row tap targets: `minH={64}` instead of 48

```tsx
// Field-sized action button
<Button size="$5" theme="blue" icon={Camera}>
  <Text fontWeight="700">Capture Photo</Text>
</Button>

// Field-sized list row
<XStack items="center" gap="$4" p="$4" minH={64} pressStyle={{ bg: '$color3' }}>
  <YStack flex={1}>
    <Text fontSize="$4" fontWeight="600">{title}</Text>
    <Text fontSize="$3" color="$color9">{subtitle}</Text>
  </YStack>
  <ChevronRight size={24} color="$color10" />
</XStack>
```

---

## 16. Map-Dominant Screens

Used for: ride-hailing, delivery, field service, real estate — any app where location IS the primary content.

```tsx
import MapView, { Marker } from 'react-native-maps'

// Full-bleed map as home screen
<YStack flex={1}>
  <MapView
    style={{ flex: 1 }}
    initialRegion={{ latitude: 37.78, longitude: -122.43, latitudeDelta: 0.02, longitudeDelta: 0.02 }}
    showsUserLocation
  >
    {items.map((item) => (
      <Marker key={item.id} coordinate={{ latitude: item.lat, longitude: item.lng }}
        onPress={() => setSelected(item)} />
    ))}
  </MapView>

  {/* Floating search bar over the map */}
  <XStack position="absolute" t={60} l={16} r={16} bg="$background" rounded="$4" px="$3" py="$2"
    items="center" gap="$2" boxShadow="0 2px 8px rgba(0, 0, 0, 0.12)">
    <Search size={18} color="$color9" />
    <Input flex={1} placeholder="Search locations..." bg="transparent" borderWidth={0} />
  </XStack>

  {/* Bottom sheet for selected item or list */}
  <Sheet open={!!selected} onOpenChange={() => setSelected(null)} snapPoints={[35, 70]}>
    <Sheet.Frame p="$4" gap="$3">
      <YStack width={40} height={4} bg="$color6" rounded={2} self="center" />
      <H4 fontWeight="700">{selected?.name}</H4>
      <Text color="$color9">{selected?.address}</Text>
      <XStack gap="$3">
        <Button flex={1} theme="blue" size="$4" icon={Navigation}>Directions</Button>
        <Button flex={1} size="$4" icon={Phone}>Call</Button>
      </XStack>
    </Sheet.Frame>
  </Sheet>
</YStack>
```

**Rules:**
- Map fills entire screen — no header bar covering it
- Search bar floats over the map with elevation shadow
- Detail appears in a bottom sheet, not a new screen
- Sheet has two snap points: peek (35%) and full (70%)
- Always show user's current location dot

---

## 17. Breathing / Coaching Animations

Used for: health/wellness, meditation, onboarding flows — animation IS the content.

```tsx
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withSequence, withTiming, Easing } from 'react-native-reanimated'

function BreathingCircle() {
  const scale = useSharedValue(1)
  const opacity = useSharedValue(0.4)
  const [phase, setPhase] = React.useState('Breathe in')

  React.useEffect(() => {
    // 4s inhale → 4s exhale, repeat
    scale.value = withRepeat(
      withSequence(
        withTiming(1.6, { duration: 4000, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 4000, easing: Easing.inOut(Easing.ease) })
      ), -1, false
    )
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.8, { duration: 4000 }),
        withTiming(0.4, { duration: 4000 })
      ), -1, false
    )

    const interval = setInterval(() => {
      setPhase(p => p === 'Breathe in' ? 'Breathe out' : 'Breathe in')
    }, 4000)
    return () => clearInterval(interval)
  }, [])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }))

  return (
    <YStack flex={1} items="center" justify="center" bg="$background">
      <Animated.View style={[{ width: 200, height: 200, borderRadius: 100, backgroundColor: '#3b82f6' }, animatedStyle]} />
      <Text position="absolute" fontSize="$6" fontWeight="600" color="$color12">{phase}</Text>
    </YStack>
  )
}
```

**Coaching flow pattern:**
```tsx
// Step-by-step guided flow with progress
<YStack flex={1} p="$5" gap="$5">
  {/* Progress dots */}
  <XStack items="center" justify="center" gap="$2">
    {steps.map((_, i) => (
      <YStack key={i} width={i === currentStep ? 24 : 8} height={8}
        rounded={4} bg={i <= currentStep ? '$blue10' : '$color4'} />
    ))}
  </XStack>

  <Animated.View key={currentStep} entering={FadeInUp.duration(400)}>
    <YStack items="center" gap="$4" py="$8">
      <Text fontSize={64}>{steps[currentStep].emoji}</Text>
      <H3 fontWeight="700" text="center">{steps[currentStep].title}</H3>
      <Paragraph color="$color9" text="center" px="$4">{steps[currentStep].body}</Paragraph>
    </YStack>
  </Animated.View>

  <YStack flex={1} justify="flex-end">
    <Button theme="blue" size="$5" onPress={nextStep}>
      {currentStep === steps.length - 1 ? 'Get started' : 'Next'}
    </Button>
  </YStack>
</YStack>
```

---
