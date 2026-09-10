# Platform recipes — read only the relevant section

## Native chrome and insets

Aim for polished, context-appropriate native design, not merely a functional screen.
An earlier accepted preview is the **minimum presentation baseline**, not permission
to simplify away its typography, icon/label/selected navigation, header hierarchy, or
repeated-item alignment. Adapt the geometry to native insets, available width, and
larger text while preserving those approved relationships. Treat lost fidelity as a
regression to fix and verify, not as an unavoidable implementation variation.

Honor the foreground's navigator and approved screen header. Large-title/search is an
optional iOS tab-root recipe, not a requirement for every list. Use `Stack.Screen`
options only where supported; Android/web need a usable equivalent, not an iOS-only
dependency. Custom/compact header/search is valid when approved.

Before implementation, assign **one owner per edge/obstruction**: top status/header,
left/right cutouts, scroll-body spacing, bottom home indicator, tab bar, and any action
footer. Safe-area inset, navigator height, and ordinary content padding are different
quantities; do not sum them twice or treat a hardcoded spacer as any of them.

| Composition | Top owner | Bottom owner | Scroll body |
|---|---|---|---|
| Custom header, exposed bottom, no footer | Outer `SafeAreaView` top/left/right | Same outer view bottom | `flex: 1`, explicit content padding; no automatic inset |
| Custom header + in-flow action footer | Outer view top/left/right | `BottomActionBar` default | Flexible sibling before footer; no footer-height spacer |
| Custom header inside non-overlay tabs | Outer view top/left/right | Tab navigator | No outer bottom inset; any `BottomActionBar` uses `includeBottomInset={false}` |
| Native opaque header + in-flow tabs | Navigator header | Navigator tabs | No duplicate top/bottom safe area; protect left/right as needed |
| Native translucent/collapsing chrome | Navigator + supported automatic adjustment | Navigator/automatic adjustment per configuration | No manual compensation for the same chrome |

`ScreenHeader` intentionally owns **no** safe-area edges. `BottomActionBar` is an
in-flow, non-shrinking sibling with a 20dp design gap plus the bottom safe-area inset by
default; `includeBottomInset={false}` removes only that inset, not ordinary padding.
This preserves existing callers and lets a parent/tab own bottom without double
spacing. Do not place a default footer inside an outer `edges={['bottom', ...]}`.
See [detail.md](detail.md#header-body-and-optional-decision-footer) for a complete typed
footer/read-only example and [navigation.md](navigation.md#one-coherent-header) for
the compact header and foreground tab wiring.

When native collapsing chrome is chosen, use supported automatic content inset
adjustment rather than the explicit custom-header pattern. For explicit safe-area
ownership, disable automatic content/scroll-indicator adjustment on that scroll view
to avoid a second application of the same inset.

Floating/absolute chrome is an exception, only when approved. Reserve its **measured**
occluded height in both the body's trailing space and scroll-indicator inset. Use
the navigator's actual tab-bar height for overlay tabs; it commonly already includes
the bottom safe area, so never add that inset again. A screen inside normal-flow tabs
already ends above the tab bar. Do not add a tab-height spacer there. A FAB must clear
its containing viewport's actual obstruction; the existing shared FAB's raw
bottom-inset offset is not evidence that it avoids every overlay/tab configuration.

Verify every state, small and wide viewports, larger system text, and keyboard-visible
forms: back/title/action stay coherent; body's last item is reachable; footer and tab
labels/icons are not hidden; gaps are not doubled. On iOS/Android or device evidence,
check safe-area and navigator geometry rather than claiming a web preview proves it.
Set StatusBar contrast when the top surface changes.
Never set parent-only tab options on a child stack or edit a layout to hide chrome.

Correct insets alone do not prove good composition. Measure the remaining scroll
viewport after the header, footer and tabs, and compare short and long content.
Avoid pinning item counts, repeated notices and a large summary above another full
navigation bar. The optional `CompactActionBar` keeps a summary/action row with a
48px-minimum button; larger text wraps instead of being clamped.

For horizontal filters, the scroll viewport must fit its padded children as well as
the touch targets. Reuse `FilterChipRow`: nonshrinking viewport, 48px-minimum
auto-height controls, and vertical padding (56px minimum strip, not a fixed height).
Check native measurement and large/localized labels; `overflow: visible` or a smaller
touch target is not a repair for a clipped scroll container.

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
