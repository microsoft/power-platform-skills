---
name: design-react-native-app
description: Design and implement polished React Native application interfaces. Use when the user asks to create, redesign, style, or improve screens, components, navigation, visual systems, or user experiences for a React Native or Expo app.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion
model: opus
---

# Design React Native App

Create a cohesive, accessible, and production-ready design for a React Native application. Implement the design in the user's project when one is available.

## Reference-contract mode

Before choosing a new visual direction, look for native-app-plan.md,
design-intake.md, and brand/design-system.md in the project. If the plan
contains a Reference Contract or the intake declares high or
strict-structural fidelity:

1. Read those artifacts before editing a screen.
2. Treat hierarchy, normalized geometry, media prominence, navigation
   silhouette, Required Motifs, Runtime Markers, and Forbidden Drift as
   binding.
3. Preserve the approved Home composition. Polish spacing, typography,
   accessibility, state feedback, and responsive behavior only; do not invent
   a new composition.
4. Keep every required Runtime Marker as the exact testID on its owning
   screen or shared component.
5. Use original local/bundled media and a local fallback when the intake
   requires offline or in-flight use. Do not replace it with remote Unsplash
   imagery.

For a reference-led travel-retail Home, do not introduce a generic search
field, product grid, ratings, discount badges, payment UI, sign-in, airline
operations dashboard, or extra metrics unless the Reference Contract explicitly
allows it. If the brief and the contract conflict, stop and ask for direction;
do not silently average them.

## Experience-contract mode

Before changing a planned mobile app, read `native-app-plan.md`,
`.tmp/experience-contract.json`, `.tmp/experience-screen-contract.json`,
`.tmp/experience-foundation-contract.json`, `.tmp/screen-build-pack.json`, and
`brand/design-system.md` when they exist. Validate the pack first with
`validate-screen-build-pack.js`; use its revision, primary/key-flow entries,
states, dependencies, primitives, `shell`, `headerMode`, canonical stable-ID
domain records/hooks, local asset manifest, and forbidden defaults as the compact
execution source. The experience contract is required
for generated create/prototype projects even when there is no screenshot or
design intake.

For the primary screen, preserve all of these as hard requirements:

- `entryMode` and `primaryScreen.compositionKind`
- the primary user outcome and first-viewport focal point
- exact first-viewport region order and visible primary action
- signature motifs, forbidden defaults, and `experience-*` testID anchors
- foundation primitive imports/files selected for each signature motif

You may repair hierarchy, spacing, density, typography, contrast, state
feedback, tap targets, and the clarity of the focal point. You must not replace the entry mode, turn discovery/capture/workflow/inbox/detail-first into a dashboard or generic List, reorder the contract regions, or replace a named
motif with an unrelated generic component. A binding Reference Contract remains
the higher-priority override where it explicitly conflicts with generated
experience details.

Route shell and data integrity remain binding during refinement:

- Keep the root layout as `SafeAreaProvider` context only. Each packed route
   uses exactly one `ScreenShell` with its literal packed `headerMode`; do not
   add a nested `SafeAreaView` or automatic scroll-content insets.
- Preserve `@/data` hooks as the presentation boundary. Lists, details, saves,
  and carts use canonical domain `id`, never index-based copy or a title as an
  identifier. Do not import fixtures, repositories, or generated services.
- When `assetPolicy.media` is `local-first`, preserve the generated local
   illustration recipe via `resolveDomainMedia` and `EntityImage`. Do not add a
   remote URL, Unsplash source, or generic icon-only media replacement.
- When `assetPolicy.media` is `remote-cdn-cached`, preserve
   `resolveDomainMedia(record.media)` -> `EntityImage` with its cache key and local
  fallback identity. Do not replace it with a screen-local URL, a generic icon
  block, or a strong accent-color media rectangle.
- Treat `primaryAction.placement` as runtime structure. For `sticky-bottom`,
  preserve `ScreenShell scroll={false}`, explicit scrollable content, and a
  sibling `BottomActionBar` that owns the contracted action. Never move that
  action into scroll content during visual polish.
- Preserve every first-viewport region marker and the work-order order. When a
  media-bearing region shares that viewport, keep responsive aspect-ratio
  sizing and do not add `minH`/`minHeight`; actual fit is verified by native
  captures rather than inferred from source pixels.
- Preserve canonical currency formatting. Do not replace a shared
  amount-plus-currency-code formatter with a visually convenient literal
  currency symbol during refinement.

