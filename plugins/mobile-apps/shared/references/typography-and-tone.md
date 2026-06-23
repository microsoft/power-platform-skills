# Typography & Tone Reference

> **When to read this file:** Only when the plan's `## Design` section specifies a non-default font pairing or a non-Professional copy tone. If the plan says `Font: Inter (default)` and `Copy tone: Professional`, skip this file entirely.

---

## Font Pairing Catalog

Each pairing is tested in Expo/React Native with `expo-font` + Tamagui's `createFont`. Choose based on the aesthetic direction from `design-planning.md`.

### Pairing 1: Lora + Inter (Editorial)

Best for: content-heavy apps, journaling, reading, note-taking. Serif headings create warmth; sans-serif UI stays functional.

```tsx
// tamagui.config.ts
import { createFont } from 'tamagui'

const headingFont = createFont({
  family: 'Lora',
  size:          { 4: 16, 5: 20, 6: 24, 7: 28, 8: 34, 9: 42 },
  lineHeight:    { 4: 22, 5: 26, 6: 30, 7: 34, 8: 40, 9: 48 },
  weight:        { 4: '400', 6: '600', 7: '700' },
  letterSpacing: { 4: 0, 5: 0, 6: -0.3, 7: -0.5, 8: -0.7, 9: -1.0 },
})

const bodyFont = createFont({
  family: 'Inter',
  size:          { 1: 11, 2: 12, 3: 13, 4: 16, 5: 18 },
  lineHeight:    { 1: 16, 2: 18, 3: 20, 4: 24, 5: 28 },
  weight:        { 4: '400', 5: '500', 6: '600', 7: '700' },
  letterSpacing: { 1: 0.4, 2: 0.2, 3: 0, 4: 0 },
})
```

Dark mode note: Lora at weight 400 can feel thin on dark backgrounds. Use weight 600 minimum for headings in dark mode.

### Pairing 2: Nunito + Inter (Soft / Organic)

Best for: healthcare, education, wellness, consumer. Rounded letterforms feel approachable without losing professionalism.

```tsx
const headingFont = createFont({
  family: 'Nunito',
  size:          { 4: 16, 5: 20, 6: 24, 7: 28, 8: 34, 9: 42 },
  lineHeight:    { 4: 22, 5: 26, 6: 30, 7: 34, 8: 40, 9: 48 },
  weight:        { 4: '400', 6: '600', 7: '700', 8: '800' },
  letterSpacing: { 4: 0, 5: 0, 6: -0.2, 7: -0.3, 8: -0.5, 9: -0.7 },
})
```

Dark mode note: Nunito holds weight well in dark mode at 600+. No special adjustments needed.

### Pairing 3: DM Sans + DM Sans (Bold / Expressive)

Best for: e-commerce, consumer brands, marketing-forward apps. Single family, differentiated by weight. DM Sans has a geometric clarity that reads as modern.

```tsx
const headingFont = createFont({
  family: 'DMSans',
  size:          { 4: 16, 5: 20, 6: 24, 7: 28, 8: 34, 9: 42 },
  lineHeight:    { 4: 22, 5: 26, 6: 30, 7: 34, 8: 40, 9: 48 },
  weight:        { 4: '400', 6: '600', 7: '700', 8: '800' },
  letterSpacing: { 4: 0, 5: 0, 6: -0.3, 7: -0.5, 8: -0.8, 9: -1.0 },
})

// Body uses the same family — differentiate through weight only
const bodyFont = createFont({
  family: 'DMSans',
  size:          { 1: 11, 2: 12, 3: 13, 4: 16, 5: 18 },
  lineHeight:    { 1: 16, 2: 18, 3: 20, 4: 24, 5: 28 },
  weight:        { 4: '400', 5: '500', 6: '600' },
  letterSpacing: { 1: 0.3, 2: 0.1, 3: 0, 4: 0 },
})
```

### Pairing 4: Inter + JetBrains Mono (Industrial / Utilitarian)

Best for: field ops, inspections, logistics, IoT dashboards. Inter handles everything; mono for data values adds an industrial feel.

