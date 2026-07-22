# Universal App Patterns Reference

> Optional reference — read this when building screens that need polish beyond the base design system.
> These patterns are drawn from top-tier consumer, finance, health, enterprise, and field apps.

---

## 1. Horizontal Scroll Carousel

Used for: product rows, category browsing, "For You" sections, media galleries.

```tsx
<YStack gap="$3">
  <SectionHeader title="For You" action="See all" />
  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
    {items.map((item) => (
      <YStack key={item.id} w={160} gap="$2">
        <YStack h={160} bg="$color4" br="$4" overflow="hidden">
          <Image source={{ uri: item.image }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
        </YStack>
        <Text fontSize="$3" fontWeight="600" numberOfLines={1}>{item.title}</Text>
        <Text fontSize="$2" col="$color9">{item.subtitle}</Text>
      </YStack>
    ))}
  </ScrollView>
</YStack>
```

**Rules:**
- Card width 140–180px, consistent within a row
- Gap 12px between cards
- First/last card aligns with screen edge padding
- Always show a sliver of the next card to hint scrollability

---

## 2. Sparkline / Mini-Chart

Used for: balance trends, stock tickers, health metrics, KPI cards.

Since we can't use a chart library in every app, approximate with a simple SVG polyline or use `react-native-svg` if available.

```tsx
// Minimal sparkline — 7 data points, no axes, no labels
<Svg width={80} height={32} viewBox="0 0 80 32">
  <Polyline
    points="0,28 13,20 26,24 40,12 53,16 66,4 80,8"
    fill="none"
    stroke={trend === 'up' ? '#22c55e' : '#ef4444'}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  />
</Svg>
```

**Stat card with sparkline:**
```tsx
<YStack bg="$color2" br="$4" p="$4" w="47%" gap="$2">
  <Text fontSize="$2" col="$color9">{label}</Text>
  <XStack ai="center" jc="space-between">
    <Text fontSize="$8" fontWeight="700">{value}</Text>
    <Sparkline data={trendData} trend={trend} />
  </XStack>
  <XStack ai="center" gap="$1">
    <Text fontSize="$1" col={trend === 'up' ? '$green10' : '$red10'} fontWeight="600">
      {trend === 'up' ? '↑' : '↓'} {changePercent}%
    </Text>
    <Text fontSize="$1" col="$color8">vs last week</Text>
  </XStack>
</YStack>
```

---

## 3. Skeleton Shimmer Animation

Most polished mobile apps animate skeletons with a left-to-right gradient sweep. Use `react-native-reanimated` for a simple shimmer.

```tsx
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming } from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'

function ShimmerBox({ width, height, borderRadius = 8 }) {
  const translateX = useSharedValue(-width)

  React.useEffect(() => {
    translateX.value = withRepeat(withTiming(width, { duration: 1200 }), -1, false)
  }, [])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }))

  return (
    <YStack w={width} h={height} br={borderRadius} bg="$color3" overflow="hidden">
      <Animated.View style={[{ width: '100%', height: '100%' }, animatedStyle]}>
        <LinearGradient
          colors={['transparent', 'rgba(255,255,255,0.15)', 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={{ width: width * 2, height: '100%' }}
        />
      </Animated.View>
    </YStack>
  )
}
```

**Usage:** Replace static `<YStack bg="$color2" />` skeleton placeholders with `<ShimmerBox />`.

---

## 4. Deep Search with Filter Drawer

Used for: any list with >20 items. Combines a search bar with a multi-facet filter sheet.

```tsx
const [search, setSearch] = React.useState('')
const [showFilters, setShowFilters] = React.useState(false)
const [filters, setFilters] = React.useState({ status: 'all', dateRange: 'all', category: 'all' })

// Search bar with filter button
<XStack ai="center" gap="$2" px="$4">
  <XStack f={1} ai="center" bg="$color3" br="$3" px="$3" gap="$2">
    <Search size={18} color="$color9" />
    <Input f={1} placeholder="Search..." value={search} onChangeText={setSearch}
      bg="transparent" borderWidth={0} px="$0" />
  </XStack>
  <Button size="$3" icon={SlidersHorizontal} chromeless onPress={() => setShowFilters(true)}>
    {activeFilterCount > 0 && (
      <YStack pos="absolute" t={-4} r={-4} w={18} h={18} br={9} bg="$blue10" ai="center" jc="center">
        <Text fontSize={10} color="white" fontWeight="700">{activeFilterCount}</Text>
      </YStack>
    )}
  </Button>
</XStack>

// Filter sheet
<Sheet open={showFilters} onOpenChange={setShowFilters} snapPoints={[50]}>
  <Sheet.Frame p="$4" gap="$4">
    <XStack ai="center" jc="space-between">
      <H4 fontWeight="700">Filters</H4>
      <Button size="$2" chromeless onPress={clearFilters}>
        <Text col="$blue10" fontSize="$2">Clear all</Text>
      </Button>
    </XStack>

    <YStack gap="$3">
      <Text fontWeight="600" fontSize="$2" col="$color9">Status</Text>
      <XStack gap="$2" flexWrap="wrap">
        {['All', 'Active', 'Pending', 'Completed'].map((s) => (
          <Button key={s} size="$2"
            bg={filters.status === s.toLowerCase() ? '$blue10' : '$color3'}
            color={filters.status === s.toLowerCase() ? 'white' : '$color'}
            onPress={() => setFilters(f => ({ ...f, status: s.toLowerCase() }))}>
            {s}
          </Button>
        ))}
      </XStack>
    </YStack>

    {/* Repeat for dateRange, category, etc. */}

    <Button bg="$blue10" color="$color1" size="$4" onPress={() => setShowFilters(false)}>
      Apply filters
    </Button>
  </Sheet.Frame>
</Sheet>
```

