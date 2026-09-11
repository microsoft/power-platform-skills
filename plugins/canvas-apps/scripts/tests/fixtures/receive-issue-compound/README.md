# Receive/Issue compound-sequence directional-mutation fixture

This fixture is the regression guard for the **same-record compound sequence** gap: two
opposing operations (Receive/Issue) applied one after the other to the **same** record,
where the second operation must read the value the first operation already persisted, not
the original. It complements the sibling `receive-issue/` fixture, which only models two
**independent** single-operation cases starting fresh from the same original value.

The gap this exists for was found by a live end-to-end run: a generated inventory app was
asked to "create item Qty 10, Receive 3 (expect 13), then Issue 2 on the SAME item (expect
11)", and the quantity never moved past 10 because the second operation never read the
mutated 13.

## Scenario (Given / When / Then)

A single-screen inventory-adjustment app. `colInventory` holds each item's `Quantity`;
`cmbAdjustItem` selects the record, `drpOperation` picks the operation (starts `Blank()`),
`txtAmount` is the amount, and the `btnReceive`/`btnIssue` operation buttons each stay disabled
(their own `DisplayMode` is gated) until an operation is chosen and the amount is `> 0`. The crucial difference from the sibling fixture: each handler reads the
old value with `LookUp(colInventory, ID = cmbAdjustItem.Selected.ID).Quantity` — i.e. from
the **canonical source the previous mutation already patched** — not from a possibly-stale
selection snapshot. That is what lets the second operation observe the mutated value.

| # | Given                    | When                                 | Then                        |
| - | ------------------------ | ------------------------------------ | --------------------------- |
| 1 | Item `Qty = 10`          | select **Receive**, enter `3`, click **Receive** | all show **13** (`10 + 3`)  |
| 2 | Item `Qty = 13`          | select **Issue**, enter `2`, click **Issue**   | all show **11** (`13 - 2`)  |
| 3 | Item `Qty = 10` (compound) | Receive 3 then Issue 2 on same item | lands on **11**, 2nd op reads 13 |

## Files

Same layout as `../receive-issue/`:

- `App.pa.yaml`, `Screen1.pa.yaml` — the app under test, copied verbatim into each run.
- `canvas-app-plan.template.md`, `canvas-app-acceptance.template.md` — plan and evidence
  artifacts, with `{{WORKSPACE}}` and `{{PLUGIN_ROOT}}` placeholders substituted at run time.

The acceptance artifact carries the standard `## Directional Mutation Evidence` table (which
the validator machine-checks) **and** a `## Compound Sequence Evidence` table that documents
the same-record sequence and the second operation's canonical-source old-value binding.

## Scope / known gap

This is a **static** conformance gate, exactly like the sibling fixture: it proves the final
YAML encodes the correct directional arithmetic and that the compound-sequence evidence
table is present with a canonical-source read for the second operation. It does **not**
execute the app. No static check can prove that at runtime the submit button actually
becomes clickable, or that the second operation's read truly observes the mutated 13 rather
than a stale 10 — that remains the live Power Apps Studio browser evaluation's job (the
acceptance artifact always records `Runtime evaluation: NOT RUN`). The `## Compound Sequence
Evidence` table is therefore an authoring/reviewer proof, not a machine-verified gate.