After edits, run:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-contract.js" \
   --project-root "<working_dir>" \
   --phase build
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-shells.js" \
   --project-root "<working_dir>" \
   --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-media.js" \
   --project-root "<working_dir>" \
   --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-screen-composition.js" \
   --project-root "<working_dir>" \
   --pack ".tmp/screen-build-pack.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-mobile-app.js" \
   --project-root "<working_dir>" \
   --scope screens
```

### Native visual-review receipt

When a real iOS/Android capture environment is available, create or update
`.tmp/experience-visual-review.json` with `schemaVersion: 1`, the primary route,
the sidecar-declared `keyFlowRoute`, normal- and large-text native captures for
both routes, iOS/Android platform/device metadata, and evidence-backed checks for `focalPoint`, `regionOrder`,
`primaryAction`, `taskFit`, `contentRealism`, `signatureMotifs`,
`forbiddenDefaults`, `contrast`, `touchTargets`, `safeAreas`, `keyboard`,
`offlineState`, `screenReaderOrder`, `responsiveLayout`, and
`localizedContent`. Every check scopes `primary` and `key-flow`, names its
reviewed capture IDs, and links to a native observation; a not-applicable check
requires a reason and observation evidence. Validate it:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-experience-visual-evidence.js" \
   --project-root "<working_dir>" \
   --manifest ".tmp/experience-visual-review.json"
```

Static HTML and browser previews are not native capture evidence. When native
capture is unavailable, return `DONE_WITH_CONCERNS: native experience visual capture unavailable; hierarchy and anchors were statically validated.` Do not
claim the visual review is complete.

## Understand the request

Use requirements already supplied by the user. Determine:

- The app's purpose and target audience.
- The screens or user flow to design.
- Required content, actions, and states.
- Any brand colors, typography, assets, or reference designs.
- The target platforms: Android, iOS, web, or all three.

If essential product direction is missing and multiple substantially different designs would be reasonable, ask one focused question at a time. Otherwise, make sensible assumptions and proceed.

## Confirm the design direction

Before generating or implementing the design, confirm the user's preferred visual direction unless a Product Experience Contract, binding Reference Contract, or explicit brand direction already provides it. With an experience contract, use its `visualCharacter`, audience, interaction mode, density, focal point, and motifs as the direction; do not ask a generic style picker that could conflict with the approved composition. Ask one question at a time only when a real contradiction remains.

- **Minimal & Clean** — restrained color, generous whitespace, simple surfaces, and quiet typography.
- **Bold & Vibrant** — saturated color, strong contrast, expressive type, and energetic visual accents.
- **Dark & Moody** — dark surfaces, atmospheric imagery, subtle depth, and focused highlights.
- **Warm & Organic** — earthy color, soft shapes, natural imagery, and approachable typography.

Recommend the option that best fits the app's purpose, while allowing the user to choose another direction or describe a custom style.

When not already specified, ask up to two additional focused questions that materially affect the design, such as:

- Whether to use existing brand colors, propose a new palette, or stay mostly neutral.
- Whether the interface should feel compact, balanced, or spacious.
- Whether to emphasize Unsplash photography, icons and illustrations, or minimal imagery.
- Whether accessibility, platform conventions, or visual expressiveness should take priority when tradeoffs arise.
- For apps targeting both iOS and Android, whether to use a strongly unified branded experience, platform-native styling, or a balanced hybrid.

Do not repeat questions answered in the request. Once the direction is clear, summarize the selected style in one sentence and proceed without requesting approval for routine implementation details.

## Inspect the project

When working in an existing project:

- Read `package.json`, the app entry point, navigation setup, theme files, and relevant screens or components.
- Reuse the existing framework, component library, navigation solution, assets, and coding conventions.
- Preserve existing behavior unless the user requests a change.
- Do not replace working project configuration or add dependencies solely for minor visual effects.

If no project exists, provide a concrete screen specification and reusable React Native component code.

## Establish the visual direction

Choose a clear visual concept appropriate to the product instead of producing a generic starter interface. Define a small design system before implementing:

- Color roles for background, surface, text, muted text, border, primary action, success, warning, and error.
- A consistent spacing scale.
- Typography roles for display, headings, body, labels, and captions.
- Corner radius, border, shadow, and elevation conventions.
- Interaction states such as pressed, focused, selected, disabled, loading, empty, and error.

Prefer reusable theme tokens over repeated literal values. Respect the existing brand and design system when present.

## Choose typography

Create a deliberate, readable type system that supports the selected visual direction.

