# Canvas App Plan

## Action Contracts

| Requested action | Preconditions | Entry point | Owner screen | Control and event | Source and stable ID | Transition and postcondition | Mutation write set | Receipt proof set | Observer and evidence |
| ---------------- | ------------- | ----------- | ------------ | ----------------- | -------------------- | ---------------------------- | ------------------ | ----------------- | --------------------- |
| Receive | selected item and positive amount | Receive | Screen1 | btnReceive.OnSelect | colInventory / ID | increase quantity and stamp note | Quantity, Notes | Quantity, Notes | focused inventory row |
| Issue | selected item and positive amount | Issue | Screen1 | btnIssue.OnSelect | colInventory / ID | decrease quantity and stamp note | Quantity, Notes | Quantity, Notes | focused inventory row |

## Mutation Lifecycle Evidence

| Action | Receipt binding | Canonical source and observer | Requested destination and observer | Stable ID continuity | Synchronization when sources differ | Destination focus |
| ------ | --------------- | ----------------------------- | ---------------------------------- | -------------------- | ----------------------------------- | ----------------- |
| Receive | returned Patch record and receipt | colInventory quantity lookup | focused inventory list | varLastMutation.ID | N/A — same live source | gallery filter by returned ID |
| Issue | returned Patch record and receipt | colInventory quantity lookup | focused inventory list | varLastMutation.ID | N/A — same live source | gallery filter by returned ID |

## Mutation Field Ledger

| Action | Field | Classification | Canonical pre-state or input | Write or preservation mechanism | Receipt/proof binding | Post-state observer |
| ------ | ----- | -------------- | ---------------------------- | ------------------------------- | --------------------- | ------------------- |
| Receive | Quantity | Changed | amount input | Patch Quantity expression | quantity receipt | canonical quantity lookup |
| Receive | Notes | Changed | transition literal | Patch Notes expression | notes receipt | canonical notes lookup |
| Receive | Name | Preserved | canonical name lookup | omitted partial update | returned-record name | canonical name lookup |
| Issue | Quantity | Changed | amount input | Patch Quantity expression | quantity receipt | canonical quantity lookup |
| Issue | Notes | Changed | transition literal | Patch Notes expression | notes receipt | canonical notes lookup |
| Issue | Name | Preserved | canonical name lookup | omitted partial update | returned-record name | canonical name lookup |

## Functional Test Matrix

| Scenario       | Given / When / Then                                      |
| -------------- | -------------------------------------------------------- |
| ReceiveAdds    | Qty 5, select Receive, enter 2, apply -> shows 7         |
| IssueSubtracts | Qty 5, select Issue, enter 2, apply -> shows 3           |

## Dispatch

| Action | Screen  | Target File                    | YAML Key | Name Prefix | Screen Brief |
| ------ | ------- | ------------------------------ | -------- | ----------- | ------------ |
| Create | Screen1 | {{WORKSPACE}}/Screen1.pa.yaml  | Screen1  | Adj         | none         |
