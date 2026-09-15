Runtime evaluation: NOT RUN

Plugin root: {{PLUGIN_ROOT}}
Skill contract version: 3.0.16
Source revision: test-fixture

## Action Contract Acceptance

| Action | Handler | Event formula | Observer | Observer formula | Notes | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Create item | btnCreate | `btnCreate.OnSelect: =Set(varCreated, Patch(colItems, Defaults(colItems), {Name: "Created"})); Set(varContinuationId, varCreated.ID); Set(varContinuationMode, "Delete")` | lblDeleteReceipt | Text = varCreated.ID | captures returned ID | PASS |
| Delete item | btnDelete | `btnDelete.OnSelect: =Set(varDeleteSnapshot, LookUp(colItems, ID = varContinuationId)); Remove(colItems, varDeleteSnapshot); Set(varContinuationId, Blank()); Set(varContinuationMode, Blank())` | lblCanonicalAbsent | Visible = IsBlank(LookUp(colItems, ID = varDeleteSnapshot.ID)) | deletes returned ID | PASS |

## Continuation Evidence

| Create action | Returned stable-ID binding | Downstream action / event | Downstream target binding | Successful-completion clear | Cancellation clear | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Create item | `btnCreate.OnSelect: =Set(varCreated, Patch(colItems, Defaults(colItems), {Name: "Created"})); Set(varContinuationId, varCreated.ID); Set(varContinuationMode, "Delete")` | `btnDelete.OnSelect: =Set(varDeleteSnapshot, LookUp(colItems, ID = varContinuationId)); Remove(colItems, varDeleteSnapshot); Set(varContinuationId, Blank()); Set(varContinuationMode, Blank())` | `btnDelete.OnSelect: =Set(varDeleteSnapshot, LookUp(colItems, ID = varContinuationId)); Remove(colItems, varDeleteSnapshot); Set(varContinuationId, Blank()); Set(varContinuationMode, Blank())`<br>`lblDeleteReceipt.Text: =varDeleteSnapshot.ID`<br>`lblCanonicalAbsent.Visible: =IsBlank(LookUp(colItems, ID = varDeleteSnapshot.ID))`<br>`lblDestinationAbsent.Visible: =IsBlank(LookUp(colItems, ID = varDeleteSnapshot.ID))` | `btnDelete.OnSelect: =Set(varDeleteSnapshot, LookUp(colItems, ID = varContinuationId)); Remove(colItems, varDeleteSnapshot); Set(varContinuationId, Blank()); Set(varContinuationMode, Blank())` | `btnCancel.OnSelect: =Set(varContinuationId, Blank()); Set(varContinuationMode, Blank())` | PASS |

## Functional Test Matrix Results

| Scenario | Result | Trace |
| --- | --- | --- |
| DeleteCreated | PASS | static returned-ID delete trace; runtime not run |
| CancelContinuation | PASS | static non-mutating clear trace; runtime not run |

## Screen QA Evidence

| Screen | Coverage | Repairs | N/A |
| --- | --- | --- | --- |
| Screen1 | 1-44 COMPLETE | none | runtime NOT RUN |
