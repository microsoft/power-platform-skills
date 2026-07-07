# Accessibility Checklist

Run this on every screen before marking it done.

## Must-have

- [ ] `SafeAreaView` wraps the screen content
- [ ] Every icon-only `Pressable`/`Button` has `accessibilityLabel="..."`
- [ ] Every interactive element has `accessibilityRole` (`button`, `link`, `header`, `tab`, `switch`, etc.)
- [ ] Toggles use `accessibilityState={{ selected: true/false }}` or `{ checked }`
- [ ] Touch targets ≥ 44×44 pt (iOS) / 48dp (Android) — use `hitSlop` if visual is smaller
- [ ] Text contrast ≥ 4.5:1 (body) / 3:1 (large text) against background
- [ ] Inactive tabs, metadata, helper text, picker icons, and modal body copy use readable tokens (`$color10` or stronger), not faint decorative tokens (`$color8` or weaker)
- [ ] Yellow/orange badges do not use white text unless contrast has been measured; use a light tint plus dark status text by default
- [ ] Never rely on color alone — pair with icon or text
- [ ] Dynamic type supported (do NOT set `allowFontScaling={false}`)
- [ ] Layout works at the largest system text size; text can wrap/truncate intentionally without overlapping controls
- [ ] Focus order matches visual order (don't set `importantForAccessibility` unless needed)
- [ ] Keyboard-accessible (inputs reachable via next/prev)
- [ ] Loading state announces (`AccessibilityInfo.announceForAccessibility('Loading')`)
- [ ] Error messages are associated with their input (via label or aria-describedby equivalent)

## Tamagui-specific a11y

Tamagui's `Button` and `Input` get a11y roles for free. BUT — if you build a custom pressable out of `XStack` or `Stack`, you MUST add:

```tsx
<XStack
  pressStyle={{ opacity: 0.7 }}
  accessibilityRole="button"
  accessibilityLabel="Open recipe details"
  onPress={handlePress}
  hitSlop={8}
>
```

For icon-only buttons:
```tsx
<Button
  size="$3"
  circular
  icon={Heart}
  accessibilityLabel="Favorite"
  accessibilityState={{ selected: isFavorite }}
  onPress={toggle}
/>
```

## Testing

- Turn on **VoiceOver (iOS)** or **TalkBack (Android)** at least once per screen
- Swipe through — can you understand what each element does?
- Try with system text size at largest — does the layout break?
- Check a small phone width and a large phone width — do safe areas, bottom actions, and long labels still fit?
- Toggle dark mode — is anything unreadable?

## Forms specifically

- Each input has a visible `<Label>` — placeholder doesn't count
- Use the correct mobile input hints (`keyboardType`, `inputMode`, `autoComplete`, `textContentType`, `returnKeyType`) for the field type
- Errors are announced when they appear
- Required fields marked (text, not just asterisk)
- Submit button label changes to reflect state ("Save" → "Saving…")
- Validation, network failure, app backgrounding, and cancel confirmation never wipe user-entered values

## Lists specifically

- `accessibilityRole="list"` on the container
- `accessibilityRole="listitem"` on each item (or rely on FlatList defaults)
- Row actions have their own labels distinct from the row itself

## Navigation specifically

- Screen titles are real headings — Expo Router's `options.title` handles this
- Back buttons auto-label ("Back to Recipes") — don't override unless necessary
- Tab bar labels visible, not icon-only (or provide `accessibilityLabel`)

## What users with disabilities actually complain about (fix these first)

1. Icon-only buttons with no label (top complaint)
2. Text that doesn't scale with system size
3. Low contrast secondary text (grey on white)
4. Modal dismissal not announced
5. Form errors that appear silently
6. Tap targets < 44pt
7. Color-only status indicators (green/red dots with no text)
