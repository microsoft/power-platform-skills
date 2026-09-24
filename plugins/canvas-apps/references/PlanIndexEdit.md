# EDIT Plan Index Artifact

Project a validated EDIT PlanModel into the compatible `[working directory]/canvas-app-plan.md` index. Keep these headings, app-change groups, and dispatch columns exact.

## Plan Index — EDIT

```markdown
# Canvas App Plan

## Mode

EDIT

## Requirements

[Original edit requirements]

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
| [stable surface identifier] | [Screen] | [Container/card/panel control] | [Exact `=state predicate`] | [State where the surface appears; state where it is hidden] |

[Include changed plan-declared whole-surface state gating only. Omit always-visible
surfaces, navigation-based disclosure, child-only visibility, and visibility that the
plan does not declare. Preserve an existing exact
`Surface.Visible=state predicate` Action Contract observer as an equivalent compact
declaration rather than requiring a duplicate row.]

## Action Contracts

| Requested action            | Preconditions                             | Entry point                            | Owner screen | Control and event                     | Source and stable ID                          | Transition and postcondition                 | Mutation write set                   | Receipt proof set                                          | Observer and evidence                                              |
| --------------------------- | ----------------------------------------- | -------------------------------------- | ------------ | ------------------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [Concrete requested action] | [Eligible state and enabled/visible rule] | [Visible control the user starts from] | [Screen]     | [PrefixedControl.OnSelect / OnChange] | [Named source and immutable identity, or N/A] | [Exact operation and resulting source state] | [Every changed field/status, or N/A] | [Identity plus every value rendered after success, or N/A] | [Formula/control reading the post-state plus in-viewport evidence] |

[Include only actions stated by the request or approved plan. Preserve unaffected existing
actions, and do not expand the edit into universal CRUD. Preserve the semantic contracts
for role-scoped primary-record management, paired review decisions, requested periods or
cycles, and requested export/report output. Preserve or add separate Action Contract rows
for opposing transitions. A shared form does not merge Receive/Issue, Increase/Decrease,
Credit/Debit, Allocate/Release, Check-in/Check-out, or Enable/Disable into one contract.]

## Mutation Lifecycle Evidence

| Action | Receipt binding | Canonical source and observer | Requested destination and observer | Stable ID continuity | Synchronization when sources differ | Destination focus |
| ------ | --------------- | ----------------------------- | ---------------------------------- | -------------------- | ----------------------------------- | ----------------- |
| [Changed or affected mutation] | [Returned record/ID or deletion snapshot plus receipt control] | [Authoritative source and exact post-state observer] | [Requested destination and exact observer] | [Same immutable ID throughout] | [Exact success-path synchronization, or N/A — same live source] | [Exact focus-by-ID behavior, or N/A] |

[Include every changed mutation and every existing mutation whose source, destination,
identity, synchronization, focus, or evidence is affected. Apply the mutation lifecycle
contract from `${PLUGIN_ROOT}/references/MutationBehavior.md`; preserve unaffected rows.]

## Mutation Field Ledger

| Action | Field | Classification | Canonical pre-state or input | Write or preservation mechanism | Receipt/proof binding | Post-state observer |
| ------ | ----- | -------------- | ---------------------------- | ------------------------------- | --------------------- | ------------------- |
| [Changed or affected mutation] | [Field/status] | Changed / Preserved | [Live input/transition expression, or canonical pre-state lookup] | [Exact write or preservation behavior] | [Changed-field receipt or preserved-field evidence] | [Exact observer for the same ID and field] |

[Include changed fields and preserved user-visible or lifecycle-significant fields for
each affected mutation. Changed rows retain write-set/proof-set parity. Preserved rows
must identify canonical carry-forward or omission from a partial update and post-state
evidence; preserve unaffected ledger rows.]

## Continuation Contracts

[Include only when this edit adds, changes, or can break a create-to-later-mutation
continuation. Otherwise omit it.]

| Create action | Returned stable-ID binding | Downstream action and event | Downstream target binding | Successful-completion clear | Cancellation clear |
| ------------- | -------------------------- | --------------------------- | ------------------------- | ---------------------------- | ------------------ |
| [Create Action Contract] | [Exact captured returned ID] | [Later edit/delete/relationship/approval/transition event] | [Exact target lookup using that ID] | [Exact success clear] | [Exact non-mutating cancel clear] |

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
| [changed/affected classic or modern data-entry control] | [exact sibling label binding; native visible Label only for ModernNumberInput] | [immediate parent field row/group] |

## Layout Budget Contracts

| Screen / container | Applied policies | Instance-specific measurements | Protected controls |
| ------------------ | ---------------- | ------------------------------ | ------------------ |
| [changed container] | [named policies from `${PLUGIN_ROOT}/references/LayoutPolicies.md`] | [available width, longest label, gallery Height/TemplateSize, named color pair, or N/A] | [amount, Save/Apply, complete receipt, or N/A] |

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

[Shared definitions screens bind to — collections, named formulas, app variables, OnStart
seed data — or "None"]

### After builders

[Changes referencing screens that do not exist yet, such as StartScreen — or "None"]

## Editor State Changes

[Exact final ScreensOrder and ComponentDefinitionsOrder lists, or "None"]
```
