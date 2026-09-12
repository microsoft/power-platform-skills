# Receive/Issue stale-staging + phantom-LookUp-key fixture

This fixture is a **negative-space** guard: it encodes a Receive/Issue app that is fully
*directionally* correct yet carries two runtime-fatal defects. The acceptance validator
must catch both the phantom LookUp key (Check 43) and the dead staging variables (Check 34).
The tests also materialize isolated variants that repair the key or add live `OnChange`
assignments, proving that neither rule passes or fails only because of the other.

## The two embedded defects

Both were captured from a real AI-generated inventory app.

### 1. Dead / stale staging variable

`numMngAdjustAmount` (the amount input) and `drpMngAdjustItem` (the item selector) never
write their live values anywhere. `varReceiptOldQuantity` and `varReceiptAmount` are seeded
to `0` in `App.OnStart` and are **never** re-`Set` from an input control's `OnChange` or read
inline at mutation time. The receive/issue handlers compute against those seeds, so every
adjustment silently runs `0 + 0` / `0 - 0` regardless of what the user typed or selected.

The correct fixture (`../receive-issue`) instead reads the live inputs at mutation time —
`Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text))`
inside the same `OnSelect` — so its staging variables are live.

### 2. Phantom LookUp key

The `Patch` target is located with
`LookUp(colInventory, ID = drpMngAdjustItem.Selected.ID & " ID")`. The literal `& " ID"`
suffix is concatenated onto the real key before comparison, so the compared value never
equals any stored `ID`. `LookUp` returns `Blank()` and the `Patch` targets nothing — no real
record is ever mutated. The correct fixture compares the key with no surgery:
`LookUp(colInventory, ID = cmbAdjustItem.Selected.ID)`.

## Why the validator fails this fixture

`scripts/validate-canvas-acceptance.cs` is a static conformance gate over the acceptance
evidence table. For the directional pair it proves:

- the Patch write binds the receipt's `old`/`amount` operands with the correct operator
  (`old + amount` for receive, `old - amount` for issue), and that the write matches the
  `expected`-value `Set(...)` preview;
- the selected-record expression contains `.Selected` and a stable `ID`;
- the record-identity key used inside the Patch's `LookUp` is the selected-record expression
  **verbatim** — not concatenated or computed onto (Check 43). `drpMngAdjustItem.Selected.ID &
  " ID"` fails this rule, so the validator now rejects this fixture with one error per
  direction ("… mutation uses a transformed record-identity key …");
- the observer reads the canonical source and the receipt captures the Patch result; and
- each receipt old/amount variable is assigned from a live `.Selected`, `.Text`, or `.Value`
  expression in the mutation handler or a control `OnChange`. The `App.OnStart` seeds in
  this fixture do not satisfy that rule.

`../validate-canvas-acceptance.test.js` asserts the combined failure, repairs the phantom
key to isolate the four liveness errors, and adds valid `OnChange` assignments to prove
that supported staging remains accepted.

## Files

- `App.pa.yaml`, `Screen1.pa.yaml` — the app under test, copied verbatim into each run.
  `App.OnStart` seeds `varReceiptOldQuantity`/`varReceiptAmount` to `0`; nothing else ever
  writes them.
- `canvas-app-plan.template.md`, `canvas-app-acceptance.template.md` — plan and evidence
  artifacts with the same `{{WORKSPACE}}`/`{{PLUGIN_ROOT}}` placeholders as the sibling
  fixtures.

## How it runs

```bash
# from plugins/canvas-apps
node scripts/run-tests.js
```

`../validate-canvas-acceptance.test.js` materializes the case under `../.work/`
(git-ignored), substitutes the placeholders, and invokes the validator with
`dotnet run --file`. The unmodified fixture exits non-zero on both key-integrity and
staging-liveness errors.

## Scope

The static gate proves that the committed final YAML contains a direct live-input assignment
for each directional receipt operand and an untransformed record key. It does not execute
`OnChange`, prove pointer reachability, or verify that the data source accepts and returns
the mutation. A live Power Apps Studio browser evaluation remains the runtime authority.
