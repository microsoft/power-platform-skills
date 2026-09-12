# Receive/Issue stale-staging + phantom-LookUp-key fixture

This fixture is a **negative-space** guard: it encodes a Receive/Issue app that is fully
*directionally* correct (so the P0 directional-mutation contract in
`scripts/validate-canvas-acceptance.cs` passes) yet carries two runtime-fatal defects. One of
them — the phantom LookUp key (Check 43) — is now caught **statically** by the validator; the
other — the dead staging variable (Check 34) — still cannot be seen by any static rule and
remains a prose-only responsibility. The fixture exists to lock in the phantom-key rejection
and to document the still-open Check 34 gap, keeping both defect classes described in
`references/QAChecks.md` anchored to a concrete, reviewable example.

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

## Why the validator now FAILS this fixture — and what it still misses

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
- the observer reads the canonical source and the receipt captures the Patch result.

What it still cannot see is defect #1: the validator never traces a staging variable back to
an input-control write, so a `varReceipt*` seeded to `0` and never re-`Set` from an input
slips through. Proving liveness needs whole-app dataflow the evidence contract does not carry.
If the phantom key were removed from this fixture, the validator would exit `0` despite the
dead staging variable — Check 34 "staging-variable liveness" stays the sole line of defense
against it. `../validate-canvas-acceptance.test.js` ("fails static validation on a phantom
LookUp key, still blind to the dead staging variable") asserts both facts: the phantom-key
failure, and that it is the **only** failure emitted.

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
`dotnet run --file`. This fixture must now exit **non-zero** on the phantom-key errors. A
future change that makes the validator *also* catch the dead staging variable should update
that test's expectation and this note together.

## Scope / known gap

Catching the **dead staging variable** (Check 34 "staging-variable liveness") is still a
**prose-only** responsibility: the screen builder and QA reviewer must apply it by
inspection. The **phantom LookUp key** (Check 43) is now enforced by the static gate. A live
Power Apps Studio browser evaluation remains the runtime authority; this fixture proves the
static gate catches the phantom key but cannot substitute for that judgment on liveness.
