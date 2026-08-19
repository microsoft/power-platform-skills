# UX Quality Bar

Build an operational mobile product, not a generic dashboard or component gallery.

## Expo And Tamagui First

- Inventory the live `package.json` before designing. Prefer a shipped Expo or Tamagui capability over custom infrastructure, but include it only when it improves an approved user task.
- Use Expo Router for typed file-based routes, stacks/tabs/modals, deep links, and navigation state. Keep business routes inside the existing protected route group.
- Use Tamagui tokens, themes, stacks, text, controls, responsive props, `styled()` variants, animation props, and platform/media adaptations before raw `StyleSheet` values or duplicate primitives.
- Use the configured Tamagui animation driver and Reanimated for a few meaningful transitions: hierarchy changes, state changes, progress, confirmation, and spatial continuity. Respect reduced-motion preferences and avoid motion that delays repeated work.
- Use portal-based sheets, dialogs, popovers, tooltips, and toasts when the interaction calls for an overlay. Verify required provider wiring; never create a second Tamagui root provider.
- Use Expo modules already installed for platform work rather than browser APIs or hand-written native bridges. Keep module calls behind typed wrappers when they touch permissions, hardware, files, identity, or platform differences.
- Do not feature-stuff. Every framework capability in the plan must name the user problem it solves, fallback behavior, and validation level.

## Shipped Experience Surface

Reconcile this list with the live package before use:

- navigation and system: Expo Router, Linking, Web Browser, Status Bar, System UI, Splash Screen, Screen Orientation, Keep Awake;
- imagery and media: Expo Image, Asset, Font, Camera/barcode scanning, Image Picker, Image Manipulator, Media Library, Audio, Video;
- files and output: Document Picker, File System, Sharing, Print, Mail Composer, Clipboard;
- trust and context: Secure Store, Local Authentication, Crypto, Application, Device, Constants, Location, Cellular, NetInfo;
- interaction foundation: Gesture Handler, Reanimated, Safe Area Context, React Native Screens, date/time picker, checkbox, Burnt notifications;
- application foundation: React Query, React Hook Form, Zod, Async Storage, Material Community Icons;
- Tamagui composition: themes/tokens, `XStack`/`YStack`, typography, buttons and fields, cards/list items, tabs, sheets, dialogs/alerts, popovers/tooltips, avatars, progress/spinners, separators, portals, and toasts when exported and configured by the installed version.

Capabilities absent from the live package are unavailable for the wrapped binary unless separately approved and proven compatible.

## Workflow Design

- Optimize for the primary repeated task and its real environment: one-handed use, field glare, interruptions, gloves, weak connectivity, or dense office review as applicable.
- Put the next meaningful action where users expect it. Avoid explanatory landing pages.
- Use progressive disclosure: lists for scanning, details for context, focused forms for action.
- Preserve draft input across recoverable failures and accidental navigation where practical.
- Confirm destructive or irreversible actions and show the affected record.

## Visual Direction

- Treat supplied screenshots as evidence of desired quality and composition, not as a template to copy. Extract hierarchy, palette proportions, typography contrast, whitespace, image treatment, section transitions, control geometry, persistent actions, and emotional tone; record what to adopt, adapt, and avoid.
- Derive typography, palette, density, imagery, and motion from the business domain and brand inputs.
- Build a purposeful multi-color semantic palette with clear surface, text, action, status, focus, and data-visualization roles. Vibrant means confident contrast and useful emphasis, not saturated color everywhere.
- Establish a clear dominant/contrast/accent color ratio and a recognizable compositional signature. A disciplined two-surface composition with sparse accent color often feels more premium than many weakly differentiated colors.
- Build hierarchy with scale, whitespace, alignment, image crop, and full-width surface transitions before adding cards, borders, shadows, or decoration.
- Give each primary screen one task-relevant visual anchor. Examples include an image-led context panel, editorial summary, compact status band, scan-friendly record row, master-detail workspace, or integrated total/action dock.
- Use real product, record, place, or workflow imagery where it helps recognition. Prefer Expo Image for app imagery and define loading, failure, aspect-ratio, caching, and accessibility behavior.
- Avoid default blue/purple SaaS styling, oversized hero copy, decorative card grids, nested cards, and ornamental gradients.
- Reject repeated equal cards, icon-in-circle tile walls, excessive pills, weak gray-on-white hierarchy, arbitrary gradients, placeholder metrics, and uniform spacing without visual rhythm.
- Use restrained cards only for repeated records or genuinely framed tools.
- Use icons for familiar actions and labels or tooltips where meaning is not obvious.
- Keep card radius at 8px or less unless the approved brand system says otherwise.
- Use stable dimensions and responsive constraints so dynamic text and states do not shift core controls.
- Do not scale type from viewport width or use negative letter spacing.
- Use Tamagui theme tokens instead of repeated literals. Define component variants for semantic differences rather than branching style objects throughout screens.

