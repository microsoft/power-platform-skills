# Canvas App Plan

## Action Contracts

| Action  | Direction        | Notes                                  |
| ------- | ---------------- | -------------------------------------- |
| Receive | increases source | Adds the entered amount to on-hand qty |
| Issue   | decreases source | Subtracts the entered amount from qty  |

## Functional Test Matrix

| Scenario       | Given / When / Then                                      |
| -------------- | -------------------------------------------------------- |
| ReceiveAdds    | Qty 5, select Receive, enter 2, apply -> shows 7         |
| IssueSubtracts | Qty 5, select Issue, enter 2, apply -> shows 3           |

## Dispatch

| Action | Screen  | Target File                    | YAML Key | Name Prefix | Screen Brief |
| ------ | ------- | ------------------------------ | -------- | ----------- | ------------ |
| Create | Screen1 | {{WORKSPACE}}/Screen1.pa.yaml  | Screen1  | Mng         | none         |
