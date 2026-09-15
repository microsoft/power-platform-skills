Runtime evaluation: NOT RUN

Plugin root: {{PLUGIN_ROOT}}
Skill contract version: 3.0.16
Source revision: test-fixture

## Data Entry Label Evidence

| Control | Visible label binding | Shared layout region |
| --- | --- | --- |
| cmbAdjustItem | lblAdjustItem.Text | Screen1 |
| drpOperation | lblOperation.Text | Screen1 |
| txtAmount | lblAmount.Text | Screen1 |

## Action Contract Acceptance

| Action  | Handler    | Event formula                        | Observer   | Observer formula        | Notes | Result |
| ------- | ---------- | ------------------------------------ | ---------- | ----------------------- | ----- | ------ |
| Receive | btnReceive | `btnReceive.OnSelect: =Set(varLastOperation, "Receive"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity + varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity + varAmount, Notes: "Adjusted"}))` | galInventory | Items = colInventory | adds  | PASS   |
| Issue   | btnIssue   | `btnIssue.OnSelect: =Set(varLastOperation, "Issue"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity - varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity - varAmount, Notes: "Adjusted"}))` | galInventory | Items = colInventory | subs  | PASS   |

## Mutation Lifecycle Evidence

| Action | Receipt binding | Canonical source / observer | Requested destination / observer | Stable ID continuity | Synchronization | Focus | Result |
| ------ | --------------- | --------------------------- | -------------------------------- | -------------------- | --------------- | ----- | ------ |
| Receive | lblReceiptId.Text: =varLastMutation.ID | lblCanonicalQuantity.Text: =LookUp(colInventory, ID = varLastMutation.ID).Quantity | galInventory.Items: =Filter(colInventory, ID = varLastMutation.ID) | varLastMutation.ID | N/A — same live source | galInventory.Items: =Filter(colInventory, ID = varLastMutation.ID) | PASS |
| Issue | lblReceiptId.Text: =varLastMutation.ID | lblCanonicalQuantity.Text: =LookUp(colInventory, ID = varLastMutation.ID).Quantity | galInventory.Items: =Filter(colInventory, ID = varLastMutation.ID) | varLastMutation.ID | N/A — same live source | galInventory.Items: =Filter(colInventory, ID = varLastMutation.ID) | PASS |

## Mutation Field Evidence

| Action | Field | Classification | Canonical pre-state or input | Write / preservation formula | Receipt / proof binding | Post-state observer | Result |
| ------ | ----- | -------------- | ---------------------------- | ---------------------------- | ----------------------- | ------------------- | ------ |
| Receive | Quantity | Changed | btnReceive.OnSelect: =Set(varLastOperation, "Receive"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity + varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity + varAmount, Notes: "Adjusted"})) | btnReceive.OnSelect: =Set(varLastOperation, "Receive"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity + varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity + varAmount, Notes: "Adjusted"})) | lblReceiptActual.Text: =varLastMutation.Quantity | lblCanonicalQuantity.Text: =LookUp(colInventory, ID = varLastMutation.ID).Quantity | PASS |
| Receive | Notes | Changed | btnReceive.OnSelect: =Set(varLastOperation, "Receive"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity + varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity + varAmount, Notes: "Adjusted"})) | btnReceive.OnSelect: =Set(varLastOperation, "Receive"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity + varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity + varAmount, Notes: "Adjusted"})) | lblReceiptNotes.Text: =varLastMutation.Notes | lblCanonicalNotes.Text: =LookUp(colInventory, ID = varLastMutation.ID).Notes | PASS |
| Receive | Name | Preserved | lblPreName.Text: =LookUp(colInventory, ID = cmbAdjustItem.Selected.ID).Name | omitted partial update | lblReceiptName.Text: =varLastMutation.Name | lblCanonicalName.Text: =LookUp(colInventory, ID = varLastMutation.ID).Name | PASS |
| Issue | Quantity | Changed | btnIssue.OnSelect: =Set(varLastOperation, "Issue"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity - varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity - varAmount, Notes: "Adjusted"})) | btnIssue.OnSelect: =Set(varLastOperation, "Issue"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity - varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity - varAmount, Notes: "Adjusted"})) | lblReceiptActual.Text: =varLastMutation.Quantity | lblCanonicalQuantity.Text: =LookUp(colInventory, ID = varLastMutation.ID).Quantity | PASS |
| Issue | Notes | Changed | btnIssue.OnSelect: =Set(varLastOperation, "Issue"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity - varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity - varAmount, Notes: "Adjusted"})) | btnIssue.OnSelect: =Set(varLastOperation, "Issue"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity - varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity - varAmount, Notes: "Adjusted"})) | lblReceiptNotes.Text: =varLastMutation.Notes | lblCanonicalNotes.Text: =LookUp(colInventory, ID = varLastMutation.ID).Notes | PASS |
| Issue | Name | Preserved | lblPreName.Text: =LookUp(colInventory, ID = cmbAdjustItem.Selected.ID).Name | omitted partial update | lblReceiptName.Text: =varLastMutation.Name | lblCanonicalName.Text: =LookUp(colInventory, ID = varLastMutation.ID).Name | PASS |

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
| Receive/Issue | cmbAdjustItem.Selected.ID | Screen1.OnVisible: =Reset(drpOperation); Reset(cmbAdjustItem) | btnReceive.DisplayMode: =If(IsBlank(drpOperation.Selected.Value) \|\| IsBlank(cmbAdjustItem.Selected.ID) \|\| Not(Value(txtAmount.Text) > 0), DisplayMode.Disabled, DisplayMode.Edit) | btnReceive.OnSelect: =Set(varLastOperation, "Receive"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity + varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity + varAmount, Notes: "Adjusted"})) | btnIssue.OnSelect: =Set(varLastOperation, "Issue"); Set(varOldQuantity, cmbAdjustItem.Selected.Quantity); Set(varAmount, Value(txtAmount.Text)); Set(varExpectedQuantity, varOldQuantity - varAmount); Set(varLastMutation, Patch(colInventory, LookUp(colInventory, ID = cmbAdjustItem.Selected.ID), {Quantity: varOldQuantity - varAmount, Notes: "Adjusted"})) | galInventory.Items: =Filter(colInventory, ID = varLastMutation.ID) | operation=lblReceiptOperation.Text: =varLastOperation<br>old=lblReceiptOld.Text: =varOldQuantity<br>amount=lblReceiptAmount.Text: =varAmount<br>expected=lblReceiptExpected.Text: =varExpectedQuantity<br>actual=lblReceiptActual.Text: =varLastMutation.Quantity | PASS |