**Rules:**
- Filter chips use filled bg when active, muted when inactive
- Show active filter count badge on the filter button
- "Clear all" always visible when any filter is active
- Sheet snaps to 50% height; scroll internally if many facets

---

## 5. Circular Progress Ring

Used for: credit scores, health goals, completion tracking, timers.

```tsx
import Svg, { Circle } from 'react-native-svg'

function ProgressRing({ progress, size = 120, strokeWidth = 10, color = '$blue10' }) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference * (1 - progress)

  return (
    <YStack ai="center" jc="center" w={size} h={size}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
        {/* Background track */}
        <Circle cx={size / 2} cy={size / 2} r={radius}
          stroke="$color3" strokeWidth={strokeWidth} fill="none" />
        {/* Progress arc */}
        <Circle cx={size / 2} cy={size / 2} r={radius}
          stroke={color} strokeWidth={strokeWidth} fill="none"
          strokeDasharray={circumference} strokeDashoffset={strokeDashoffset}
          strokeLinecap="round" />
      </Svg>
      {/* Center label */}
      <YStack pos="absolute" ai="center">
        <Text fontSize="$8" fontWeight="700">{Math.round(progress * 100)}%</Text>
        <Text fontSize="$1" col="$color9">Complete</Text>
      </YStack>
    </YStack>
  )
}
```

**Variants:**
- **Small (48px):** Inline in list rows, no center label
- **Medium (80px):** In stat cards, single number center label
- **Large (120px):** Hero placement, number + subtitle in center

---

## 6. Biometric Auth / Reveal Gate

Used for: finance balances, health records, sensitive data.

```tsx
const [revealed, setRevealed] = React.useState(false)

// Blurred balance that reveals on tap
<Pressable onPress={async () => {
  const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Verify to view balance' })
  if (result.success) setRevealed(true)
}}>
  {revealed ? (
    <Animated.Text entering={FadeIn.duration(400)}>
      <Text fontSize="$9" fontWeight="700" fontFamily="$mono">$12,450.00</Text>
    </Animated.Text>
  ) : (
    <XStack ai="center" gap="$2">
      <Text fontSize="$9" fontWeight="700" col="$color6">••••••</Text>
      <Eye size={20} color="$color10" />
    </XStack>
  )}
</Pressable>
```

**Rules:**
- Default to hidden on app open for sensitive values
- Show dots/blur, not empty space — user must know data exists
- Tap-to-reveal with biometric prompt
- Animate the reveal (FadeIn) so it feels intentional

---

## 7. Session Timeout Warning

Used for: finance, enterprise, health — any app with auth sessions.

```tsx
<AlertDialog open={showTimeout}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay />
    <AlertDialog.Content p="$5" gap="$4" ai="center">
      <Clock size={40} color="$color9" />
      <H4 fontWeight="700" ta="center">Session expiring</H4>
      <Text col="$color9" ta="center">
        Your session will expire in {countdown}s due to inactivity.
      </Text>
      <XStack gap="$3" w="100%">
        <Button f={1} size="$4" onPress={logout}>Log out</Button>
        <Button f={1} size="$4" bg="$blue10" color="$color1" onPress={extendSession}>Stay signed in</Button>
      </XStack>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog>
```

---

## 8. Offline Sync Queue UI

Used for: field apps, any app that works without connectivity.

```tsx
// Sync status bar — sticky at top of list screens
{pendingCount > 0 && (
  <XStack bg="$yellow3" px="$4" py="$2" ai="center" jc="space-between">
    <XStack ai="center" gap="$2">
      <CloudOff size={16} color="$yellow10" />
      <Text fontSize="$2" col="$yellow10" fontWeight="600">
        {pendingCount} changes pending sync
      </Text>
    </XStack>
    <Button size="$2" chromeless onPress={retrySync}>
      <Text fontSize="$2" col="$yellow10" fontWeight="600">Retry</Text>
    </Button>
  </XStack>
)}

// Per-item sync indicator in list rows
<XStack ai="center" gap="$1">
  {item.syncStatus === 'pending' && <CloudOff size={12} color="$yellow10" />}
  {item.syncStatus === 'syncing' && <RefreshCw size={12} color="$blue10" />}
  {item.syncStatus === 'failed' && <AlertTriangle size={12} color="$red10" />}
</XStack>
```

---

## 9. Safety / Priority Alert Banner

Used for: field apps, health alerts, system warnings. Pinned above scrollable content.

```tsx
// Pinned at top, above ScrollView
{activeAlert && (
  <XStack
    bg={activeAlert.severity === 'critical' ? '$red3' : '$yellow3'}
    px="$4" py="$3" ai="center" gap="$3">
    <AlertTriangle size={20}
      color={activeAlert.severity === 'critical' ? '$red10' : '$yellow10'} />
    <YStack f={1}>
      <Text fontWeight="700" fontSize="$2"
        col={activeAlert.severity === 'critical' ? '$red10' : '$yellow10'}>
        {activeAlert.title}
      </Text>
      <Text fontSize="$1"
        col={activeAlert.severity === 'critical' ? '$red9' : '$yellow9'}>
        {activeAlert.message}
      </Text>
    </YStack>
    <Button size="$2" chromeless onPress={() => dismissAlert(activeAlert.id)}>
      <X size={16} color="$color9" />
    </Button>
  </XStack>
)}
```

