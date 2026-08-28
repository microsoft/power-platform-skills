# Disclosure and Validation Patterns

## 18. Progressive Disclosure

Used for: health records, finance details, any sensitive or complex data that benefits from tap-to-reveal layers.

```tsx
// Expandable section — collapsed by default
function DisclosureSection({ title, subtitle, children }) {
  const [expanded, setExpanded] = React.useState(false)

  return (
    <YStack bg="$color2" rounded="$4" overflow="hidden">
      <Pressable onPress={() => setExpanded(!expanded)}>
        <XStack items="center" p="$4" gap="$3">
          <YStack flex={1}>
            <Text fontWeight="600">{title}</Text>
            {!expanded && subtitle && <Text fontSize="$2" color="$color9">{subtitle}</Text>}
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
      <Text fontSize="$2" fontWeight="600" color="$color9">{label}</Text>
      <XStack items="center" bg="$color3" rounded="$3" px="$3"
        borderWidth={result ? 2 : 0}
        borderColor={result?.valid ? '$green8' : result ? '$red8' : 'transparent'}>
        <Input flex={1} value={value}
          onChange={event => onChange(event.target?.value ?? event.nativeEvent?.text ?? '')}
          onBlur={() => setTouched(true)}
          bg="transparent" borderWidth={0} />
        {result?.valid && <CheckCircle2 size={18} color="$green10" />}
        {result && !result.valid && <AlertCircle size={18} color="$red10" />}
      </XStack>
      {result?.valid && successMessage && (
        <Text fontSize="$1" color="$green10">{successMessage}</Text>
      )}
      {result && !result.valid && (
        <Text fontSize="$1" color="$red10">{result.message}</Text>
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
<XStack gap="$2" bg="$color2" rounded="$4" p="$1">
  {['light', 'dark', 'oled'].map((t) => (
    <Button key={t} flex={1} size="$3"
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
    <YStack flex={1}>
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

<YStack flex={1} items="center" justify="center" p="$5" gap="$4">
  <EmptyCartIllustration width={200} height={160} color="$color6" />
  <H4 fontWeight="700" text="center">Your cart is empty</H4>
  <Paragraph color="$color9" text="center" px="$4">
    Browse our collection to find something you love.
  </Paragraph>
  <Button theme="blue" size="$4" icon={ShoppingBag} onPress={() => router.push('/shop')}>
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