```tsx
const headingFont = createFont({
  family: 'Inter',
  size:          { 4: 16, 5: 20, 6: 24, 7: 28, 8: 34, 9: 42 },
  lineHeight:    { 4: 22, 5: 26, 6: 30, 7: 34, 8: 40, 9: 48 },
  weight:        { 4: '400', 6: '600', 7: '700', 8: '800' },
  letterSpacing: { 4: 0, 5: 0, 6: 0, 7: -0.3, 8: -0.5, 9: -0.7 },
})

const monoFont = createFont({
  family: 'JetBrainsMono',
  size:          { 1: 11, 2: 12, 3: 13, 4: 15 },
  lineHeight:    { 1: 16, 2: 18, 3: 20, 4: 22 },
  weight:        { 4: '400', 5: '500' },
  letterSpacing: { 1: 0.5, 2: 0.3, 3: 0, 4: 0 },
})
```

Use `fontFamily="$mono"` for: IDs, timestamps, coordinates, measurements, serial numbers, currency amounts.

### Pairing 5: Playfair Display + Inter (Refined / Elegant)

Best for: luxury, finance premium, hospitality. High contrast serif with dramatic thick/thin strokes signals sophistication.

```tsx
const headingFont = createFont({
  family: 'PlayfairDisplay',
  size:          { 4: 16, 5: 20, 6: 24, 7: 28, 8: 36, 9: 48 },
  lineHeight:    { 4: 22, 5: 26, 6: 30, 7: 34, 8: 42, 9: 54 },
  weight:        { 4: '400', 6: '600', 7: '700' },
  letterSpacing: { 4: 0, 5: -0.2, 6: -0.4, 7: -0.6, 8: -0.8, 9: -1.2 },
})
```

Dark mode note: Playfair's thin strokes can disappear at small sizes on dark backgrounds. Never use below `fontSize="$6"` in dark mode.

---

## Font Loading Pattern

Complete copy-paste block for `expo-font` + Tamagui wiring:

```tsx
// app/_layout.tsx
import { useFonts } from 'expo-font'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect } from 'react'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    // Replace with your chosen pairing
    Lora: require('../assets/fonts/Lora-Regular.ttf'),
    'Lora-SemiBold': require('../assets/fonts/Lora-SemiBold.ttf'),
    'Lora-Bold': require('../assets/fonts/Lora-Bold.ttf'),
  })

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync()
  }, [fontsLoaded])

  if (!fontsLoaded) return null

  return (
    <TamaguiProvider config={tamaguiConfig} defaultTheme={colorScheme}>
      {/* ... */}
    </TamaguiProvider>
  )
}
```

```tsx
// tamagui.config.ts
import { createTamagui, createFont } from 'tamagui'
import { defaultConfig } from '@tamagui/config/v4'

const headingFont = createFont({ /* from pairing above */ })
const bodyFont = createFont({ /* from pairing above */ })

const config = createTamagui({
  ...defaultConfig,
  fonts: {
    ...defaultConfig.fonts,
    heading: headingFont,
    body: bodyFont,
  },
})

export default config
```

Usage in components:

```tsx
<H3 fontFamily="$heading">Screen Title</H3>
<Text fontFamily="$body" fontSize="$3" color="$color10">Metadata label</Text>
<Paragraph fontFamily="$heading" fontSize="$5" lineHeight={28}>Body prose on detail screens</Paragraph>
```

---

## Tone Profiles

Four profiles. The plan's `## Design` section specifies which one to use. Screen-builder uses the profile to write all UI copy.

### Professional

**Voice:** Direct, clear, no personality. The app is a tool, not a companion.

**Rules:**
- Sentence case everywhere
- Buttons are verb phrases: "Save report", "Add inspection", "View details"
- No contractions in headings. Contractions OK in body text.
- Numbers: "3 items", "12 minutes", no abbreviations

### Warm

**Voice:** Encouraging, human, peer-like. The app is a helpful colleague.

**Rules:**
- Sentence case everywhere
- Contractions are welcome: "You're all set", "Here's what we found"
- Buttons use softer framing: "Add your first...", "Get started"
- Celebrate milestones briefly: "Nice work. 5 inspections this week."

### Utilitarian

**Voice:** Terse, status-focused, no fluff. Every word earns its place.

**Rules:**
- Sentence case, but prefer short fragments over full sentences
- Buttons are the shortest possible verb: "Save", "Add", "Capture", "Sync"
- Status over description: "3 pending · 1 failed" rather than "You have 3 pending items"
- Numbers and units are abbreviated: "3 items", "12 min", "2.4 km"

### Editorial

**Voice:** Calm, considered, literary. The app is a quiet space, not a productivity tool.