**Severity levels:**
- `critical` — red background, non-dismissable until acknowledged
- `warning` — yellow background, dismissable
- `info` — blue background, dismissable

---

## 10. Voice Input Button

Used for: field data entry with gloved hands, accessibility.

```tsx
<XStack ai="center" gap="$2">
  <Input f={1} placeholder="Enter notes..." value={value} onChangeText={onChange} />
  <Button size="$3" circular chromeless
    icon={isListening ? MicOff : Mic}
    col={isListening ? '$red10' : '$color9'}
    onPress={toggleVoiceInput}
  />
</XStack>
```

Requires `expo-speech` or platform speech-to-text API. The button is a UI-only pattern — actual speech recognition depends on available libraries.

---

## 11. Gamification Patterns

### Streak Counter
```tsx
import { Ionicons } from '@expo/vector-icons'

<XStack ai="center" gap="$2" bg="$color2" br="$4" px="$3" py="$2">
  <Ionicons name="flame" size={24} color="#e55a00" />
  <YStack>
    <Text fontWeight="700" fontSize="$4">{streakDays} days</Text>
    <Text fontSize="$1" col="$color9">Current streak</Text>
  </YStack>
</XStack>
```

### Milestone Celebration
```tsx
import { Ionicons } from '@expo/vector-icons'

// Trigger after task completion (Peak-End Rule)
{showCelebration && (
  <Animated.View entering={BounceIn.duration(600)}>
    <YStack ai="center" gap="$3" p="$5">
      <Ionicons name="trophy" size={64} color="#e55a00" />
      <H3 fontWeight="700" ta="center">Milestone reached!</H3>
      <Text col="$color9" ta="center">{milestoneMessage}</Text>
      <Button bg="$blue10" color="$color1" size="$4" onPress={dismiss}>Continue</Button>
    </YStack>
  </Animated.View>
)}
```

### Leaderboard Row
```tsx
<XStack ai="center" gap="$3" p="$3" bg={rank <= 3 ? '$color2' : 'transparent'} br="$3">
  <Text w={28} fontWeight="700" fontSize="$4" col={rank <= 3 ? '$blue10' : '$color9'} ta="center">
    {rank}
  </Text>
  <YStack w={36} h={36} br={18} bg="$color4" ai="center" jc="center" overflow="hidden">
    {avatar ? <Image source={{ uri: avatar }} style={{ width: 36, height: 36 }} /> : <User size={20} color="$color9" />}
  </YStack>
  <YStack f={1}>
    <Text fontWeight="600">{name}</Text>
    <Text fontSize="$1" col="$color9">{subtitle}</Text>
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
  <YStack w={32} h={32} br={16} bg="$color4" ai="center" jc="center">
    <User size={16} color="$color9" />
  </YStack>
  <YStack f={1} gap="$1">
    <XStack ai="center" gap="$2">
      <Text fontWeight="600" fontSize="$2">{author}</Text>
      <Text fontSize="$1" col="$color8">{timeAgo}</Text>
    </XStack>
    <Text fontSize="$2" col="$color10">{message}</Text>
    {/* Reply thread indicator */}
    {replyCount > 0 && (
      <Pressable onPress={() => expandThread(id)}>
        <XStack ai="center" gap="$1" mt="$1">
          <MessageCircle size={14} color="$blue10" />
          <Text fontSize="$1" col="$blue10" fontWeight="600">{replyCount} replies</Text>
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
  <ShoppingCart size={24} color="$color" />
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
  <YStack f={1} gap="$1">
    <Text fontSize="$1" col="$color8" fontWeight="600" tt="uppercase" ls={1}>Before</Text>
    <YStack h={180} bg="$color4" br="$3" overflow="hidden">
      <Image source={{ uri: beforeUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
    </YStack>
    <Text fontSize="$1" col="$color8">{beforeDate}</Text>
  </YStack>
  <YStack f={1} gap="$1">
    <Text fontSize="$1" col="$color8" fontWeight="600" tt="uppercase" ls={1}>After</Text>
    <YStack h={180} bg="$color4" br="$3" overflow="hidden">
      <Image source={{ uri: afterUri }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
    </YStack>
    <Text fontSize="$1" col="$color8">{afterDate}</Text>
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
- Row tap targets: `minHeight={64}` instead of 48

```tsx
// Field-sized action button
<Button size="$5" bg="$blue10" color="$color1" icon={Camera} fontWeight="700">
  Capture Photo
</Button>

