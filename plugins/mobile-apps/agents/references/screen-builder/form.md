# Forms and editable screens

Follow approved field order, actor permissions, input ergonomics, primary action,
operation, and recovery. Do not convert every entity into a generic create/edit form.

- Use installed `react-hook-form`/schema validation or the supplied typed form state.
  Preserve values on validation/server failure and background refetch. Inline errors
  identify the field and correction; disabled actions explain their prerequisites.
- Adapt `KeyboardAvoidingView` to platform and actual header inset; fields and actions
  remain scrollable/reachable with keyboard and large text. Do not force a bottom bar.
- Match controls to data: generated choice constants become Select options with
  string/number conversion only at the UI boundary; booleans use Switch; dates use
  supported native date controls (platform reference). Never guess choice integers.
  Missing choice metadata is a blocked input prerequisite, not a raw numeric editor.
- Tamagui inputs use `inputMode`, `enterKeyHint`, `autoComplete`, `onChange`, `readOnly`.
  RN controls retain native props. Labels, error associations, and accessibility roles
  must work on the actual platform; placeholder text is not a label.
- Route-driven edit uses contract `editId?: string`, normalized before reading/writing.
  Never silently create when a supplied edit ID is malformed or its read failed.
- Dirty cancel/back needs a real guard for each supported exit (header, gesture,
  Android hardware back). A Cancel dialog alone does not guard iOS swipe-back.
  Reuse a supplied navigation-removal guard; report missing shared support to foreground.
  Long/multi-step draft persistence only when approved and implemented; no fake autosave.
- Busy actions synchronously lock before await and visibly disable/label-swap.
  Successful saves exit only after checked persistence and appropriate invalidation.
  Read `mutations.md`; failed saves stay with values intact.

`shared/samples/screen-form.tsx` demonstrates an injectable checked save contract:
without an approved handler it explicitly disables Save. It is an API example, not
permission to generate unwired stubs or to copy its recipe layout/success message.
