# Typography and Tone

Read only for typography or copy decisions. Use the actual reading/scanning task, content, language, stakes, and supported fonts—not an industry-to-font/tone lookup.

## Choose roles and hierarchy

Define only useful roles: heading/title, body, caption/metadata, and data/mono where needed. Choose family, weight, size, line-height, tracking, and a Tamagui binding for each. Preserve text scaling and wrapping; dense information must not mean small unreadable labels or clipped dynamic text.

- Prose needs comfortable line length and rhythm; comparison may benefit from tabular numerals.
- Monospace is useful for code/identifiers/aligned measurements, not mandatory for every currency or timestamp.
- A supported serif/display face can help long-form content or identity; one well-chosen family can also provide strong hierarchy. Neither font pairing nor “Inter everywhere” is a requirement.
- Catalog examples such as Lora, Nunito, DM Sans, JetBrains Mono, and Playfair are optional inspiration, not evidence those assets are installed.

## Availability and native binding

Inspect existing `tamagui.config.ts`, host font defaults, `package.json`, font assets, and loading. Reuse available fonts. For a custom face, record the approved local asset paths, licenses, loaded family names/weights, and fallback. Do not install an unapproved native package or assume `@tamagui/font-*` is present.

`brand/tokens.ts` typography fields are data until config/screens consume them. Use [Tamagui integration](../../skills/design-system/references/tamagui-integration.md) to bind roles; preserve host fonts not being customized, especially `mono`. Do not replace the whole config or add another provider.

Brand role units:
- `size`: native logical units.
- `lineHeight`: ratio; native `createFont.lineHeight` uses `size × ratio`.
- `tracking`: em; native `letterSpacing` uses `size × tracking`.
- HTML uses the equivalent CSS values and actual configured family/weight. Do not silently map a title to the browser's default `<h2>` size.

For local fonts with `expo-font` already supported by the template, merge loading into the existing root; never replace the root/auth/provider tree:

```tsx
const [fontsLoaded, fontError] = useFonts({
  'Approved-Regular': require('../assets/fonts/Approved-Regular.ttf'),
  'Approved-SemiBold': require('../assets/fonts/Approved-SemiBold.ttf'),
});

useEffect(() => {
  if (fontsLoaded || fontError) SplashScreen.hideAsync();
}, [fontsLoaded, fontError]);
```

Use this only with real assets. Pair it with the existing splash lifecycle; do not add `expo-splash-screen` if unsupported. Handle loading failure with a visible/reportable fallback instead of an infinite blank screen. Configure `createFont.face` for weight-specific loaded family names (including italic only when available); family and fontWeight alone do not prove the correct native face exists.

## Tone as a task decision

Choose the tone from context and user preference; these are examples, not required profiles:

| Need | Voice and example |
|---|---|
| High-stakes / efficient action | Direct: “Review 2 exceptions”, “Save report” |
| Guidance for unfamiliar work | Supportive: “Add a photo to show the issue” |
| Repeated expert workflow | Compact but specific: “Capture”, “Retry upload” |
| Reading / reflection | Calm: “Continue reading”, “Start a note” |

Copy should expose the decision and next action. Keep terminology and record names consistent across the journey. Avoid generated hype, fake urgency, invented milestones, and repetitive reassurance.

## State and action copy

- Use specific action verbs instead of ambiguous “OK” or “Submit”. Confirmation names the operation and its consequences; cancellation preserves the user's choice.
- Distinguish saved, pending local change, queued upload, and failure. Never imply sync/save succeeded from a browser mock or an unresolved native action.
- Errors state the problem, whether work was retained, and an available next action. Do not expose raw stack traces, UUIDs, or service internals.
- Empty and zero-result states explain what is absent and offer a meaningful next action. Avoid filling every empty state with a decorative illustration.
- Inputs need persistent accessible labels; placeholders are supplementary. Critical status uses text as well as color.
- Sentence case and restrained punctuation are generally helpful, but brand voice is not a decorative pass/fail test. Icons must support comprehension and have accessible names where interactive.

## Preview checks

Use approved local fonts when browser-readable; otherwise disclose the actual fallback. No remote Google Fonts import to create fidelity the native app cannot reproduce. Verify representative role values, weights, line breaks, text zoom, and the same scenario terminology across intent and source-derived implementation previews.