// Field-sized list row
<XStack ai="center" gap="$4" p="$4" minHeight={64} pressStyle={{ bg: '$color3' }}>
  <YStack f={1}>
    <Text fontSize="$4" fontWeight="600">{title}</Text>
    <Text fontSize="$3" col="$color9">{subtitle}</Text>
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
<YStack f={1}>
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
  <XStack pos="absolute" t={60} l={16} r={16} bg="$background" br="$4" px="$3" py="$2"
    ai="center" gap="$2" elevation={4}>
    <Search size={18} color="$color9" />
    <Input f={1} placeholder="Search locations..." bg="transparent" borderWidth={0} />
  </XStack>

  {/* Bottom sheet for selected item or list */}
  <Sheet open={!!selected} onOpenChange={() => setSelected(null)} snapPoints={[35, 70]}>
    <Sheet.Frame p="$4" gap="$3">
      <YStack w={40} h={4} bg="$color6" br={2} als="center" />
      <H4 fontWeight="700">{selected?.name}</H4>
      <Text col="$color9">{selected?.address}</Text>
      <XStack gap="$3">
        <Button f={1} bg="$blue10" color="$color1" size="$4" icon={Navigation}>Directions</Button>
        <Button f={1} size="$4" icon={Phone}>Call</Button>
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
    <YStack f={1} ai="center" jc="center" bg="$background">
      <Animated.View style={[{ width: 200, height: 200, borderRadius: 100, backgroundColor: '#3b82f6' }, animatedStyle]} />
      <Text pos="absolute" fontSize="$6" fontWeight="600" col="$color">{phase}</Text>
    </YStack>
  )
}
```

**Coaching flow pattern:**
```tsx
// Step-by-step guided flow with progress
<YStack f={1} p="$5" gap="$5">
  {/* Progress dots */}
  <XStack ai="center" jc="center" gap="$2">
    {steps.map((_, i) => (
      <YStack key={i} w={i === currentStep ? 24 : 8} h={8}
        br={4} bg={i <= currentStep ? '$blue10' : '$color4'} />
    ))}
  </XStack>

  <Animated.View key={currentStep} entering={FadeInUp.duration(400)}>
    <YStack ai="center" gap="$4" py="$8">
      <Text fontSize={64}>{steps[currentStep].emoji}</Text>
      <H3 fontWeight="700" ta="center">{steps[currentStep].title}</H3>
      <Paragraph col="$color9" ta="center" px="$4">{steps[currentStep].body}</Paragraph>
    </YStack>
  </Animated.View>

  <YStack f={1} jc="flex-end">
    <Button bg="$blue10" color="$color1" size="$5" onPress={nextStep}>
      {currentStep === steps.length - 1 ? 'Get started' : 'Next'}
    </Button>
  </YStack>
</YStack>
```

---

## 18. Progressive Disclosure

Used for: health records, finance details, any sensitive or complex data that benefits from tap-to-reveal layers.

```tsx
// Expandable section — collapsed by default
function DisclosureSection({ title, subtitle, children }) {
  const [expanded, setExpanded] = React.useState(false)

  return (
    <YStack bg="$color2" br="$4" overflow="hidden">
      <Pressable onPress={() => setExpanded(!expanded)}>
        <XStack ai="center" p="$4" gap="$3">
          <YStack f={1}>
            <Text fontWeight="600">{title}</Text>
            {!expanded && subtitle && <Text fontSize="$2" col="$color9">{subtitle}</Text>}
          </YStack>
          <ChevronDown size={20} color="$color10"
            style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }} />
        </XStack>
      </Pressable>
      {expanded && (
        <Animated.View entering={FadeIn.duration(200)}>
          <YStack px="$4" pb="$4" gap="$3">
            <Separator />
            {children}
          </YStack>
        </Animated.View>
      )}
    </YStack>
  )
}

// Usage: lab results with progressive disclosure
<YStack gap="$3">
  <DisclosureSection title="Blood Panel" subtitle="3 results • Jan 15">
    <InfoRow label="Hemoglobin" value="14.2 g/dL" status="normal" />
    <InfoRow label="White blood cells" value="7,200 /μL" status="normal" />
    <InfoRow label="Platelets" value="145,000 /μL" status="low" />
  </DisclosureSection>
  <DisclosureSection title="Metabolic Panel" subtitle="8 results • Jan 15">
    {/* ... */}
  </DisclosureSection>
</YStack>
```

**Rules:**
- Default to collapsed — user opts in to complexity
- Show a summary (count, date, status) in the collapsed state
- Animate expansion smoothly (FadeIn)
- Use for: lab results, transaction details, audit logs, nested settings

---

## 19. Inline Field Validation

Used for: finance sign-up, any form where real-time feedback prevents errors.

```tsx
// Input with inline validation state
function ValidatedInput({ label, value, onChange, validate, successMessage }) {
  const [touched, setTouched] = React.useState(false)
  const result = touched && value ? validate(value) : null

  return (
    <YStack gap="$1">
      <Text fontSize="$2" fontWeight="600" col="$color9">{label}</Text>
      <XStack ai="center" bg="$color3" br="$3" px="$3"
        borderWidth={result ? 2 : 0}
        borderColor={result?.valid ? '$green8' : result ? '$red8' : 'transparent'}>
        <Input f={1} value={value} onChangeText={onChange}
          onBlur={() => setTouched(true)}
          bg="transparent" borderWidth={0} />
        {result?.valid && <CheckCircle2 size={18} color="$green10" />}
        {result && !result.valid && <AlertCircle size={18} color="$red10" />}
      </XStack>
      {result?.valid && successMessage && (
        <Text fontSize="$1" col="$green10">{successMessage}</Text>
      )}
      {result && !result.valid && (
        <Text fontSize="$1" col="$red10">{result.message}</Text>
      )}
    </YStack>
  )
}

