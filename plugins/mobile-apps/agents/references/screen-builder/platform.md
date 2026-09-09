# Platform recipes — read only the relevant section

## Native chrome and insets

Honor the foreground's navigator and approved screen header. Large-title/search is an
optional iOS tab-root recipe, not a requirement for every list. Use `Stack.Screen`
options only where supported; Android/web need a usable equivalent, not an iOS-only
dependency. Custom/compact header/search is valid when approved.

When native collapsing chrome is chosen, use automatic content inset adjustment.
Do not also add the same header/safe-area padding manually. Floating actions clear
actual tab/home-indicator insets; shared `BottomActionBar` already handles its bottom
inset. Verify every state. Set StatusBar contrast when the top surface changes.
Never set parent-only tab options on a child stack or edit a layout to hide chrome.

## Keyboard, back, and dates

Editable screens keep fields/actions visible via appropriate keyboard avoidance and
scrolling. Dirty Android hardware back uses a focused listener; a real navigator
removal guard must also handle iOS header/swipe-back when needed. Do not claim a
Cancel dialog protects every exit. If disabling conflicting horizontal back gestures,
retain a visible usable back path and change only the assigned screen options.

Date fields use allowlisted `@react-native-community/datetimepicker` on supported
native platforms; respect Android date/time modes rather than forcing iOS-only
`datetime`. Respect dismissal without changing values. Use a verified web fallback
when web is targeted. Calendar-management libraries are not date-input substitutes.
Do not hand-roll a Sheet calendar or parse an unlabeled date string. See mutations
reference for DateOnly vs DateTime serialization.

## Gestures

Only when the spec requests swipe-delete, long-press selection, or contextual menus,
read the relevant recipe in `shared/references/mobile-gesture-recipes.md`.
Destructive swipe reveals a separate confirmed action; never delete on swipe release.
Long-press is never the only primary action; provide a discoverable/accessibility path.

Verify `GestureHandlerRootView` in `app/_layout.tsx` for gesture-handler primitives.
If missing, return `BLOCKED: foreground must add GestureHandlerRootView`; **never**
fix the root from a builder. The same boundary applies to connectivity/provider wiring.

## Motion and accessibility

Approved `motion: none` or OS reduced motion disables entering/exiting/layout animation,
scale, springs, parallax, and bounce. Static visual feedback remains required.
Other policies permit only matching purposeful feedback, not every available effect.
Do not import Reanimated just to animate a list that was approved as motion-free.

Use platform-correct labels/roles, large-text layout, focus and screen-reader status
feedback. For uncertain semantics read only relevant sections of
`shared/references/accessibility-checklist.md`; validate props against installed types,
never cast accessibility attributes to `any` to suppress incompatibility.
