# Phone app data and native authoring

When the foreground supplies the phone/local-data profile, use its actual
`src/data` model, repository, hook and media interfaces instead of inventing
`src/generated` services. These repositories persist real local records and
throw on failures; they are not `IOperationResult` connector envelopes or
screen-owned mock arrays. Preserve their read/write/rule behavior.
The local provider supplies Tamagui and local React Query contexts. Use
Tamagui's `useTheme` or a verified local presentation helper, not host-only
auth/theme hooks requiring a connected `PowerAppsProvider`.

For sample photos reuse generated `PrototypeImage` with a useful stable
`aspectRatio` and `creditDisplay="compact"`. Keep credits outside parent
navigation pressables; see [media guidance](../../../shared/references/prototype-images.md)
for bundling, provenance and error states. Do not create a screen-owned image
catalogue, hide attribution completely, or add an unshipped native image package.

Keep main's task-specific composition, typography, media proportions and state
handling. With HTML companions off, the first rendered review is the native
app; missing HTML is not a reason to stop, add a generic screen or run a browser.
Foreground must prepare `@/authoring`, its root provider, import aliases and
planned registry before this assignment. If that shared prerequisite is
missing, return it to foreground; do not edit providers or invent a replacement.
The caller supplies the exact source/route assignment, repository interfaces,
component signatures and supported tokens. Reuse those instead of searching
the generator implementation for public contracts.

## Required screen bindings

- Export one literal `authoringTargets` array. Each entry has a stable `id`,
  human `label`, supported `role`, and optional `actionId`; no spreads or
  runtime-generated metadata. Use only actual useful regions.
- Prefer one `AuthoringScreen` wrapping **all** loading, error, missing and
  populated returns. Set `screenId` to the exact plan ID, `ready` to the
  actual usable-state expression and `hasUnsavedChanges` to real dirty/pending
  state. Hardcoded `ready={true}` is not evidence of usability.
- Mount every declared region with `AuthoringTarget targetId="..."`.
  A literal array alone does not create selectable content. Repeated records
  use the actual typed `recordRef` contract supplied by foreground.
- A scroll container beneath `AuthoringScreen` uses `useAuthoringRemeasure()`
  in a descendant component and attaches it to scroll callbacks with
  `scrollEventThrottle={16}`. Calling this hook above its provider cannot
  observe that screen. Do not move child content across the boundary later.
- Alternatively use one top-level `useAuthoringScreen(screenId, options)`
  handle, attach its `onLayout` to the real root, pass it explicitly to
  descendant targets and use its `onScroll` for scrolling. Do not mix the two
  ownership patterns or create a second registration for the same screen.

The exact runtime exports are `AuthoringScreen`, `AuthoringTarget`,
`useAuthoringScreen` and `useAuthoringRemeasure` from `@/authoring`.
The prepared configurator result includes their prop names; do not guess
`dirty`, `usable`, `id` or a different import path.

## Safe local actions without repair loops

Use a synchronous ref lock plus a visible pending state for asynchronous
mutations. The established checker recognizes an `isPending` state used
directly in the CTA's disabled expression:

```tsx
const mutationLock = useRef(false);
const [isPending, setIsPending] = useState(false);

async function submit() {
  if (mutationLock.current) return;
  mutationLock.current = true;
  setIsPending(true);
  try {
    await saveWithValidatedRecovery();
  } finally {
    mutationLock.current = false;
    setIsPending(false);
  }
}
```

This is a guard pattern, not a supplied business operation: use the actual
typed action, required error notification, validation and rollback semantics.
Bind the real button's `disabled` to `isPending` plus its eligibility rules,
show a pending label, preserve input on failure and navigate only after the
required writes succeed. Never use a catch that hides the error.
Navigation gets its own synchronous ref guard, reset on focus/failure, rather
than relying on a React state update to block two taps in the same frame.

Foreground owns registry/provider generation and the final source-bound gates.
Do not start another Metro, ask for a client registration, change the initial
screen budget or call desktop question tools.