**Rules:**
- Sentence case everywhere. No title case except the app name.
- No exclamation marks. Ever.
- No emoji. Anywhere.
- No motivational phrasing: no "great job", no "you've got this", no streak celebrations
- Buttons as calm statements: "Begin writing", "Read again", "Open in full"
- Addresses user as peer, never coach

---

## Copy Examples by Archetype × Tone

### List Screen

| Element | Professional | Warm | Utilitarian | Editorial |
|---|---|---|---|---|
| Empty headline | No inspections yet | Ready for your first inspection? | No items | Nothing here yet |
| Empty body | Create an inspection to get started. | Tap below to begin. | — | What will you add first? |
| Empty CTA | New inspection | Create your first | Add | Begin |
| Error headline | Could not load inspections | Something went wrong | Load failed | Could not load |
| Error CTA | Try again | Try again | Retry | Try again |

### Detail Screen

| Element | Professional | Warm | Utilitarian | Editorial |
|---|---|---|---|---|
| Delete confirm title | Delete this inspection? | Delete this inspection? | Delete? | Delete this entry? |
| Delete confirm body | This cannot be undone. | This will be permanently removed. | Cannot undo. | This cannot be undone. |
| Delete confirm CTA | Delete | Delete | Delete | Delete |
| Delete cancel | Cancel | Keep it | Cancel | Cancel |

### Form Screen

| Element | Professional | Warm | Utilitarian | Editorial |
|---|---|---|---|---|
| Submit button | Save inspection | Save inspection | Save | Save |
| Cancel (dirty) title | Discard changes? | Discard your changes? | Discard? | Discard changes? |
| Cancel (dirty) body | Your unsaved changes will be lost. | You have unsaved work that will be lost. | Unsaved changes will be lost. | Changes you have made will be lost. |
| Success message | Inspection saved | Inspection saved | Saved | Saved |
| Validation error | This field is required | Please fill in this field | Required | Required |

### Empty / Onboarding Screen

| Element | Professional | Warm | Utilitarian | Editorial |
|---|---|---|---|---|
| Headline | Welcome to [App] | Welcome to [App] | [App] | [App] |
| Body | Get started by creating your first item. | Let's set up your workspace. | — | A place for your work. |
| Primary CTA | Get started | Let's go | Start | Begin |

### Search Screen

| Element | Professional | Warm | Utilitarian | Editorial |
|---|---|---|---|---|
| Placeholder | Search inspections | Search your inspections | Search | Search entries |
| No results | No results for "[query]" | We couldn't find anything for "[query]" | No matches | Nothing found |
| No results body | Try a different search term. | Try different keywords. | — | Try different words. |

---

## Industry-to-Tone Default Mapping

| Industry | Default tone | Override guidance |
|---|---|---|
| Enterprise / LOB | Professional | — |
| Productivity | Professional | — |
| Finance | Professional | Premium finance may use Editorial |
| Field / Ops | Utilitarian | — |
| Healthcare (staff) | Professional | Patient-facing apps use Warm |
| Healthcare (patient) | Warm | — |
| Education | Warm | — |
| Consumer / Retail | Warm | Premium brands may use Editorial |
| Content / Journaling | Editorial | — |
| Creative tools | Editorial | Collaborative tools may use Warm |

---

## Copy Anti-Patterns (all tones)

These rules apply regardless of tone profile:

1. **No exclamation marks in UI text.** If a sentence needs one to land, rewrite the sentence.
2. **No emoji in UI text.** Use Ionicons (`@expo/vector-icons`) instead. Not in buttons, not in empty states, not in success messages.
3. **No "Oops!" or "Uh oh!"** in error messages. State what happened directly.
4. **No "Submit" or "OK"** as button labels. Use the specific action verb: "Save", "Send", "Create", "Delete".
5. **No "Yes/No"** in confirmation dialogs. The confirm button is the action verb ("Delete"), the cancel button is "Cancel".
6. **No apologetic errors.** Not "Sorry, something went wrong." State the problem and offer the action: "Could not save. Try again."
7. **No passive voice in CTAs.** "Create inspection" not "An inspection can be created."
8. **No ALL CAPS for emphasis.** Use font weight or color hierarchy instead. ALL CAPS is only for tracked label text (letter-spacing 0.08em+).
9. **No placeholder text as the only label.** Every input has a `<Label>` above it. Placeholder is supplementary.
10. **No engineer-facing strings.** No error codes, UUIDs, or stack traces in user-visible text.
