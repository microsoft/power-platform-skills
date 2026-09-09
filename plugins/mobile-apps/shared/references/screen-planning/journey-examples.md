# Job-to-Surface Examples

Read only when choosing a surface needs an example. These are authored planning illustrations, not claims about generated AI output or production validation. Repeated structures are legitimate when they support the same task.

| Brief evidence | Actor/task | Decision and committed outcome | Possible surfaces | Supporting data without independent screens |
|---|---|---|---|---|
| Browse groceries, change quantities, place a collection order | Shopper purchases a basket | Compare price/availability; selected basket becomes a persisted order after confirmation | Product discovery Home, inline quantity rows, basket/review, order confirmation | Categories, images, stock projections, order lines |
| Resume a short lesson, answer practice questions, track completion | Learner practices a skill | Continue at saved position; an answer/progress result is retained | Resume/lesson Home, reader or exercise workspace, completion state with next lesson | Sections, question options, progress records |
| Review submitted expenses with receipt and policy evidence; approve/reject | Approver decides a claim | Assess amount/receipt/policy; decision and any reason saved, refreshed queue | Review queue Home, evidence-led decision detail, confirmation inline or summary | Receipts, policy limits, decision events |
| Complete a site checklist and capture photos for failed checks | Inspector records required evidence | Record pass/fail plus required photos; checklist accepted only after required uploads | Assigned worklist Home, checklist/evidence workspace, submission review/result | Sites, checklist definitions, responses, attachments |

None of these require an all-purpose summary-tile dashboard. A dashboard becomes useful if the specific actor must compare independent signals before choosing work. Nor does every task require a new route: completion can be a state on the workspace when that preserves context.

## Compact spec example: expense decision

Illustrative `demo_` names below stand for verified generated metadata; do not copy them into an unrelated app.

```markdown
#### Review expense (`/(app)/claims/[id]`)
- **Screen ID** — expense-review
- **Domain layout decisions** — Amount, receipt, and policy exceptions support the approver's decision; evidence precedes approve/reject actions.
- **Archetype** — Detail
- **Purpose** — Decide a submitted claim from its evidence.
- **Route** — `/(app)/claims/[id]`
- **File** — `app/(app)/claims/[id].tsx`
- **Presentation** — default
- **Layout delta** — claim identity + amount → receipt preview → policy facts → labelled decision actions.
- **UX contract** — Approver only; reject requires a reason; approved generated decision operation must succeed before showing recorded decision; return to expense-queue, refreshing it; conflict reloads claim and retains unsent reason.
- **Data** — Approved generated claim/receipt services with exact fields and decision operation from Generated Services; missing operation evidence is NEEDS_CONTEXT, not a guessed API.
- **Navigation** — notification or expense-queue supplies id; completion returns to queue if no caller exists.
- **Navigation intent** — queue fallback navigate; receipt detail push.
- **State delta** — missing receipt is explicit, failed receipt fetch offers retry separately from claim data; stale decision blocks duplicate approval.
- **Key user actions** — inspect evidence, approve, reject with reason.
- **Idempotency guards** — pending decision disables both actions; failed decision keeps reason and current claim on screen.
```

Approval is a business-state change. Add ink capture only when the brief explicitly requires a drawn signature, not because the verb is "approve" or "sign off".
