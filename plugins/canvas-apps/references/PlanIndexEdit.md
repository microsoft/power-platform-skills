# EDIT Plan Index Artifact

Project a validated EDIT PlanModel into the compatible `[working directory]/canvas-app-plan.md` index. Keep these headings, app-change groups, and dispatch columns exact.

Use the ownership boundary in `${PLUGIN_ROOT}/references/PlanModel.md`: make semantic outcomes, types, preservation, and cross-file contracts explicit; leave file-local formulas and geometry to the builder. Acceptance records the actual final implementation.

## Plan Index — EDIT

```markdown
# Canvas App Plan

## Mode

EDIT

## Requirements

[Original edit requirements]

## Change and Preservation Contract

[Carry the approved compact contract from requirements: requested delta, allowed changes, preserve constraints, affected dependencies, assumptions and evidence. Reference existing action/scenario keys; do not duplicate their tables. Use `${PLUGIN_ROOT}/references/EditConformance.md`.]

## Original Request Capability Inventory

| Requirement key | Original request clause | Capability family | Required outcome / scope | Required action(s) | Observer(s) | Scenario(s) |
| --------------- | ----------------------- | ----------------- | ------------------------ | ------------------ | ----------- | ----------- |
| [stable key] | [One changed or regression-sensitive clause preserved before planner reduction] | [BehaviorCore family] | [Fields, relationship, state transition, aggregation scope, or visible outcome] | [Exact Action Contract keys] | [Named visible/canonical observers] | [Exact Functional Test Matrix keys] |

[Include every requested edit clause and every existing behavior whose source, fields,
controls, observer, or layout is touched. Map exact keys; do not silently narrow the edit
to the planner's proposed screens.]

## Requirement Coverage

| Requirement                                     | Planned affordance                   | Fidelity                        |
| ----------------------------------------------- | ------------------------------------ | ------------------------------- |
| [Concrete noun or interaction from the request] | [Visible control and exact behavior] | Exact / Approximation: [reason] |

## Required Record Fields

| Field key                        | Screen   | Record surface | Required field | Source field | Presentation requirement                  |
| -------------------------------- | -------- | -------------- | -------------- | ------------ | ----------------------------------------- |
| [screen/surface/field identifier] | [Screen] | [Card/row/detail] | [Visible meaning] | [Record field] | [Full text, combined format, label, etc.] |

[Include every requested record field affected by the edit and every existing field whose
surface, source, formula, visibility, or layout is touched. Preserve unaffected required
fields on a modified surface. Omit this section only when the edit cannot affect a record
list, card, row, or detail surface.]

## State-Driven Surface Visibility

| Surface key | Owner screen | Surface control | State predicate | Visible and hidden states |
| ----------- | ------------ | --------------- | --------------- | ------------------------- |
| [stable surface identifier] | [Screen] | [Existing/shared name or new local surface role] | [Required predicate semantics; exact preserved/literal/shared binding when required] | [State where the surface appears; state where it is hidden] |

[Include changed plan-declared whole-surface state gating only. Omit always-visible
surfaces, navigation-based disclosure, child-only visibility, and visibility that the
plan does not declare. Preserve an existing exact
`Surface.Visible=state predicate` Action Contract observer as an equivalent compact
declaration rather than requiring a duplicate row.]

## Action Contracts

| Requested action            | Preconditions                             | Entry point                            | Owner screen | Control and event                     | Source and stable ID                          | Transition and postcondition                 | Mutation write set                   | Receipt proof set                                          | Observer and evidence                                              |
| --------------------------- | ----------------------------------------- | -------------------------------------- | ------------ | ------------------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [Concrete requested action] | [Eligible state and enabled/visible rule] | [Visible control the user starts from] | [Screen]     | [Existing/shared control event or new local role and event] | [Named source, field types, and immutable identity, or N/A] | [Required operation and resulting source state] | [Every changed field/status, or N/A] | [Feedback: Receipt - identity and fields to render; Feedback: Preserve - identity and static proof for every write; nonmutation: N/A] | [Required post-state observer and immediate receipt, or preserved exact feedback/observer bindings] |

[Include only actions stated by the request or approved plan. Preserve unaffected existing
actions, and do not expand the edit into universal CRUD. Preserve the semantic contracts
for role-scoped primary-record management, paired review decisions, requested periods or
cycles, and requested export/report output. Preserve or add separate Action Contract rows
for opposing transitions. A shared form does not merge Receive/Issue, Increase/Decrease,
Credit/Debit, Allocate/Release, Check-in/Check-out, or Enable/Disable into one contract.]

## Mutation Lifecycle Evidence

| Action | Receipt binding | Canonical source and observer | Requested destination and observer | Stable ID continuity | Synchronization when sources differ | Destination focus |
| ------ | --------------- | ----------------------------- | ---------------------------------- | -------------------- | ----------------------------------- | ----------------- |
| [Changed or affected mutation] | [Feedback: Receipt - result/snapshot and receipt intent; Feedback: Preserve - existing feedback bindings plus static write proof] | [Authoritative source and required observation; exact preserved/shared binding] | [Requested destination and required observation; exact preserved/shared binding] | [Same immutable ID throughout] | [Required success-path synchronization, or N/A — same live source] | [Receipt-mode focus-by-ID intent, existing focus to preserve, or N/A — no new focus in Preserve mode] |

[Include every changed mutation and every existing mutation whose source, destination,
identity, synchronization, focus, or evidence is affected. Apply the mutation lifecycle
contract from `${PLUGIN_ROOT}/references/MutationBehavior.md`; preserve unaffected rows.]

## Mutation Field Ledger

| Action | Field | Classification | Canonical pre-state or input | Write or preservation mechanism | Receipt/proof binding | Post-state observer |
| ------ | ----- | -------------- | ---------------------------- | ------------------------------- | --------------------- | ------------------- |
| [Changed or affected mutation] | [Field/status and type] | Changed / Preserved | [Live input/transition semantics, or canonical pre-state source] | [Required write or preservation behavior; exact preserved binding] | [Receipt-mode labeled field intent, Preserve-mode static field/write proof, or preserved-field proof] | [Canonical same-ID/field observation and actual observer path; exact existing bindings to preserve] |

[Include changed fields and preserved user-visible or lifecycle-significant fields for
each affected mutation. Changed rows retain write-set/proof-set parity. Preserved rows
must identify canonical carry-forward or omission from a partial update and post-state
evidence; preserve unaffected ledger rows.]

## Continuation Contracts

[Include only when this edit adds, changes, or can break a create-to-later-mutation
continuation. Otherwise omit it.]

| Create action | Returned stable-ID binding | Downstream action and event | Downstream target binding | Successful-completion clear | Cancellation clear |
| ------------- | -------------------------- | --------------------------- | ------------------------- | ---------------------------- | ------------------ |
| [Create Action Contract] | [Stable returned-ID state name/type and shared capture contract] | [Later edit/delete/relationship/approval/transition event] | [Same-ID target semantics; exact cross-file binding when shared] | [State to clear on success] | [State to clear on non-mutating cancellation] |

## Functional Test Matrix

| Scenario                     | Given                     | When                        | Then                                       | Evidence surface                      | Boundary or negative case                    |
| ---------------------------- | ------------------------- | --------------------------- | ------------------------------------------ | ------------------------------------- | -------------------------------------------- |
| [Changed or regression path] | [Current or seeded state] | [Exact visible interaction] | [Exact preserved or changed postcondition] | [Observer/control reading the source] | [Required failure/boundary behavior, or N/A] |

[Cover every changed Action Contract and every existing action whose source, fields,
controls, or observer are touched by this edit. This is the regression contract. When an
opposing pair is affected, include one concrete scenario per direction and verify explicit
before/amount/after semantics. When a Continuation Contract is affected, include
returned-ID-bound downstream completion and non-mutating cancellation/clear scenarios.]

## Data Entry Label Contracts

| Required input | Persistent visible label | Shared field region |
| -------------- | ------------------------ | ------------------- |
| [changed/affected input name or new local role] | [Required visible label text; exact binding when preserved; native visible Label only for ModernNumberInput] | [Shared immediate parent field grouping intent or preserved group] |

## Layout Budget Contracts

| Screen / container | Applied policies | Instance-specific measurements | Protected controls |
| ------------------ | ---------------- | ------------------------------ | ------------------ |
| [changed container or role] | [named policies from `${PLUGIN_ROOT}/references/LayoutPolicies.md`] | [Known viewport/data/text bounds and preserved dimensions; builder supplies final numeric budgets] | [amount, Save/Apply, receipt-mode result fields or preserved feedback, or N/A] |

## Viewport Containment Contracts

| Screen | Root control | Layout variant | Width binding | Height binding | Overflow policy |
| ------ | ------------ | -------------- | ------------- | -------------- | --------------- |
| [changed responsive screen] | [sole top-level root] | AutoLayout | `[root].Width: =Parent.Width` | `[root].Height: =Parent.Height` | [vertical scroll or proven bounded content] |

## Temporal Ordering Contracts

[Include when the edit adds, changes, or can invalidate time-of-day ordering.]

| Ordering key | Source | Sort field | Storage semantics | Input validation / normalization | Canonical sort binding | Accepted formats | Invalid / blank behavior |
| ------------ | ------ | ---------- | ----------------- | -------------------------------- | ---------------------- | ---------------- | ------------------------ |
| [stable key] | [collection/data source] | [typed field or canonical sort-key field] | Typed time / Canonical 24-hour text | [Required input validation/normalization semantics; exact preserved/shared binding] | [Exact source and sort-key identity; local formula chosen by builder] | [allowed input forms] | [visible reject/blank handling] |

## Working Directory

[absolute working directory]

## Discovery Summary

- Existing screens: [names]
- Layout: [ManualLayout / AutoLayout / mixed]
- Data sources: [used sources or none]

## Dispatch

| Action | Screen     | Target File           | YAML Key       | Name Prefix | Screen Brief                 |
| ------ | ---------- | --------------------- | -------------- | ----------- | ---------------------------- |
| Modify | [Existing] | `[working directory]/[File].pa.yaml` | [existing key] | [Prefix]    | `[working directory]/[File].screen-plan.md` |
| Create | [New]      | `[working directory]/[File].pa.yaml` | [new key]      | [Prefix]    | `[working directory]/[File].screen-plan.md` |

## App Changes

### Before builders

[Exact coordinator-owned mutations for shared definitions screens bind to: collections and field types, named formulas, app variables, OnStart seed data; or "None"]

### After builders

[Exact coordinator-owned mutations referencing screens that do not exist yet, such as StartScreen; or "None"]

## Editor State Changes

[Exact final ScreensOrder and ComponentDefinitionsOrder lists, or "None"]
```