- Prefer the platform system font for native familiarity and performance unless the brand or concept benefits meaningfully from a custom typeface.
- Use no more than one display family and one body family. Choose fonts with the required weights, characters, and language coverage.
- Establish semantic tokens for display, heading, title, body, label, and caption styles rather than styling text independently in each component.
- Build hierarchy with size, weight, line height, color, and spacing. Avoid relying on font size alone or using many similar text styles.
- Keep body text generally at least 16 logical pixels, secondary text at least 14, and captions at least 12 unless the existing design system specifies accessible alternatives.
- Use comfortable line heights: approximately 1.3–1.5 times the font size for body text and 1.1–1.3 for headings.
- Use letter spacing sparingly. Slightly increase it for small uppercase labels, but avoid wide tracking on paragraphs or long headings.
- Do not disable font scaling. Ensure important text can grow without clipping, overlapping, or hiding controls; use `maxFontSizeMultiplier` only when a genuine layout constraint requires it.
- When adding custom fonts, use the project's existing font-loading approach, include a loading state, and verify the correct font-family names and weights on Android, iOS, and web.
- Test hierarchy with realistic long titles, multiline content, numeric values, and localized text rather than only short English samples.

## Create platform-aware visual polish

Create one coherent product identity while respecting how people expect iOS and Android apps to look and behave. Avoid both a generic template appearance and unnecessary platform divergence.

- Establish a recognizable visual signature through composition, typography, color, imagery, shape, and motion. Use one or two memorable motifs consistently rather than decorating every surface.
- Give each screen a clear focal point and visual rhythm. Balance dense functional areas with breathing room, align content deliberately, and remove decoration that competes with the primary task.
- Use layered surfaces, imagery, gradients, blur, shadows, and elevation selectively to clarify hierarchy. Verify that effects remain legible, performant, and convincing in light and dark themes.
- Prefer high-quality content and realistic data. Empty placeholder cards and repeated generic copy make otherwise polished layouts feel unfinished.
- Preserve a shared brand system across platforms, then adapt navigation, controls, feedback, spacing, and transitions where native expectations differ.
- On iOS, respect safe areas, navigation stacks, swipe-back behavior, tab bars, sheets, keyboard conventions, system typography and colors, and restrained depth or haptic feedback.
- On Android, support edge-to-edge layouts, system bars, predictive back, Material-style navigation and surfaces where appropriate, ripple or state-layer feedback, elevation, and contextual floating actions.
- Use native-feeling pickers, switches, dialogs, menus, date or time controls, permission flows, and text inputs rather than forcing one platform's control conventions onto the other.
- Choose a coherent icon family. Use platform-specific directional or system icons when they improve familiarity, but keep brand and feature icons visually consistent.
- Integrate status bars, navigation bars, home indicators, notches, cutouts, keyboards, and safe-area changes into the composition rather than treating them as afterthoughts.
- Add meaningful press feedback, transitions, haptics, and micro-animations only when they reinforce an action or state change. Keep interactions responsive and respect reduced-motion and haptic preferences.
- Support light, dark, and increased-contrast appearances when required by the product. Use semantic theme tokens rather than simply inverting colors.

Before calling a design polished, review complete screen compositions rather than isolated components. Compare representative iOS and Android screens side by side for hierarchy, spacing, alignment, content quality, native behavior, and brand consistency.

## Meet WCAG 2.2 AA

Target WCAG 2.2 Level AA by default. Apply the criteria to React Native Web and use the equivalent platform accessibility behavior for native Android and iOS.

- Maintain a contrast ratio of at least 4.5:1 for normal text and 3:1 for large text as defined by WCAG. Require at least 3:1 contrast for meaningful icons, control boundaries, selected states, and other essential non-text visuals.
- Do not use color, position, shape, motion, or sound as the only way to communicate meaning. Pair them with text, icons, patterns, or accessible state announcements.
- Give every interactive element an accurate accessible name, role, value, and state. Keep labels concise and ensure visible labels match accessible names.
- Preserve a logical reading and focus order. On web, support complete keyboard operation with a clearly visible focus indicator that is not obscured by sticky content, dialogs, or overlays.
- Keep touch targets at least 44 by 44 logical pixels where practical, exceeding the WCAG 2.2 minimum target-size requirement, and leave enough space between adjacent actions.
- Provide single-pointer alternatives for dragging, swiping, multipoint gestures, or device-motion interactions unless the gesture is essential.
- Associate form instructions and errors with their controls. Identify errors in text, suggest corrections when known, and move or announce focus appropriately after failed submission.
- Announce loading, success, validation, and error updates through the platform accessibility API without unexpectedly moving focus.
- Support text resizing and font scaling without loss of content or functionality. Reflow narrow layouts, avoid fixed text containers, and do not require horizontal scrolling for ordinary reading.
- Respect reduced-motion preferences. Avoid flashing content, provide controls for non-essential animation, and do not make time limits essential without warning and extension controls.
- For authentication, allow password managers and paste, avoid memory or puzzle tests where possible, and provide an accessible alternative when a cognitive-function test is required.
- Give meaningful images useful alternative text and decorative images no accessible announcement. Provide captions or transcripts when audio or video content is introduced.

