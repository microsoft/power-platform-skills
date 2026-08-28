# Discovery and Status Patterns

## 25. Full-Bleed Editorial Photography

Used for: retail, lifestyle, brand-heavy consumer apps (Nike, Airbnb style).

```tsx
// Hero image with gradient text overlay
<YStack height={400} overflow="hidden">
  <Image source={{ uri: heroImage }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
  <LinearGradient
    colors={['transparent', 'rgba(0,0,0,0.7)']}
    style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 200 }}
  />
  <YStack position="absolute" b={0} l={0} r={0} p="$5" gap="$2">
    <Text fontSize="$2" color="white" fontWeight="600" textTransform="uppercase" letterSpacing={2}>New arrival</Text>
    <H2 color="white" fontWeight="700">{title}</H2>
    <Text color="rgba(255,255,255,0.8)" fontSize="$3">{subtitle}</Text>
    <Button theme="blue" size="$4" mt="$2" self="flex-start">Shop now</Button>
  </YStack>
</YStack>

// Full-width image card in a feed
<Pressable onPress={() => router.push(`/product/${id}`)}>
  <YStack overflow="hidden" rounded="$4" mb="$3">
    <YStack height={280} bg="$color4">
      <Image source={{ uri: image }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
    </YStack>
    <YStack p="$3" gap="$1">
      <Text fontWeight="700" fontSize="$4">{name}</Text>
      <Text color="$color9" fontSize="$2">{category}</Text>
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
  <YStack height={480} overflow="hidden">
    <Image source={{ uri: hero.image }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
    <LinearGradient
      colors={['transparent', 'rgba(0,0,0,0.85)']}
      style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 260 }}
    />
    <YStack position="absolute" b={0} l={0} r={0} p="$5" gap="$3">
      <Text fontSize="$1" fontWeight="700" textTransform="uppercase" letterSpacing={2} color="rgba(255,255,255,0.7)">{hero.category}</Text>
      <H2 color="white" fontWeight="700" lineHeight={32}>{hero.title}</H2>
      <XStack gap="$3" mt="$2">
        <Button size="$4" bg="white" icon={<Play color="black" />}>
          <Button.Text color="black" fontWeight="700">Play</Button.Text>
        </Button>
        <Button size="$4" bg="rgba(255,255,255,0.2)" icon={<Plus color="white" />}>
          <Button.Text color="white">My List</Button.Text>
        </Button>
      </XStack>
    </YStack>
  </YStack>

  {/* Category rows */}
  {categories.map((cat) => (
    <YStack key={cat.id} gap="$3" mb="$5">
      <Text fontSize="$4" fontWeight="700" px="$4" color="$color12">{cat.title}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
        {cat.items.map((item, i) => (
          <Animated.View key={item.id} entering={FadeIn.delay(i * 30)}>
            <Pressable onPress={() => router.push(`/watch/${item.id}`)}>
              <YStack width={120} gap="$1">
                <YStack height={180} bg="$color4" rounded="$3" overflow="hidden"
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
<YStack flex={1}>
  {/* Full-screen map underneath */}
  <MapView style={{ flex: 1 }} region={region} showsUserLocation>
    <Marker coordinate={driverLocation}>
      <YStack width={36} height={36} rounded={18} bg="$blue10" items="center" justify="center"
        boxShadow="0 2px 8px rgba(0, 0, 0, 0.12)">
        <Car size={18} color="white" />
      </YStack>
    </Marker>
    <Marker coordinate={destination} />
  </MapView>

  {/* Status sheet — snaps between 30% (status) and 65% (details) */}
  <Sheet open modal={false} snapPoints={[30, 65]} defaultOpen>
    <Sheet.Frame bg="$background" pt="$3">
      <YStack width={40} height={4} bg="$color5" rounded={2} self="center" mb="$4" />

      {/* Animated status row */}
      <XStack px="$5" items="center" gap="$4" mb="$4">
        <YStack width={48} height={48} rounded={24} bg="$color3" items="center" justify="center" overflow="hidden">
          <Image source={{ uri: driver.avatar }} style={{ width: 48, height: 48 }} />
        </YStack>
        <YStack flex={1}>
          <Animated.Text entering={FadeInUp.duration(300)}>
            <Text fontWeight="700" fontSize="$5">{statusLabel}</Text>
          </Animated.Text>
          <Text color="$color9" fontSize="$3">{driver.name} · {driver.vehicle}</Text>
        </YStack>
        {/* ETA pill — updates in real time */}
        <YStack bg="$color2" rounded="$10" px="$3" py="$1">
          <Text fontWeight="700" fontSize="$4" fontFamily="$mono">{eta} min</Text>
        </YStack>
      </XStack>

      {/* Progress steps */}
      <XStack px="$5" items="center" gap="$2">
        {steps.map((step, i) => (
          <React.Fragment key={step.id}>
            <YStack width={28} height={28} rounded={14} items="center" justify="center"
              bg={i <= currentStep ? '$blue10' : '$color3'}>
              {i < currentStep
                ? <Check size={14} color="white" />
                : <Text fontSize="$1" fontWeight="700" color={i === currentStep ? 'white' : '$color9'}>{i + 1}</Text>
              }
            </YStack>
            {i < steps.length - 1 && (
              <YStack flex={1} height={2} bg={i < currentStep ? '$blue10' : '$color3'} rounded={1} />
            )}
          </React.Fragment>
        ))}
      </XStack>

      <XStack px="$5" justify="space-between" mt="$1">
        {steps.map((step) => (
          <Text key={step.id} fontSize="$1" color="$color9" width={60} text="center">{step.label}</Text>
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
