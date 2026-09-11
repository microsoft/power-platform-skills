# Canvas App Plan

## Action Contracts

| Action  | Direction        | Notes                                  |
| ------- | ---------------- | -------------------------------------- |
| Receive | increases source | Adds the entered amount to on-hand qty |
| Issue   | decreases source | Subtracts the entered amount from qty  |

## Functional Test Matrix

| Scenario         | Given / When / Then                                                    |
| ---------------- | --------------------------------------------------------------------- |
| ReceiveAdds      | Qty 10, select Receive, enter 3, click Receive -> shows 13            |
| IssueSubtracts   | Qty 13, select Issue, enter 2, click Issue -> shows 11               |
| CompoundSequence | Qty 10 -> Receive 3 -> 13 -> Issue 2 (same item) -> 11 (2nd op reads 13) |

## Dispatch

| Action | Screen  | Target File                    | YAML Key | Name Prefix | Screen Brief |
| ------ | ------- | ------------------------------ | -------- | ----------- | ------------ |
| Create | Screen1 | {{WORKSPACE}}/Screen1.pa.yaml  | Screen1  | Adj         | none         |
