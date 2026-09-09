# Expense approval contract fixture

Authored expected plan fragment, not captured AI output or a running app. Host auth/Profile rows are omitted. Service names describe fixture contracts, not live generated metadata.

Brief: Approvers open submitted claims from a queue or notification, inspect amount, receipt and policy evidence, then approve or reject with a reason. Record the decision and refresh the queue. This is an in-app decision, not a handwritten signature or Teams message. Receipts, policy limits and decision events are supporting data.

## Screens

### Screen Map

| Screen | Route | File | Presentation | Purpose | Data | Native | Source | ID | Rationale |
|---|---|---|---|---|---|---|---|---|---|
| Review queue | /(app)/home | app/(app)/home.tsx | default | Choose a claim to review | ClaimsService.getAll | none | replace template | expense-queue | Approver selects pending work directly instead of a duplicate summary dashboard |
| Review claim | /(app)/claims/[id] | app/(app)/claims/[id].tsx | default | Evaluate evidence and record decision | ClaimsService.get; ClaimDecisionsService.create | none | new | expense-review | Approver needs receipt, amount and policy context beside decision actions |

### Primary journeys

| Journey | Actor | Task | Entry | Decision | Action + operation | Committed outcome | Next destination | Recovery | Screen IDs |
|---|---|---|---|---|---|---|---|---|---|
| decide-expense | Approver | Decide a submitted expense | expense-queue or expense-review: notification with id | Approve or reject with reason using receipt/policy evidence | Approve/reject → ClaimDecisionsService.create | ClaimDecisionsService.create records decision and updates claim state atomically | expense-queue | Retain reason on failed/conflicting decision; reload current claim; direct entry returns to queue | expense-queue, expense-review |

### Preview selection

| Screen ID | Rationale | State |
|---|---|---|
| expense-review | Shows the actual policy/evidence decision, not an industry-themed dashboard | pending claim with receipt and rejection reason |
| expense-review | Makes safe recovery reviewable | decision conflict with retained reason and reload action |

### Navigation Contracts

| Route | Path params | Query params (UNION across all senders) | Intent | Returns to caller | Source action / outcome |
|---|---|---|---|---|---|
| /(app)/home | — | — | navigate | root | expense-review: recorded decision or direct-entry fallback |
| /(app)/claims/[id] | id: string | notificationId?: string | push | expense-queue fallback; refresh on focus | expense-queue: open claim |
| /(app)/claims/[id] | id: string | notificationId?: string | navigate | expense-queue fallback; refresh on focus | notification: open singleton review |

### Per-Screen Specs

#### Review claim (/(app)/claims/[id])
- **Screen ID** — expense-review
- **Archetype** — Detail
- **Layout delta** — claim amount and identity → receipt/policy evidence → decision controls and reason field.
- **UX contract** — Approver records approve/reject; rejection requires reason; ClaimDecisionsService.create atomically commits decision/state; confirmed result returns to expense-queue; conflict preserves reason and reloads current claim before another decision.
- **State delta** — receipt fetch error offers its own retry; decision conflict is not success or empty data; missing notification caller uses queue fallback.
- **Idempotency guards** — pending decision disables both actions; stale claims cannot receive a second decision.
