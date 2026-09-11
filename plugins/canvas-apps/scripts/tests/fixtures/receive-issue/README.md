# Receive/Issue directional-mutation fixture

This fixture is the regression guard for the P0 **Directional Mutation Contracts** bug:
opposing operations (Receive/Issue, increase/decrease, credit/debit, …) collapsing into a
single implicit mutation path so that one direction runs with the wrong sign.

## Scenario (Given / When / Then)

A single-screen inventory-adjustment app. A canonical source collection `colInventory`
holds each item's `Quantity`; `cmbAdjustItem` selects the record, `drpOperation` picks the
operation (starts `Blank()`), `txtAmount` is the amount, and `btnApply` stays disabled until
an operation is chosen and the amount is `> 0`. A receipt panel echoes operation, old value,
amount, expected, and actual.

| # | Given            | When                                | Then (source / receipt / gallery) |
| - | ---------------- | ----------------------------------- | --------------------------------- |
| 1 | Item `Qty = 5`   | select **Receive**, enter `2`, apply | all show **7** (`5 + 2`)          |
| 2 | Item `Qty = 5`   | select **Issue**, enter `2`, apply   | all show **3** (`5 - 2`)          |

The mutations bind the arithmetic to the exact operands the receipt commits to:
Receive patches `Quantity: varOldQuantity + varAmount`, Issue patches
`Quantity: varOldQuantity - varAmount`. The hardened check in
`scripts/validate-canvas-acceptance.cs` requires the operator to sit *between* those two
operands, so an Issue written as `varAmount - varOldQuantity` (reversed) — or as `+`
(collapsed into the Receive path) — is rejected even though a `-`/`+` still appears
somewhere in the formula.

## Files

- `App.pa.yaml`, `Screen1.pa.yaml` — the app under test, copied verbatim into each run.
- `canvas-app-plan.template.md`, `canvas-app-acceptance.template.md` — plan and evidence
  artifacts. Two values are machine-specific and cannot be committed literally, so they are
  placeholders substituted at run time:
  - `{{WORKSPACE}}` — the absolute run directory (the plan's Dispatch target).
  - `{{PLUGIN_ROOT}}` — the absolute plugin directory (the acceptance `Plugin root:` metadata).

## How it runs

`../../run-tests.js` (via `../validate-canvas-acceptance.test.js`) materializes each case
under `../.work/` (git-ignored), substitutes the placeholders, then invokes the validator
with `dotnet run --file`:

```bash
# from plugins/canvas-apps
node scripts/run-tests.js
```

The positive case must exit `0` (`PASS: …`); the reversed-Issue case must exit non-zero with
`issue mutation must apply '-' …`. CI runs the same command — see
`.github/workflows/canvas-apps-script-tests.yml`.

## Scope / known gap

This is a **static** conformance gate: it proves the final YAML encodes the correct
directional arithmetic. It does not execute the app. A live Power Apps Studio browser
evaluation remains the authority for the runtime functional grade (the acceptance artifact
always records `Runtime evaluation: NOT RUN`), and that step is intentionally outside CI
because it needs an interactive coauthoring session.
