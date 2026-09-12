Runtime evaluation: NOT RUN

Plugin root: {{PLUGIN_ROOT}}
Skill contract version: 3.0.11
Source revision: test-fixture

## Action Contract Acceptance

| Action  | Handler    | Event formula                        | Observer   | Observer formula        | Notes | Result |
| ------- | ---------- | ------------------------------------ | ---------- | ----------------------- | ----- | ------ |
| Receive | btnReceive | `btnReceive.OnSelect: =Set(varLastOperation, "Receive"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity + varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity + varAmount}))` | galInventory | Items = colInventory | adds  | PASS   |
| Issue   | btnIssue   | `btnIssue.OnSelect: =Set(varLastOperation, "Issue"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity - varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity - varAmount}))` | galInventory | Items = colInventory | subs  | PASS   |

## Functional Test Matrix Results

| Scenario       | Result | Trace       |
| -------------- | ------ | ----------- |
| ReceiveAdds    | PASS   | 5 + 2 = 7   |
| IssueSubtracts | PASS   | 5 - 2 = 3   |

## Screen QA Evidence

| Screen  | Coverage      | Repairs | N/A  |
| ------- | ------------- | ------- | ---- |
| Screen1 | 1-44 COMPLETE | none    | none |

## Directional Mutation Evidence

| Pair | Selected-record expression | Blank operation binding | Invalid-submit gate | Receive mutation | Issue mutation | Canonical-source observer | Receipt bindings | Result |
| ---- | -------------------------- | ----------------------- | ------------------- | ---------------- | -------------- | ------------------------- | ---------------- | ------ |
| Receive/Issue | cmbAdjustItem.Selected.ID | Screen1.OnVisible: =Reset(drpOperation); Reset(cmbAdjustItem) | btnReceive.DisplayMode: =If(IsBlank(drpOperation.Selected.Value) \|\| IsBlank(cmbAdjustItem.Selected.ID) \|\| Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit) | btnReceive.OnSelect: =Set(varLastOperation, "Receive"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity + varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity + varAmount})) | btnIssue.OnSelect: =Set(varLastOperation, "Issue"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity - varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity - varAmount})) | galInventory.Items: =colInventory | operation=lblReceiptOperation.Text: =varLastOperation<br>old=lblReceiptOld.Text: =varOldQuantity<br>amount=lblReceiptAmount.Text: =varAmount<br>expected=lblReceiptExpected.Text: =varExpectedQuantity<br>actual=lblReceiptActual.Text: =varLastMutation.Quantity | PASS |
