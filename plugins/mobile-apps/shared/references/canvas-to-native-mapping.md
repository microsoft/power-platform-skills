# Canvas → Native Mapping (Intent Over Control)

Required reading for `native-app-planner`, `screen-planner`, and `screen-builder` whenever a `native-app-plan.md` is built from a Canvas/MSAPP brief. Defines **how** to translate Canvas-derived control inventories into native React Native + Tamagui + bundled-Expo primitives. Companion docs: `mobile-design-philosophy.md` (visual quality), `mobile-ui-patterns.md` (archetypes), `tamagui-component-recipes.md` (snippets).

---

## 1. The principle: intent over control

When a brief lists Canvas controls (`Label`, `Gallery`, `HtmlViewer`, …), they are **evidence of what the maker wanted to accomplish** — they are NOT a binding output spec. The screen-builder is free to (and should) pick the best native primitive for the underlying intent.

```
1. INTENT     ← what the maker was trying to accomplish (highest authority)
2. PATTERN    ← which UX pattern serves that intent best on mobile native
3. COMPONENT  ← which Tamagui/Expo primitive renders that pattern
4. CONTROL    ← the original Canvas control name (lowest authority — a hint)
```

The brief feeds in at step 4. The screen-builder works upward to step 1, then back down to step 3 with native primitives.

---

## 2. The translation hierarchy — when to follow Canvas 1:1 vs. upgrade

| Canvas control | Native target | Verdict | Why |
|---|---|---|---|
| `TextInput` | Tamagui `<Input>` | ✅ 1:1 | Same intent, same primitive |
| `Button` | Tamagui `<Button>` | ✅ 1:1 | Same |
| `Toggle` | Tamagui `<Switch>` | ✅ 1:1 | Same intent |
| `Checkbox` | `expo-checkbox` `<Checkbox>` | ✅ 1:1 | Same |
| `Gallery` | RN `<FlatList>` / `<SectionList>` | ✅ 1:1 | Scrollable list of records; virtualized |
| `Form` / `TypedDataCard` | `react-hook-form` + zod + Tamagui inputs | ✅ 1:1 | Multi-field record edit |
| `DatePicker` | `@react-native-community/datetimepicker` | ✅ 1:1 | Native picker is better |
| `BarcodeReader` | `expo-camera <CameraView barcodeScannerSettings>` | ✅ 1:1 | Same |
| `Camera` | `expo-camera` | ✅ 1:1 | Same |
| `ComboBox` / `DropDown` | Tamagui `<Sheet>` + `<FlatList>` | ✅ 1:1 | Same |
| **`HtmlViewer` / `WebView`** | **Tamagui composition OR `expo-print → PDF`** | ⚠️ **UPGRADE** | `react-native-webview` is NOT bundled; HTML was a Canvas escape hatch, not a need (see §3) |
| **Pixel-positioned controls** (X=234, Y=567) | **Flex / stack composition** | ⚠️ **UPGRADE** | Phone widths vary — pixel coords are a layout antipattern on mobile |
| **30 stacked `Label`s mimicking a receipt** | **`<Card>` with `<XStack>` rows** | ⚠️ **UPGRADE** | Canvas workaround for no rich-text → native composition |
| **`PDF Viewer` control** | **`/add-native pdf-viewer` for an existing HTTPS URL when `@microsoft/power-apps-native-pdf-viewer` is allowlisted; otherwise `expo-web-browser`/PDF report flow** | ⚠️ **UPGRADE** | `react-native-pdf` is not bundled; preserve URL/generation intent and choose the current allowlisted path |
| **`RichTextEditor` control** | **Tamagui `<TextArea>` + bundled formatting buttons** (or accept plain text round-trip) | ⚠️ **UPGRADE** | No bundled rich-text RN library; renegotiate the field |
| **3rd-party PCF controls** | **Manual rebuild as native component** | ❌ **REBUILD** | PCF cannot be hosted in the rewrap runtime at all |
| `Audio` | `expo-audio` `useAudioPlayer` | ✅ 1:1 | Same |
| `Video` | `expo-video` `useVideoPlayer` + `<VideoView>` | ✅ 1:1 | Same |
| `Rating` (1–5 stars) | Custom `<XStack>` of `<Pressable>` star icons | ✅ 1:1 | Cheap to compose |
| Pen / signature | `/add-native pen-input` when `@microsoft/power-apps-native-pen-input` is allowlisted | ⚠️ HOST | If the native package is absent, report a blocker/review item rather than installing another signature library |
| Push notifications | `burnt` for in-app toast | ⚠️ DEGRADE | `expo-notifications` not in rewrap runtime — cross-device push requires server-side flow |

### PCF disposition rule

PCF is never copied, hosted in a WebView, or invoked through HostingSDK. `pcf-plan.json` Gate 2b must give every PCF one explicit user-approved outcome:

1. **Native replacement** — exact built-in or already-allowlisted primitive; preserve public inputs, outputs, events, data bindings, validation, and authorization semantics.
2. **Server dependency** — retain/rebind the connector, flow, Custom API, or Dataverse operation in the target, then rebuild the UI natively over its generated service.
3. **Explicit unsupported** — optional PCFs only, with user-approved visible unavailable-state copy. A hidden TODO is invalid.
4. **Blocker** — essential behavior is hidden/unknown, its backend/specification is missing, or no supported native strategy exists. Stop generation for the affected app path.

Extractor replacement hints are evidence, not approval. An arbitrary third-party React Native package is never a valid automatic replacement because the rewrap runtime is prebuilt.

---

## 3. The HTML escape-hatch problem (most common upgrade case)