// Usage
<ValidatedInput
  label="Email"
  value={email}
  onChange={setEmail}
  validate={(v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
    ? { valid: true }
    : { valid: false, message: 'Enter a valid email address' }}
  successMessage="Looks good!"
/>
```

**Rules:**
- Only validate after first blur (don't show errors while typing)
- Green checkmark for valid, red circle for invalid
- Border color changes to match state
- Short success message under field ("Looks good!", "Available")
- Keep error messages under 60 characters

---

## 20. OLED True-Black Mode

Used for: finance, health, any app where users may prefer true black for OLED screens.

Adds a third theme option beyond light/dark: "OLED dark" with `#000000` backgrounds.

```tsx
// In tamagui.config.ts — add oled theme
const oledTheme = {
  ...darkTheme,
  background: '#000000',
  color2: '#0a0a0a',
  color3: '#141414',
  color4: '#1e1e1e',
  borderColor: '#1e1e1e',
}

// Theme switcher with 3 options
<XStack gap="$2" bg="$color2" br="$4" p="$1">
  {['light', 'dark', 'oled'].map((t) => (
    <Button key={t} f={1} size="$3"
      bg={theme === t ? '$color5' : 'transparent'}
      onPress={() => setTheme(t)}>
      <Text fontWeight={theme === t ? '700' : '400'} fontSize="$2">
        {t === 'oled' ? 'OLED' : t.charAt(0).toUpperCase() + t.slice(1)}
      </Text>
    </Button>
  ))}
</XStack>
```

**Rules:**
- OLED black = `#000000`, not `$color1` (which is dark gray)
- Card backgrounds use `#0a0a0a` — just enough to show card edges
- Borders use `#1e1e1e` — subtle but visible
- Text contrast must still meet WCAG AA (min 4.5:1)
- Only offer as an explicit option — don't auto-detect OLED screens

---

## 21. Elevation Change on Scroll

Used for: any screen with a header — shadow appears/deepens as content scrolls behind.

```tsx
import Animated, { useSharedValue, useAnimatedStyle, interpolate, useAnimatedScrollHandler } from 'react-native-reanimated'

function ScrollElevationHeader({ title }) {
  const scrollY = useSharedValue(0)

  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => { scrollY.value = event.contentOffset.y },
  })

  const headerStyle = useAnimatedStyle(() => ({
    shadowOpacity: interpolate(scrollY.value, [0, 30], [0, 0.15], 'clamp'),
    shadowRadius: interpolate(scrollY.value, [0, 30], [0, 8], 'clamp'),
    shadowOffset: { width: 0, height: interpolate(scrollY.value, [0, 30], [0, 2], 'clamp') },
    shadowColor: '#000',
    borderBottomWidth: interpolate(scrollY.value, [0, 10], [0, 0.5], 'clamp'),
    borderBottomColor: 'rgba(0,0,0,0.1)',
  }))

  return (
    <YStack f={1}>
      <Animated.View style={[{ paddingHorizontal: 16, paddingVertical: 12, backgroundColor: 'var(--background)' }, headerStyle]}>
        <H3 fontWeight="700">{title}</H3>
      </Animated.View>
      <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16}>
        {/* screen content */}
      </Animated.ScrollView>
    </YStack>
  )
}
```

**Rules:**
- Shadow starts at 0 and reaches full by 30px of scroll
- Use `interpolate` with `clamp` — shadow never exceeds max
- In dark mode, use a lighter border instead of shadow (shadows invisible on dark)
- Applies to sticky headers, tab bars, and toolbars

---

## 22. Illustrated Empty States

Used for: consumer/retail apps where branding matters. Upgrades from icon-only empty states to branded SVG illustrations.

```tsx
// Branded empty state with SVG illustration
import EmptyCartIllustration from '@/assets/illustrations/empty-cart.svg'

<YStack f={1} ai="center" jc="center" p="$5" gap="$4">
  <EmptyCartIllustration width={200} height={160} color="$color6" />
  <H4 fontWeight="700" ta="center">Your cart is empty</H4>
  <Paragraph col="$color9" ta="center" px="$4">
    Browse our collection to find something you love.
  </Paragraph>
  <Button bg="$blue10" color="$color1" size="$4" icon={ShoppingBag} onPress={() => router.push('/shop')}>
    Start shopping
  </Button>
</YStack>
```

**When to use illustrated vs icon empty states:**
- **Icon** (`<Inbox size={48} />`): Utility apps, enterprise, field — keeps it minimal
- **Illustrated SVG**: Consumer, retail, health — warmer, branded feel

**Illustration guidelines:**
- Keep SVGs under 5KB — simple line art, not detailed scenes
- Use `currentColor` in SVGs so they adapt to light/dark mode
- Max 200px wide, vertically centered in available space
- Muted colors — illustrations support the message, don't compete with the CTA
- Provide a dark mode variant or use single-color SVGs that theme automatically

---

## 23. Start/Stop Work Timer

Used for: field service, time tracking, billable hours, task management.

```tsx
function WorkTimer({ taskId }) {
  const [running, setRunning] = React.useState(false)
  const [elapsed, setElapsed] = React.useState(0)
  const startTime = React.useRef(null)

  React.useEffect(() => {
    if (!running) return
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime.current)
    }, 1000)
    return () => clearInterval(interval)
  }, [running])

  const toggle = () => {
    if (running) {
      setRunning(false)
      // Save elapsed time
    } else {
      startTime.current = Date.now() - elapsed
      setRunning(true)
    }
  }

  const formatTime = (ms) => {
    const s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
  }

  return (
    <YStack ai="center" gap="$4" p="$5">
      {/* Elapsed time display */}
      <Text fontSize={48} fontWeight="700" fontFamily="$mono" letterSpacing={2}>
        {formatTime(elapsed)}
      </Text>

      {/* Start/Stop button */}
      <Button size="$6" circular
        bg={running ? '$red10' : '$green10'}
        icon={running ? Square : Play}
        color="white"
        onPress={toggle}
        pressStyle={{ scale: 0.95 }}
      />
      <Text fontSize="$2" col="$color9">
        {running ? 'Tap to stop' : elapsed > 0 ? 'Tap to resume' : 'Tap to start'}
      </Text>

      {/* Elapsed summary when paused */}
      {!running && elapsed > 0 && (
        <XStack gap="$3" mt="$3">
          <Button size="$3" icon={RotateCcw} onPress={() => setElapsed(0)}>Reset</Button>
          <Button size="$3" bg="$blue10" color="$color1" icon={Save} onPress={() => saveTime(taskId, elapsed)}>Save</Button>
        </XStack>
      )}
    </YStack>
  )
}
```

**Rules:**
- Monospace font for elapsed time — digits must not shift
- Large circular start/stop button (72pt) — green for start, red for stop
- Show Reset + Save only when paused with time on the clock

---

## 24. Kanban Board View

Used for: project management, field service workflows, CRM pipelines.

```tsx
// Horizontal-scrolling kanban columns
<ScrollView horizontal showsHorizontalScrollIndicator={false}
  contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
  {columns.map((column) => (
    <YStack key={column.id} w={280} bg="$color2" br="$4" overflow="hidden">
      {/* Column header */}
      <XStack ai="center" jc="space-between" p="$3" bg="$color3">
        <XStack ai="center" gap="$2">
          <YStack w={8} h={8} br={4} bg={column.color} />
          <Text fontWeight="700" fontSize="$3">{column.title}</Text>
        </XStack>
        <Text fontSize="$2" col="$color8" fontFamily="$mono">{column.items.length}</Text>
      </XStack>

      {/* Column items */}
      <ScrollView style={{ maxHeight: 500 }} contentContainerStyle={{ padding: 8, gap: 8 }}>
        {column.items.map((item) => (
          <Pressable key={item.id} onLongPress={() => startDrag(item)}>
            <YStack bg="$background" br="$3" p="$3" gap="$2"
              borderWidth={1} borderColor="$borderColor"
              pressStyle={{ scale: 0.98 }}>
              <Text fontWeight="600" fontSize="$2">{item.title}</Text>
              {item.subtitle && <Text fontSize="$1" col="$color9">{item.subtitle}</Text>}
              <XStack ai="center" jc="space-between" mt="$1">
                {item.assignee && (
                  <YStack w={24} h={24} br={12} bg="$color4" ai="center" jc="center">
                    <Text fontSize={10} fontWeight="600">{item.assignee.initials}</Text>
                  </YStack>
                )}
                {item.dueDate && (
                  <Text fontSize="$1" col="$color8" fontFamily="$mono">{item.dueDate}</Text>
                )}
              </XStack>
            </YStack>
          </Pressable>
        ))}
      </ScrollView>
    </YStack>
  ))}
</ScrollView>
```

**Rules:**
- Columns 280px wide, horizontal scroll between them
- Color dot in header identifies the column/status
- Cards show title, optional subtitle, assignee avatar, due date
- Long-press to initiate drag (actual drag-and-drop requires `react-native-gesture-handler` + reanimated)
- Column scroll is vertical, board scroll is horizontal — nested scrolling

---

## 25. Full-Bleed Editorial Photography

Used for: retail, lifestyle, brand-heavy consumer apps (Nike, Airbnb style).

```tsx
// Hero image with gradient text overlay
<YStack h={400} overflow="hidden">
  <Image source={{ uri: heroImage }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
  <LinearGradient
    colors={['transparent', 'rgba(0,0,0,0.7)']}
    style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 200 }}
  />
  <YStack pos="absolute" b={0} l={0} r={0} p="$5" gap="$2">
    <Text fontSize="$2" color="white" fontWeight="600" tt="uppercase" ls={2}>New arrival</Text>
    <H2 color="white" fontWeight="700">{title}</H2>
    <Text color="rgba(255,255,255,0.8)" fontSize="$3">{subtitle}</Text>
    <Button bg="$blue10" color="$color1" size="$4" mt="$2" als="flex-start">Shop now</Button>
  </YStack>
</YStack>

// Full-width image card in a feed
<Pressable onPress={() => router.push(`/product/${id}`)}>
  <YStack overflow="hidden" br="$4" mb="$3">
    <YStack h={280} bg="$color4">
      <Image source={{ uri: image }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
    </YStack>
    <YStack p="$3" gap="$1">
      <Text fontWeight="700" fontSize="$4">{name}</Text>
      <Text col="$color9" fontSize="$2">{category}</Text>
      <Text fontWeight="700" fontSize="$3" mt="$1">${price}</Text>
    </YStack>
  </YStack>
</Pressable>
```

**Rules:**
- Images fill full width — no side padding on hero images
- Gradient overlay (transparent → dark) for text readability on images
- Text on images is always white — never rely on theme colors
- Minimum 300px height for hero images, 200px for feed cards
- Use `contentFit="cover"` always — never stretch or letterbox
- Uppercase tracking on category/label text over images

---

## 26. Content Discovery Feed (Netflix / Spotify style)

Used for: streaming, media, e-commerce — any app where content browsing IS the home screen.

```tsx
// Hero banner + multiple horizontal category rows
<ScrollView showsVerticalScrollIndicator={false}>
  {/* Hero — full-bleed featured item */}
  <YStack h={480} overflow="hidden">
    <Image source={{ uri: hero.image }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
    <LinearGradient
      colors={['transparent', 'rgba(0,0,0,0.85)']}
      style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 260 }}
    />
    <YStack pos="absolute" b={0} l={0} r={0} p="$5" gap="$3">
      <Text fontSize="$1" fontWeight="700" tt="uppercase" ls={2} color="rgba(255,255,255,0.7)">{hero.category}</Text>
      <H2 color="white" fontWeight="700" lineHeight={32}>{hero.title}</H2>
      <XStack gap="$3" mt="$2">
        <Button size="$4" bg="white" col="black" icon={Play} fontWeight="700">Play</Button>
        <Button size="$4" bg="rgba(255,255,255,0.2)" color="white" icon={Plus}>My List</Button>
      </XStack>
    </YStack>
  </YStack>

  {/* Category rows */}
  {categories.map((cat) => (
    <YStack key={cat.id} gap="$3" mb="$5">
      <Text fontSize="$4" fontWeight="700" px="$4" col="$color">{cat.title}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
        {cat.items.map((item, i) => (
          <Animated.View key={item.id} entering={FadeIn.delay(i * 30)}>
            <Pressable onPress={() => router.push(`/watch/${item.id}`)}>
              <YStack w={120} gap="$1">
                <YStack h={180} bg="$color4" br="$3" overflow="hidden"
                  style={{ transform: [{ scale: 1 }] }}
                  // pressStyle handled by parent Pressable
                >
                  <Image source={{ uri: item.poster }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
                </YStack>
              </YStack>
            </Pressable>
          </Animated.View>
        ))}
      </ScrollView>
    </YStack>
  ))}
</ScrollView>
```

**Rules:**
- Hero is always 460–500px tall, full-bleed, gradient overlay for text legibility
- Category row titles are left-aligned, no "See all" unless the list has a dedicated page
- Poster cards: 120px wide for portrait, 180px wide for landscape thumbnails
- Always show a sliver of the next card (hint scrollability)
- Dark background by default — content imagery provides the color
- "Continue watching" row always appears first if user has progress on any item

---

## 27. Live Status Tracker (Uber / delivery style)

Used for: ride-hailing, food delivery, field service dispatch — any real-time location flow.

```tsx
// Map-dominant screen with animated status bar
<YStack f={1}>
  {/* Full-screen map underneath */}
  <MapView style={{ flex: 1 }} region={region} showsUserLocation>
    <Marker coordinate={driverLocation}>
      <YStack w={36} h={36} br={18} bg="$blue10" ai="center" jc="center" elevation={4}>
        <Car size={18} color="white" />
      </YStack>
    </Marker>
    <Marker coordinate={destination} />
  </MapView>

  {/* Status sheet — snaps between 30% (status) and 65% (details) */}
  <Sheet open modal={false} snapPoints={[30, 65]} defaultOpen>
    <Sheet.Frame bg="$background" pt="$3">
      <YStack w={40} h={4} bg="$color5" br={2} als="center" mb="$4" />

      {/* Animated status row */}
      <XStack px="$5" ai="center" gap="$4" mb="$4">
        <YStack w={48} h={48} br={24} bg="$color3" ai="center" jc="center" overflow="hidden">
          <Image source={{ uri: driver.avatar }} style={{ width: 48, height: 48 }} />
        </YStack>
        <YStack f={1}>
          <Animated.Text entering={FadeInUp.duration(300)}>
            <Text fontWeight="700" fontSize="$5">{statusLabel}</Text>
          </Animated.Text>
          <Text col="$color9" fontSize="$3">{driver.name} · {driver.vehicle}</Text>
        </YStack>
        {/* ETA pill — updates in real time */}
        <YStack bg="$color2" br="$10" px="$3" py="$1">
          <Text fontWeight="700" fontSize="$4" fontFamily="$mono">{eta} min</Text>
        </YStack>
      </XStack>

      {/* Progress steps */}
      <XStack px="$5" ai="center" gap="$2">
        {steps.map((step, i) => (
          <React.Fragment key={step.id}>
            <YStack w={28} h={28} br={14} ai="center" jc="center"
              bg={i <= currentStep ? '$blue10' : '$color3'}>
              {i < currentStep
                ? <Check size={14} color="white" />
                : <Text fontSize="$1" fontWeight="700" color={i === currentStep ? 'white' : '$color9'}>{i + 1}</Text>
              }
            </YStack>
            {i < steps.length - 1 && (
              <YStack f={1} h={2} bg={i < currentStep ? '$blue10' : '$color3'} br={1} />
            )}
          </React.Fragment>
        ))}
      </XStack>

      <XStack px="$5" jc="space-between" mt="$1">
        {steps.map((step) => (
          <Text key={step.id} fontSize="$1" col="$color9" w={60} ta="center">{step.label}</Text>
        ))}
      </XStack>
    </Sheet.Frame>
  </Sheet>
</YStack>
```

**Rules:**
- Map always full-screen — never crop it with a header bar
- Status sheet overlays map, two snap heights: compact status (30%) and full detail (65%)
- ETA in monospace — digits must not shift as the number changes
- Progress step dots: filled + checkmark for completed, filled for active, empty for future
- Animate status label changes with `FadeInUp` — user notices the update
- Driver avatar always visible — makes it feel personal

---

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
    <YStack h={ROW_HEIGHT} overflow="hidden">
      {/* Background actions */}
      <XStack pos="absolute" inset={0} ai="center" jc="space-between" px="$4">
        <Animated.View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, deleteOpacity]}>
          <Archive size={20} color="$green10" />
          <Text col="$green10" fontWeight="600" fontSize="$2">Archive</Text>
        </Animated.View>
        <Animated.View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, deleteOpacity]}>
          <Text col="$red10" fontWeight="600" fontSize="$2">Delete</Text>
          <Trash2 size={20} color="$red10" />
        </Animated.View>
      </XStack>

      {/* Foreground row */}
      <GestureDetector gesture={panGesture}>
        <Animated.View style={rowStyle}>
          <XStack h={ROW_HEIGHT} bg="$background" ai="center" px="$4" gap="$3"
            borderBottomWidth={1} borderBottomColor="$borderColor">
            {/* Row content */}
            <YStack f={1}>
              <Text fontWeight="600">{item.title}</Text>
              <Text fontSize="$2" col="$color9" numberOfLines={1}>{item.subtitle}</Text>
            </YStack>
            <Text fontSize="$1" col="$color8" fontFamily="$mono">{item.time}</Text>
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
{currentTrack && (
  <Pressable onPress={() => router.push('/player')} style={{ position: 'absolute', bottom: 84, left: 8, right: 8 }}>
    <Animated.View entering={SlideInDown.duration(300)} exiting={SlideOutDown.duration(200)}>
      <XStack bg="$color2" br="$4" px="$3" py="$2" ai="center" gap="$3"
        borderWidth={1} borderColor="$borderColor"
        style={{ shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } }}>

        {/* Album art */}
        <YStack w={44} h={44} br="$3" bg="$color4" overflow="hidden">
          <Image source={{ uri: currentTrack.artwork }} style={{ width: 44, height: 44 }} contentFit="cover" />
        </YStack>

        {/* Track info — scrolling ticker if too long */}
        <YStack f={1}>
          <Text fontWeight="600" fontSize="$3" numberOfLines={1}>{currentTrack.title}</Text>
          <Text fontSize="$2" col="$color9" numberOfLines={1}>{currentTrack.artist}</Text>
        </YStack>

        {/* Controls */}
        <XStack ai="center" gap="$1">
          <Button size="$3" circular chromeless icon={SkipBack} col="$color" onPress={previous} />
          <Button size="$3" circular
            bg={isPlaying ? '$color' : '$blue10'}
            color={isPlaying ? '$background' : 'white'}
            onPress={togglePlay}
            icon={isPlaying ? Pause : Play}
          />
          <Button size="$3" circular chromeless icon={SkipForward} col="$color" onPress={next} />
        </XStack>
      </XStack>

      {/* Progress bar */}
      <YStack h={2} bg="$color3" mt={-2} mx="$1" br={1} overflow="hidden">
        <YStack h={2} bg="$blue10" w={`${(position / duration) * 100}%`} />
      </YStack>
    </Animated.View>
  </Pressable>
)}
```

**Full-screen player:**
```tsx
<YStack f={1} bg="$background" ai="center" pt="$10" pb="$8" gap="$6">
  {/* Large artwork */}
  <Animated.View entering={ZoomIn.duration(400)}>
    <YStack w={280} h={280} br="$6" bg="$color4" overflow="hidden" elevation={8}
      style={{ shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 24 }}>
      <Image source={{ uri: currentTrack.artwork }} style={{ width: 280, height: 280 }} contentFit="cover" />
    </YStack>
  </Animated.View>

  {/* Track info */}
  <YStack ai="center" gap="$1" px="$6">
    <H3 fontWeight="700" ta="center">{currentTrack.title}</H3>
    <Text col="$color9" fontSize="$4">{currentTrack.artist}</Text>
  </YStack>

  {/* Scrubber */}
  <YStack w="100%" px="$6" gap="$1">
    <YStack h={4} bg="$color3" br={2} overflow="hidden">
      <YStack h={4} bg="$blue10" w={`${(position / duration) * 100}%`} />
    </YStack>
    <XStack jc="space-between">
      <Text fontSize="$1" col="$color9" fontFamily="$mono">{formatTime(position)}</Text>
      <Text fontSize="$1" col="$color9" fontFamily="$mono">-{formatTime(duration - position)}</Text>
    </XStack>
  </YStack>

  {/* Playback controls */}
  <XStack ai="center" gap="$5">
    <Button size="$4" circular chromeless icon={Shuffle} col={shuffle ? '$blue10' : '$color9'} onPress={toggleShuffle} />
    <Button size="$5" circular chromeless icon={SkipBack} col="$color" onPress={previous} />
    <Button size="$6" circular bg="$color12" col="$background" onPress={togglePlay}
      icon={isPlaying ? Pause : Play} pressStyle={{ scale: 0.95 }} />
    <Button size="$5" circular chromeless icon={SkipForward} col="$color" onPress={next} />
    <Button size="$4" circular chromeless icon={Repeat} col={repeat ? '$blue10' : '$color9'} onPress={toggleRepeat} />
  </XStack>
</YStack>
```

**Rules:**
- Mini-player sits 84px above bottom (above tab bar), slides in/out with `SlideInDown`/`SlideOutDown`
- Progress bar is part of the mini-player card — no separate element
- Full-screen player: artwork scales in (`ZoomIn`) for cinematic feel
- Scrubber shows elapsed + remaining (negative) — not total duration

---

## When to Use This Document

Read this reference when:
- Building a **consumer/retail** app → Sections 1, 3, 4, 5, 11, 13, 21, 22, 25, 26, 28
- Building a **media/streaming** app → Sections 1, 3, 21, 26, 29
- Building a **ride/delivery** app → Sections 16, 27, 28
- Building a **finance** app → Sections 2, 3, 5, 6, 7, 19, 20
- Building a **health/wellness** app → Sections 5, 6, 11, 17, 18, 20
- Building a **field/industrial** app → Sections 8, 9, 10, 14, 15, 23, 24
- Building an **enterprise** app → Sections 4, 7, 8, 12, 24
- Any app that needs **extra polish** → Sections 1, 3, 5, 21, 22
