# Data and Feedback Patterns

## 1. Horizontal Scroll Carousel

Used for: product rows, category browsing, "For You" sections, media galleries.

```tsx
<YStack gap="$3">
  <SectionHeader title="For You" action="See all" />
  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
    {items.map((item) => (
      <YStack key={item.id} width={160} gap="$2">
        <YStack height={160} bg="$color4" rounded="$4" overflow="hidden">
          <Image source={{ uri: item.image }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
        </YStack>
        <Text fontSize="$3" fontWeight="600" numberOfLines={1}>{item.title}</Text>
        <Text fontSize="$2" color="$color9">{item.subtitle}</Text>
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
<YStack bg="$color2" rounded="$4" p="$4" width="47%" gap="$2">
  <Text fontSize="$2" color="$color9">{label}</Text>
  <XStack items="center" justify="space-between">
    <Text fontSize="$8" fontWeight="700">{value}</Text>
    <Sparkline data={trendData} trend={trend} />
  </XStack>
  <XStack items="center" gap="$1">
    <Text fontSize="$1" color={trend === 'up' ? '$green10' : '$red10'} fontWeight="600">
      {trend === 'up' ? '↑' : '↓'} {changePercent}%
    </Text>
    <Text fontSize="$1" color="$color8">vs last week</Text>
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
    <YStack width={width} height={height} rounded={borderRadius} bg="$color3" overflow="hidden">
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
<XStack items="center" gap="$2" px="$4">
  <XStack flex={1} items="center" bg="$color3" rounded="$3" px="$3" gap="$2">
    <Search size={18} color="$color9" />
    <Input flex={1} placeholder="Search..." value={search}
      onChange={event => setSearch(event.target?.value ?? event.nativeEvent?.text ?? '')}
      bg="transparent" borderWidth={0} px="$0" />
  </XStack>
  <Button size="$3" icon={SlidersHorizontal} chromeless onPress={() => setShowFilters(true)}>
    {activeFilterCount > 0 && (
      <YStack position="absolute" t={-4} r={-4} width={18} height={18} rounded={9} bg="$blue10" items="center" justify="center">
        <Text fontSize={10} color="white" fontWeight="700">{activeFilterCount}</Text>
      </YStack>
    )}
  </Button>
</XStack>

// Filter sheet
<Sheet open={showFilters} onOpenChange={setShowFilters} snapPoints={[50]}>
  <Sheet.Frame p="$4" gap="$4">
    <XStack items="center" justify="space-between">
      <H4 fontWeight="700">Filters</H4>
      <Button size="$2" chromeless onPress={clearFilters}>
        <Text color="$blue10" fontSize="$2">Clear all</Text>
      </Button>
    </XStack>

    <YStack gap="$3">
      <Text fontWeight="600" fontSize="$2" color="$color9">Status</Text>
      <XStack gap="$2" flexWrap="wrap">
        {['All', 'Active', 'Pending', 'Completed'].map((s) => (
          <Button key={s} size="$2"
            bg={filters.status === s.toLowerCase() ? '$blue10' : '$color3'}
            color={filters.status === s.toLowerCase() ? 'white' : '$color12'}
            onPress={() => setFilters(current => ({ ...current, status: s.toLowerCase() }))}>
            {s}
          </Button>
        ))}
      </XStack>
    </YStack>

    {/* Repeat for dateRange, category, etc. */}

    <Button theme="blue" size="$4" onPress={() => setShowFilters(false)}>
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
    <YStack items="center" justify="center" width={size} height={size}>
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
      <YStack position="absolute" items="center">
        <Text fontSize="$8" fontWeight="700">{Math.round(progress * 100)}%</Text>
        <Text fontSize="$1" color="$color9">Complete</Text>
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
