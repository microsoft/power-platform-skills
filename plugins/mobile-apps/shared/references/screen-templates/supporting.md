# Confirmation and Settings Screens

## Confirmation

- State exactly what completed, the trusted identifiers/outcome, and the next
  action.
- Do not rely on a toast as the only success evidence.
- Never claim a mutation succeeded before the checked service result confirms
  it.
- Keep retry/recovery available for partial outcomes.

## Settings

- Group settings by user intent with clear labels and current values.
- Destructive/reset/sign-out actions are separated and confirmed.
- A settings screen does not invent persisted preferences; use approved
  storage/data only.
- Changes explain whether they apply immediately, require restart, or affect
  only this device.
- Every switch/control has an accessible label and readable supporting text.