Power Apps Canvas ships an **HTML Text control** because the built-in `Label` cannot do mixed formatting, the `DataTable` cannot do styled rows, no list control exists, and email templates are stored as HTML strings in Dataverse. Makers reach for HTML as a shortcut — not because Canvas lacks the underlying capability.

On React Native, this same shortcut becomes expensive (`react-native-webview` is a heavyweight native module and is **deliberately excluded** from the template). But the native side has **better primitives** for the underlying intent:

| Canvas HTML use-case | Native answer |
|---|---|
| Styled summary block (bold word, colored word, mixed font weight) | Tamagui `<Card>` with `<H3>` / `<Paragraph>` / themed `<Text>` segments |
| Tabular data with row striping / cell colors | `<FlatList>` of `<XStack>` rows, `bg="$color2"` on alternating rows |
| Bullet / numbered list | `<YStack>` of `<XStack gap="$2"><Text>•</Text><Paragraph>…</Paragraph></XStack>` |
| Receipt / invoice layout (line items + totals) | `<Card>` with `<XStack>` rows + `<Separator>` + totals block. For "download receipt": `expo-print.printToFileAsync({ html })` → `expo-sharing.shareAsync(uri)` produces a real PDF |
| Email-template preview | Either: (a) Tamagui mock of the email layout; (b) `expo-print` → local PDF for `expo-sharing` or Dataverse upload. Do not pass the local URI to an HTTPS viewer. |
| Rich text from a Dataverse rich-text column | Strip HTML to plain text and render in `<Paragraph>`. For round-trip editability, prompt the maker to renegotiate the column to plain text. |
| External URL embed | `expo-web-browser.openBrowserAsync(url)` (opens in system browser; does NOT inline) |

**Bottom line for HTML:** treat every `HtmlViewer` as a sign that the maker hit a Canvas limitation, then pick the native primitive that solves the *underlying* intent. The migration is usually an upgrade, not a downgrade.

---

## 4. The rule of thumb

> **If the Canvas control exists because Canvas needed a workaround, replace it.**
> **If the Canvas control exists because it's the right UX, keep it (with the native primitive).**

Examples:
- HTML control → workaround → **replace** with Tamagui card / `expo-print`
- 30 stacked `Label`s mimicking a list → workaround → **replace** with `FlatList`
- Pixel-positioned controls → workaround → **replace** with flex / stack
- `Gallery` to show a scrollable list → right UX → **keep** (becomes `FlatList`)
- `Form` to capture user input → right UX → **keep** (becomes `react-hook-form`)
- `BarcodeReader` → right UX → **keep** (becomes `expo-camera`)

---

## 5. Reading `upgradeHints[]` from the adapter

When the adapter (`scripts/adapt-app-brief-for-mobile-plugin.js`) detects a known anti-pattern, it emits two things per affected screen:

1. **In `native-app-plan.md` → per-screen plan file** → a `## Upgrade Hints` section listing each anti-pattern, its native target, and a one-line rationale.
2. **In `mobile-plugin-input.json` → per-screen entry** → an `upgradeHints[]` array:
   ```jsonc
   {
     "screenName": "OrderProductRecap",
     "upgradeHints": [
       {
         "antiPattern": "html-preview-of-receipt",
         "canvasControls": ["HtmlViewer_orderRecap"],
         "recommendedNative": "tamagui-card-plus-expo-print",
         "rationale": "Canvas HTML was a layout shortcut; native: <Card> with line items + 'Share PDF' via expo-print.",
         "severity": "medium"
       }
     ]
   }
   ```

The screen-builder MUST read both the `## Upgrade Hints` section in its plan file AND this section of the reference doc. If a screen has `upgradeHints[]`, the builder follows them by default. To override an upgrade hint, add an inline `// UPGRADE-OVERRIDE: <reason>` comment above the relevant TSX block so the next reviewer knows why.

---

## 6. What NOT to upgrade

The risk of going too far the other way is rewriting the app's information architecture under the guise of "upgrade". The screen graph (which screens exist, what they navigate to) and the data model (which tables, which columns) MUST stay 1:1.

| Allowed | Not allowed |
|---|---|
| ✅ Replace a control with a better native equivalent | ❌ Merge two screens into one because "it'd be cleaner" |
| ✅ Restructure a screen's layout (pixel → flex) | ❌ Drop a Dataverse table because "we could compute it client-side" |
| ✅ Convert a Canvas formula chain into typed hook calls | ❌ Rename navigation routes (breaks deep links) |
| ✅ Replace `Set()` globals with React Query + zustand | ❌ Drop a connector "because we don't need it" |
| ✅ Add loading skeletons / error states the source lacked | ❌ Remove a screen the maker designed (even if empty) |

Upgrades are **per-control inside a screen**. Architecture stays 1:1.

---

## 7. Quick decision flow for builders

```
For each Canvas control in your screen's spec:

  1. Is the control in §2 with verdict "1:1"?
       → Use the native target listed. Done.

  2. Is the control in §2 with verdict "UPGRADE" or "REBUILD"?
       → Apply the upgrade per §3 (HTML) or §4 (general rule).
       → If the adapter emitted an `upgradeHints[]` entry, follow it verbatim.

  3. Is the control NOT in §2?
       → Default to Tamagui primitive composition.
       → If the control implies a bundled Expo module, check `template/package.json` first.
       → If no bundled native option exists, raise a [medium] risk and STOP for guidance.

  4. NEVER add an unbundled native RN library (e.g. react-native-webview,
     react-native-pdf, @shopify/flash-list). The rewrap binary is prebuilt
     and cannot load new native modules.
```