Accessibility is not guaranteed by implementation conventions alone. Do not claim WCAG 2.2 AA conformance unless the relevant screens and states have been tested against the applicable success criteria.

## Use modern interaction patterns intentionally

Evaluate the following patterns for each relevant screen, but use only those that improve the user's task. Do not add every pattern to every app or trade clarity, performance, accessibility, or native conventions for novelty.

- **Bottom sheets:** Use for focused mobile actions, filters, previews, or short workflows. Support safe areas, keyboard avoidance, drag and close affordances, accessible focus handling, and a dialog or popover treatment on larger form factors when appropriate.
- **Rich cards with contextual actions:** Combine useful content, status, and a small set of relevant actions. Keep the primary action obvious, avoid ambiguous nested press targets, and provide accessible action names.
- **Horizontal carousels:** Use for genuinely related, browsable content such as featured items or categories. Reveal that more content exists, preserve scroll position, support touch and keyboard navigation, and avoid auto-advancing content.
- **Smart search with suggestions:** Provide debounced suggestions, recent or popular searches when useful, highlighted matches, clear empty and error states, keyboard controls on web, and accessible result-count announcements.
- **Personalized recommendations:** Group recommendations under a clear heading, explain why they are relevant when appropriate, allow dismissal or refinement, and provide a useful non-personalized fallback.
- **Skeleton loading states:** Match the final layout to reduce movement, avoid implying unavailable content, respect reduced-motion settings, and announce loading without exposing every skeleton element to screen readers.
- **Swipe gestures:** Use for efficient secondary actions such as archive or dismiss. Always provide a visible, non-gesture alternative, support undo for destructive actions, and avoid conflicts with navigation or scrolling.
- **Floating contextual actions:** Show only high-priority actions relevant to the current screen or selection. Keep them reachable, labeled or readily understandable, clear of content and system controls, and responsive to the keyboard and safe areas.
- **AI assistant panels:** Use when conversational or generative assistance solves a real task. Clearly distinguish generated content, show loading and failure states, preserve user control, provide dismiss and retry actions, and avoid blocking the primary workflow.
- **Smooth micro-animations:** Use short, purposeful transitions to explain state and spatial relationships. Prefer the project's existing animation solution, keep animations interruptible, avoid layout jank, and provide reduced-motion behavior.
- **Progress indicators:** Use determinate progress when completion can be measured and indeterminate progress otherwise. Pair visual indicators with a text label or accessible value and do not fabricate precision.
- **Context-aware quick actions:** Derive actions from the current item, selection, permissions, and workflow state. Keep them predictable, prevent unavailable actions, and make important actions discoverable outside overflow menus.

Implement each selected pattern as a reusable component when it appears more than once. Reuse the project's established libraries and primitives; do not add a dependency solely to reproduce a small interaction that core React Native components can handle clearly.

## Implement the design

Build complete screens and flows rather than disconnected decorative elements.

- Use core React Native components and the project's existing libraries.
- Extract reusable components when patterns repeat.
- Use `StyleSheet.create` or the styling system already used by the project.
- Account for safe areas, the keyboard, scrolling, small screens, and dynamic content.
- Use platform-specific behavior only when it improves the native experience.
- Keep touch targets at least 44 by 44 logical pixels where practical.
- Add accessibility labels, roles, states, and hints where the visible content is insufficient.
- Maintain readable contrast and support font scaling without clipping important content.
- Include meaningful loading, empty, validation, error, disabled, and pressed states when relevant.
- Avoid excessive gradients, shadows, animation, or decoration that reduces clarity.

## Use Unsplash imagery

When photography would improve the design and the user has not supplied suitable assets, use contextually relevant images from Unsplash instead of generic placeholder graphics.

- Choose specific, stable `images.unsplash.com` image URLs so the design is deterministic. Do not use random-image or redirect endpoints.
- Request an appropriately sized image by preserving the URL parameters returned by Unsplash and adding supported transformations such as `auto=format`, `fit=crop`, `w`, and `q`.
- Match each image to the content and intended aspect ratio; do not use unrelated photography merely to fill space.
- Render remote images with an explicit size or aspect ratio and an appropriate `resizeMode` so layouts do not jump or distort.
- Provide a loading treatment and a local visual fallback for failed or offline image requests.
- Add accessible descriptions for meaningful images. Mark purely decorative images as inaccessible to assistive technology.
- Credit the photographer and Unsplash in a visible details, credits, or about surface, with links when the platform supports them.

