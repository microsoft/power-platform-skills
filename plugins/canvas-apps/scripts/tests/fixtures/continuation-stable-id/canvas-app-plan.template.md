# Canvas App Plan

## Action Contracts

| Requested action | Preconditions | Entry point | Owner screen | Control and event | Source and stable ID | Transition and postcondition |
| --- | --- | --- | --- | --- | --- | --- |
| Create item | none | Create | Screen1 | btnCreate.OnSelect | colItems / returned ID | create item and retain continuation |
| Delete item | continuation active | Delete | Screen1 | btnDelete.OnSelect | colItems / varContinuationId | delete the created item |

## Continuation Contracts

| Create action | Returned stable-ID binding | Downstream action and event | Downstream target binding | Successful-completion clear | Cancellation clear |
| --- | --- | --- | --- | --- | --- |
| Create item | varContinuationId from varCreated.ID | Delete item / btnDelete.OnSelect | LookUp(colItems, ID = varContinuationId) | btnDelete.OnSelect clears ID and mode | btnCancel.OnSelect clears ID and mode |

## Functional Test Matrix

| Scenario | Given / When / Then |
| --- | --- |
| DeleteCreated | create returns an ID, delete targets that ID, receipt and absence surfaces retain proof |
| CancelContinuation | create returns an ID, cancel performs no mutation and clears continuation |

## Dispatch

| Action | Screen | Target File | YAML Key | Name Prefix | Screen Brief |
| --- | --- | --- | --- | --- | --- |
| Create | Screen1 | {{WORKSPACE}}/Screen1.pa.yaml | Screen1 | Continue | none |