Dense operational screens remain calm and scan-efficient. Increase useful information through aligned columns/scan lanes, compact readable rows, pinned identity/status/action fields, grouping, separators, progressive disclosure, and responsive master-detail composition. Do not create density by shrinking body text, touch targets, focus indicators, form help/errors, or spacing until adjacent controls become hard to distinguish. Reserve large display type and spacious editorial composition for true focal moments, not routine tool panels.

## Typography And Localization

- Prefer the existing or platform system family for familiarity, coverage, and performance unless a custom family materially strengthens the approved brand concept. Use at most one display family and one body family unless the existing brand system requires otherwise. Define display, heading, title, body, label, and caption roles with exact weights and line heights.
- Keep body text generally at least 16 logical pixels, secondary text at least 14, and captions at least 12 unless a verified existing system provides an accessible alternative. Use body line height around 1.3-1.5 and heading line height around 1.1-1.3.
- Do not disable font scaling. Use `maxFontSizeMultiplier` only for a documented fixed-format constraint, and reflow content rather than clipping it.
- Load custom fonts through the existing Expo approach, define deterministic fallbacks and supported weights, and keep dependent routes in a real loading state until fonts are ready.
- Define supported locales and use the app's established internationalization boundary for complete messages, plurals, dates, times, numbers, currency, and relative time. Do not concatenate translatable fragments.
- Test realistic long translations and plural forms. Preserve hierarchy, control labels, badges, forms, lists, overlays, and screen-reader order.

Reusable components carry repeated behavior, accessibility, state, and layout invariants. They do not replace page design. Compose each screen deliberately from primitives plus a small number of meaningful components; reject uniform padded stacks, default-control walls, generic card/row assembly, and abstractions that flatten distinct focal points or edge-to-edge sections. A shared screen shell is the exception: it must consistently own safe-area edges, keyboard behavior, scrolling/list mode, responsive gutters, and footer spacing.

Rendered quality is mandatory. Stage 2 inspects primary screens at thumbnail scale, in grayscale, and at compact mobile width with realistic long content. App Builder renders the complete app only after all screens and workflows are assembled, then inspects every route on a compact device with real top/bottom system insets plus representative increased-text and wide/tablet viewports. Medium and expanded layouts remain specified in Markdown until that gate. Revise weak hierarchy, excessive containers, timid imagery, awkward crops, generic controls, unsafe content, and detached sticky elements before acceptance. Type-check, source inspection, or a user waiver cannot substitute for App Builder's rendered visual/safe-area evidence.

## Rich Interaction

- Give every user action immediate feedback through pressed/disabled states, progress, inline validation, toast/banner confirmation, or navigation outcome as appropriate.
- Use sheets for focused mobile choices, dialogs for blocking decisions, popovers/tooltips for contextual help, and full routes for sustained tasks. Do not use every overlay type interchangeably.
- Prefer skeletons that preserve final geometry, optimistic updates only when rollback is clear, and pull-to-refresh or retry where freshness matters.
- Use gestures only when discoverable and paired with an accessible visible action. Never make swipe the sole path to a destructive or required command.
- Resolve gesture conflicts explicitly among navigation back, horizontal browsing, swipe actions, vertical scrolling, sheet dragging, selection, and media zoom. Prefer one primary gesture per region and provide visible single-pointer alternatives for drag, swipe, pinch, multipoint, or device-motion interactions.
- Preserve state across orientation, keyboard, picker, permission, and external-app round trips when the workflow requires it.

Choose overlays by intent:

- Sheet: mobile-first choice list, compact form, filter, or focused tool that benefits from retained page context.
- Dialog: short blocking decision or information requiring acknowledgement.
- AlertDialog: destructive or irreversible confirmation naming the affected record and consequence.
- Popover/menu: contextual actions anchored to a visible trigger; Tooltip: supplemental meaning, never required instructions.
- Toast or Burnt: transient non-blocking confirmation. Use inline banner/error when the message must persist or contains a recovery action; provide a web-safe fallback when native feedback differs.

## Required States

Every data-driven screen specifies and implements:

- initial loading or skeleton;
- content;
- empty state with a relevant action;
- recoverable error with retry;
- offline/unavailable state when required;
- permission denial when a native capability is used;
- disabled/submitting/success behavior for mutations.

## Forms

- Map data to controls deliberately: Switch for immediate booleans; Checkbox for acknowledged or multi-select values; segmented control/Tabs for 2-4 short mutually exclusive modes; Sheet/Select/menu for longer or 5+ choices; native date/time picker for dates and times; numeric input with bounds for quantities; multiline input for notes.
- Label every field, identify required fields, and place errors next to the source.
- Specify each field's input purpose, keyboard type, capitalization/correction behavior, `autoComplete` and native autofill semantics, and sensitive-data handling. Preserve paste and password-manager support; use platform one-time-code semantics where applicable.
- Validate on submit and after a visited field changes; do not punish untouched fields.
- Keep the primary action reachable with the keyboard open.
- Prevent duplicate submission and explain save failures without clearing input.
- Use React Hook Form for form lifecycle and Zod for shared typed validation. Convert domain/server validation into field or form errors without coupling reusable controls to repositories.
- Authentication forms must allow password managers and paste, avoid puzzle/memory barriers where possible, and provide an accessible alternative for biometric, one-time-code, timeout, reauthentication, or cognitive checks. Associate errors with fields, announce them, and move focus only when it helps recovery.