For a production experience that searches or changes images dynamically, use the official Unsplash API. Keep credentials out of source control, use the image URLs returned by the API directly, preserve required attribution, and follow the Unsplash API guidelines. Never expose an Unsplash secret key in the application.

Use bundled or user-provided assets when imagery must work fully offline, is brand-critical, or cannot be licensed appropriately. When an Experience Contract says `assetPolicy.media: local-first`, this is mandatory: preserve local recipes/assets and do not introduce Unsplash imagery. Clearly identify any temporary Unsplash image the user should replace before release.

## Handle responsive layouts

Design for phones, tablets, foldables, resizable windows, and web viewports as applicable. Adapt from available window dimensions and content needs rather than device names or one reference screen.

- Avoid hard-coded screen widths, heights, and device-specific pixel offsets. Use flex layout, percentages, aspect ratios, minimum and maximum constraints, and safe-area insets.
- Use `useWindowDimensions` or the project's responsive utilities so layouts update after rotation, resizing, split-screen changes, and foldable posture changes.
- Choose a small number of content-driven breakpoints. Prefer fluid layouts between breakpoints instead of creating a separate design for every device class.
- Constrain readable content on wide screens rather than stretching text and forms edge to edge. Use additional space for supporting panels, grids, or navigation only when it improves the flow.
- Allow one-column phone layouts to become multi-column, master-detail, or persistent-navigation layouts on larger form factors without changing task order or hiding functionality.
- Adapt spacing, density, typography, image sizing, and navigation patterns deliberately; do not merely scale the entire phone interface.
- Support touch, keyboard, mouse, trackpad, and hover or focus states where the target platform provides them.
- Ensure controls remain reachable and text remains readable in portrait and landscape when supported.
- Keep dialogs, menus, sheets, and keyboard-aware forms within the usable viewport at compact heights and large font scales.
- Test representative compact, medium, and expanded widths, portrait and landscape, split-screen, and a resized browser window.

## Support LTR and RTL

Build layouts that work in both left-to-right and right-to-left locales without maintaining separate screen implementations.

- Use logical `start` and `end` positioning, padding, margins, and borders instead of physical `left` and `right` where direction should mirror.
- Let text inherit the locale direction. Use automatic or direction-aware alignment and writing direction, especially for mixed-language content.
- Read the active direction from the project's internationalization setup or React Native `I18nManager`; do not infer it independently in each component.
- Mirror directional icons, progressions, transitions, charts, and gestures when their meaning depends on reading direction. Do not mirror universal symbols, media controls, brand marks, numbers, or non-directional illustrations.
- Keep icons and labels in direction-aware flex layouts rather than positioning them with fixed coordinates.
- Localize complete messages instead of concatenating fragments, since word order and punctuation can change in RTL languages.
- Ensure truncation, badges, form controls, lists, navigation, and overlays remain readable with longer translated strings and mixed bidirectional text.
- Test at least one LTR locale and one RTL locale with realistic content, large font scaling, keyboard navigation on web, and screen-reader order. Use forced RTL only for development testing, not as a production default.

## Validate

Use the project's existing scripts and run the smallest relevant checks:

- Type-check the changed code.
- Run the relevant lint or tests when configured.
- Start or build the app only when needed to verify the design, and do not leave an interactive server running unless the user asks.
- Review the implemented screens for overflow, missing states, inaccessible controls, and inconsistent tokens.
- Check color contrast, font scaling, screen-reader labels and order, keyboard navigation on web, visible focus, target sizes, form errors, reduced motion, and loading or status announcements.
- Check compact, medium, and expanded layouts plus both LTR and RTL directions for overflow, incorrect alignment, unmirrored directional elements, and unusable navigation.
- Exercise selected sheets, carousels, search suggestions, gestures, contextual actions, AI panels, animations, and progress states with touch, keyboard, screen readers, loading, empty, error, and reduced-motion conditions as applicable.
- Review representative iOS and Android screens in light and dark appearances for native navigation behavior, system-bar integration, safe areas, keyboard handling, press feedback, visual hierarchy, and consistent brand expression.

Do not claim visual verification on a simulator or device unless it was actually performed.
Do not claim WCAG 2.2 AA conformance unless both automated checks and manual checks of applicable success criteria were completed.
Do not describe a design as polished or production-ready without reviewing rendered screens on both target platforms when both are requested.

## Completion response

State:

- The visual direction implemented.
- The screens and reusable components changed or created.
- The important responsive and accessibility behavior.
- The validation result.
- Any assets or product decisions still required from the user.
