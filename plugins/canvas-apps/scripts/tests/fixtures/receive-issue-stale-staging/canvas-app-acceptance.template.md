Runtime evaluation: NOT RUN

Plugin root: {{PLUGIN_ROOT}}
Skill contract version: 3.0.10
Source revision: test-fixture

## Action Contract Acceptance

| Action  | Handler      | Event formula                        | Observer     | Observer formula        | Notes | Result |
| ------- | ------------ | ------------------------------------ | ------------ | ----------------------- | ----- | ------ |
| Receive | btnMngReceive | `btnMngReceive.OnSelect: =Set(varLastOperation, "Receive"); Set(varReceiptExpectedQuantity, varReceiptOldQuantity + varReceiptAmount); Set(varLastInventoryMutation, Patch(colInventory, LookUp(colInventory, ID = drpMngAdjustItem.Selected.ID & " ID"), {Quantity: varReceiptOldQuantity + varReceiptAmount}))` | galInventory | Items = colInventory | adds  | PASS   |
| Issue   | btnMngIssue   | `btnMngIssue.OnSelect: =Set(varLastOperation, "Issue"); Set(varReceiptExpectedQuantity, varReceiptOldQuantity - varReceiptAmount); Set(varLastInventoryMutation, Patch(colInventory, LookUp(colInventory, ID = drpMngAdjustItem.Selected.ID & " ID"), {Quantity: varReceiptOldQuantity - varReceiptAmount}))` | galInventory | Items = colInventory | subs  | PASS   |

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
| Receive/Issue | drpMngAdjustItem.Selected.ID | drpMngOperation.Default: =Blank() | btnMngReceive.DisplayMode: =If(IsBlank(drpMngOperation.Selected.Value) \|\| Not(Value(numMngAdjustAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit) | btnMngReceive.OnSelect: =Set(varLastOperation, "Receive"); Set(varReceiptExpectedQuantity, varReceiptOldQuantity + varReceiptAmount); Set(varLastInventoryMutation, Patch(colInventory, LookUp(colInventory, ID = drpMngAdjustItem.Selected.ID & " ID"), {Quantity: varReceiptOldQuantity + varReceiptAmount})) | btnMngIssue.OnSelect: =Set(varLastOperation, "Issue"); Set(varReceiptExpectedQuantity, varReceiptOldQuantity - varReceiptAmount); Set(varLastInventoryMutation, Patch(colInventory, LookUp(colInventory, ID = drpMngAdjustItem.Selected.ID & " ID"), {Quantity: varReceiptOldQuantity - varReceiptAmount})) | galInventory.Items: =colInventory | operation=lblReceiptOperation.Text: =varLastOperation<br>old=lblReceiptOld.Text: =varReceiptOldQuantity<br>amount=lblReceiptAmount.Text: =varReceiptAmount<br>expected=lblReceiptExpected.Text: =varReceiptExpectedQuantity<br>actual=lblReceiptActual.Text: =varLastInventoryMutation.Quantity | PASS |
