# Mobile UX Boundaries

Non-negotiable native platform constraints. The AI controls the aesthetic, layout, and composition choices; these hardware, framework, and accessibility boundaries are strict.

## 1. Native Interaction Boundaries

- Primary actions → bottom of screen (easy thumb reach). Destructive → harder to reach + confirm.
- Touch targets: minimum 44x44pt. Use `hitSlop` on small elements.
- Swipe actions: always provide a visible button alternative.

## 2. Input Ergonomics + Safe Areas

- Reduce typing with native pickers, steppers, segmented controls, camera/scan, location, and lookup rows before asking for free text.
- Dates use native date/time pickers. Long text uses `TextArea`.
- **Safe Area Handling:** All screens must handle top and bottom insets using `SafeAreaView` or `useSafeAreaInsets`. Do not let native status bars or the home indicator clip the bottom actions or top headers.

## 3. Loading, Empty & Error States

- **Loading:** Skeleton shapes matching real content layout — never centered spinner.
- **Empty:** Icon + title + subtitle + CTA button. Centered. MUST support pull-to-refresh.
- **Error:** Inline, actionable. Raw error strings (`e.message`) go to `console.error`; show a friendly message to the user.

## 4. Hardware Independence

- Do not assume constant network connection.
- Hardware back-button (Android) MUST map to in-app cancel or modal dismiss; never trap the user or drop unsaved form data without prompting.

## 5. Idempotent Data Path

- Network fetches MUST map to `useFocusEffect` (re-fetched when screen is navigated back to) or React Query `enabled` blocks. Never use raw `useEffect` with empty brackets for initial data load.
- Submit actions MUST block double-taps programmatically (`isSubmitting` state or React Query `isPending`).
- Primary CTA must show visual spinner/loader context when processing an async action.
