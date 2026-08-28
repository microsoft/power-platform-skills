# Form, Create, Edit, Capture, and Workflow-Step Screens

## Composition

- Form/modal chrome uses Back/Cancel plus a clear title; the primary submit or
  step action belongs in a bottom-reachable action area.
- Order controls by the user's decision sequence, not schema order.
- Prefer choice/date/toggle/picker controls over free text when the data type
  permits.
- Show validation beside the field and preserve every valid value after errors.
- Disabled primary actions show one short reason nearby.
- Multi-step workflows show progress and preserve a local draft.

## Save behavior

- Use `?editId=` for create-or-edit mode.
- Check generated service results and keep the busy lock active until the
  result is known.
- Normal success returns with `router.back()`.
- Generate the primary ID before create only when immediate follow-up work
  needs it.
- Do not pop/replace after failed save.
- Dirty short forms confirm cancel/back; long forms offer resume/discard.

## Capture/workflow evidence

- Permission and hardware failure are designed states.
- Camera evidence has a visible Take picture action.
- Scanner callbacks are locked and reset on focus; manual entry uses the same
  mutation path.
- Review/sign-off screens keep required evidence, unresolved blockers, and the
  approval consequence visible together.

## Native feel

Use `KeyboardAvoidingView` on iOS, bottom safe-area spacing, reachable controls,
dynamic type, and specific action labels such as `Save inspection` or
`Complete review`.