## Icons And Feedback

- Use icon plus label for primary, destructive, mode-changing, or unfamiliar actions. Icon-only is reserved for universally familiar compact actions and still requires an accessibility label and 44-point target.
- Use Material Community Icons consistently by semantic role and size. Do not mix icon families or use color as the only status signal.
- Choose one feedback channel per outcome: inline for field/context errors, banner for persistent screen status, toast/Burnt for transient confirmation, progress for ongoing work, and dialog only when the workflow must stop.

## Accessibility And Mobile Fit

- Target applicable WCAG 2.2 Level AA criteria in design and implementation. Do not claim conformance until applicable automated checks and manual keyboard, screen-reader, zoom/text-scaling, contrast, target-size, error, motion, and status-message checks pass.
- Maintain readable contrast and respect dynamic text where supported.
- Use at least 44x44 point touch targets.
- Provide accessibility labels for icon-only actions.
- Keep text inside its container at narrow and wide phone widths.
- Respect safe areas and avoid overlap with keyboards, status bars, tab bars, and notches.
- Assign exactly one safe-area owner per edge. A hidden native header does not protect the top inset; ordinary padding is not a safe-area strategy; a bottom dock that owns the home-indicator inset must not be nested inside another bottom-inset owner.
- Do not encode status by color alone.
- Respect reduced motion, screen-reader focus order, and platform font scaling. Test compact phone, wide phone, and tablet layouts rather than treating web width as mobile responsiveness.
- Verify text contrast at WCAG AA (normally 4.5:1), non-text controls/focus indicators at 3:1, logical keyboard/screen-reader order, announced labels/roles/states, and visible focus on web.
- Define announcement priority and timing for loading, result counts, validation, errors, progress, and success. On web, use the appropriate live-region semantics without repeating every visual change or unexpectedly moving focus.
- Test at increased text size and with reduced motion enabled in the web renderer. Record native-only behavior as `not-run` unless the user supplies separate wrapped-device evidence.

## Media And Rights

- Prefer user-provided or bundled assets for brand-critical and offline-required imagery. Record source, license/rights, replacement status, attribution surface, crop/focal point, aspect ratio, loading/failure/offline behavior, caching, and accessibility for every meaningful asset.
- Temporary Unsplash photography uses a specific stable `images.unsplash.com` URL and visible photographer/Unsplash credit. Dynamic discovery uses the official API with credentials outside source control and preserves required attribution.
- Give meaningful images contextual alternatives and suppress decorative images. Provide captions/transcripts for introduced audio or video and audio description or an equivalent text alternative when important visual information is otherwise unavailable.

## Performance And Platform Fit

- Use Expo Image for image-heavy surfaces, React Native virtualized lists for long collections, stable keys, pagination, and bounded media dimensions.
- Keep expensive transformations out of render paths and avoid storing large media payloads in React state; persist file URIs or domain references instead.
- Model network reachability as context, not proof that a backend is available. React Query owns server-state freshness/retry; repositories own domain semantics.
- Distinguish web behavior from user-supplied wrapped-device evidence. Never infer that a web bundle validates permissions, native modules, broker auth, offline sync, or other on-device behavior, and never launch a simulator or dev client to fill that gap.
- Validate compact-height and keyboard-open layouts, landscape, split-screen, resizable web windows, and relevant foldable hinge/occlusion constraints. Controls, overlays, and fixed actions must remain reachable without horizontal scrolling for ordinary reading.
- Use React Query keys, stale times, retry rules, cancellation, invalidation, and optimistic rollback intentionally. Do not duplicate server state into Async Storage or component state.
- Use Async Storage only for non-sensitive local preferences/drafts with versioned serialization; use Secure Store only for sensitive device-local values. Neither replaces domain repositories or Dataverse offline sync.

## Review Checklist

Before mock acceptance, verify:

1. a user can complete each promised workflow;
2. navigation has no dead ends;
3. primary actions are visible and unambiguous;
4. realistic long text does not overlap or truncate critical content;
5. loading, empty, error, and validation states are reachable;
6. lists support the required scan/filter/search pattern;
7. all screen copy uses domain language;
8. touch targets, contrast, keyboard, and safe areas are usable;
9. the visual system is consistent without making every section a card;
10. the experience remains useful when Dataverse is unavailable because mock mode is selectable.
11. Expo/Tamagui capabilities used by the app are justified, configured, and tested at the claimed platform level;
12. motion, imagery, feedback, and semantic color make the app rich without reducing task speed or accessibility.