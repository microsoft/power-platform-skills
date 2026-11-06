# CREATE Mutations and Persistence

Use only approved sources/capabilities, including disclosed mocks approved at the normal CREATE approval step. Mock collection writes are local behavior, not backend integration. This module owns initialization/restoration, lifecycle identity, mutation guards and visible outcomes; use `${PLUGIN_ROOT}/references/CreateConformance.md` for inspection and repair.

## Initialization and restoration

The coordinator establishes typed sources/state before screen dispatch. Define a local collection's schema before Clear or LoadData; undefined names or untyped Blank seeds do not establish record shape. A temporary schema seed must be distinguishable from real records and removed without deleting restored user data.

Use compact meaningful approved demo data (roughly 5-8 rows per collection), stable IDs and explicit types within the disclosed scope. Read-only literals may use named formulas. Preserve approved real-source bindings; do not indiscriminately replace them. Navigation must not reseed user-owned data.

`LoadData(collection, key, true)` tolerates a missing saved file, not every storage/runtime failure. Explicitly handle restore errors and availability, connecting retry/recovery to real operations. Confirm the intended player's SaveData/LoadData support before claiming durability.

Memory lasts only for the app session. SaveData is local to its supported app/device/player context, not backend storage, cross-device synchronization or universal per-user identity. Keep demonstration-user and persistence limitations truthful.

## Stable target and live inputs

`QACHK-LIFECYCLE-IDENTITY`: create assigns/captures a unique stable ID. Edit, delete and transitions use the selected/row's raw typed ID to resolve the current canonical record. Reject missing targets, not fall back to the first row. Never reconstruct keys from display text, position, prefixes/suffixes, case changes or trimming unless the documented schema genuinely requires that representation.

Trace the SAME identity through selection, prepopulation, guards, mutation lookup and observer. Where explicit selection is required, keep a reachable incomplete state; a control's automatic first selection is not evidence of user choice. Apply `${PLUGIN_ROOT}/references/CreateSelectionControls.md` for actual default/reset semantics.

Guard current eligibility and inputs in the event as well as the UI. Read live values before mutation, inline or through a reachable input/selector event that updates staging state. App.OnStart/OnVisible seeds, an assignment after Patch or a stale copied old value cannot supply live operands. Trace every staged key, amount, changed value and branch condition, including delayed/focus-out outputs.

For partial updates, omit untouched fields or preserve their exact canonical pre-state values. Do not replace them with defaults, display text or stale selections. Review/status actions write the same status field that filters and observers read.

## Successful operation and visible result

`QACHK-MUTATION-OUTCOME`: sequence error-dependent work with supported success/error semantics. Semicolon-separated actions are not a transaction. Failure must not produce success navigation, input reset or a success receipt.

Capture the actual returned record/ID (for example Patch result or Form.LastSubmit), a fresh canonical lookup by that ID, or the pre-delete snapshot BEFORE reset/navigation. Bind a persistent, readable, in-viewport result to the captured identity, action and changed fields. It stays until dismissal or the next mutation; Notify, pre-submit inputs or an unlocated changed row are insufficient.

For create/edit, show each user-written/selected field, plus requested changed status, as labeled unambiguous dynamic values from the actual result. Check every handler write against the approved action and every preserved lifecycle-significant field against a current post-state observer. A receipt cannot claim preservation from a parallel collection or stale ThisItem. Internal initialization does not need a user-facing receipt.

The requested list/detail/dashboard must show the same result and stable ID. If it reads a cache, projection or external query, update/refresh it on the successful path before showing destination evidence. For multi-record destinations, select/filter/highlight/open by ID, not display name or position. Shared derivation and navigation-context rules live in `${PLUGIN_ROOT}/references/CreateNavigationState.md`.

Feedback asserting current inclusion/eligibility must track canonical membership or be invalidated by later changes. Returning after removal cannot show "Added" beside "Not included" and an enabled Add action. Label historical receipts as historical.

## Persistence failure

For optimistic local Collect/Remove followed by SaveData, restore captured local state on save failure or expose an explicit approved unsaved state. Do not report "not added" with the row still included, or "still included" after removal. Persisted state may be uncertain; do not claim it is known. A failed restore must not unconditionally set availability true. Recovery retries the real operation without erasing user data.

## Edit, confirmation and continuation

Requested edit needs a visible entry, complete prepopulation of the chosen record, stable-ID save and preservation of untouched values. Cancel leaves canonical data unchanged and clears only appropriate pending/edit state. Shared create/edit forms intentionally reset their mode and inputs after success.

Confirmation captures and identifies its pending target; changing selection or leaving the flow must not later apply it to another record. For platform dialogs, read only **Platform confirmation with Confirm** in `${PLUGIN_ROOT}/references/PowerFxGuide.md`. Confirm is a behavior function, not a control; do not build an overlay merely to obtain a dialog. Discovery chooses a feasible platform dialog, custom overlay, adjacent inline replacement or dedicated step; conformance checks placement and focus.

When successful create feeds a later edit/delete/relationship/transition, carry its returned stable ID into that reachable continuation. Clear continuation ID/mode after downstream success or non-mutating cancellation; failed operations may retain context for retry. Do not impose continuation machinery on create-only flows.

## Opposing and arithmetic actions

Keep both requested directions reachable. Approve and Reject/Decline belong together for each eligible pending record, in its row or immediately reachable detail. Separate direct actions may each own a complete guard and handler.

When the approved flow instead uses an operation selector and shared submit, selectors only set operation/selection/UI state. ONE distinct guarded event consumes that operation state and mutates. Reject direct mutations beside a dead shared gate. Reset stale operation/selection state on the appropriate entry or success path, not just App.OnStart; the state actually consumed must match the state shown and gated.

Each direction has explicit allowed-value guards. Blank, stale or unknown operation must fail closed, never fall through to an else/default direction. Required selector, amount, submit and validation remain visible in no-selection/no-operation/nonpositive states; disable invalid submit rather than hiding the form. It must also become enabled and reachable for valid values.

Reject blank, invalid and nonpositive amounts in both directions with visible validation. Inspect Default, Min, Value, ValidationState and Reset together: `Min: =1` cannot support a claimed zero-input path, and reset to a positive default is not invalid-state evidence. Use supported blank semantics or an explicit invalid zero default with `Min <= 0`; always guard both blank and `<= 0`. Choice commitment and empty-selection behavior follow the selection module.

For arithmetic, bind labeled operation, old value, live amount, expected new value and actual result. Substitute the same old/amount values into both branches: increase is `old + amount`, decrease is `old - amount`. Then trace a same-record sequence such as 10 -> receive 3 -> 13 -> issue 2 -> 11; the second old value comes from the updated canonical source. Destination evidence shows the same actual value.

For limits, derive count and eligibility from the same canonical source/predicate. Show the current count, limit and rejection reason near the action. Admit the last permitted operation and reject the next without mutation, guarding both UI and handler. Missing/invalid targets, duplicate attempts, failed saves, cancellations and retries need truthful outcomes. Static traces do not prove server writes or local durability.
