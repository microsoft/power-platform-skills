# EDIT: Scoped Authoring and Conformance

Apply this contract to Direct, sequential Partitioned, and Planned EDIT, including new screens added to an existing app. It does not change execution-tier assessment or CREATE. The request authorizes the requested result and repairs of introduced or directly coupled defects, not unrelated cleanup.

## Change and Preservation Contract

Keep this compact; reference existing action/scenario keys instead of copying their tables.

| Field | Required content |
|---|---|
| Requested delta | Current observable behavior -> requested behavior, with a concrete acceptance example |
| Allowed changes | Named files, regions, controls/properties, sources and shared state; include necessary coupled repairs and why |
| Preserve | Relevant existing control names/creation keywords/versions and properties, behavior, bindings, palette, layout/scroll strategy, data semantics and fields outside the write set |
| Affected dependencies | Producers and consumers of changed state, navigation, filters and observers, with file ownership |
| Assumptions | Tool-backed feasibility, source/schema facts, justified dataset bounds, proposed mock scope and limitations, or none |
| Evidence | Changed-path and preservation scenarios, plus baseline observations/diagnostics when available |

Direct and sequential Partitioned keep the contract in context, without planning artifacts or a new approval step. Planned EDIT carries it in the existing approval, requirements, plan index and affected screen briefs. Each brief receives only its relevant slice; cross-file decisions live in the shared plan. Do not create a separate contract file or a second implementation specification.

Read current YAML before changing it; retained plans and past successful compiles are not current app state. Compare resumed work with the approved delta and current files. Reconcile implementation-only corrections without another approval; material UX/data compromises or expanded scope return to the maker. Never silently replace a live binding, remove functionality, introduce a new scroll owner, or upgrade controls to satisfy a generic guide.

## Metadata and syntax

The executor describes changed/added control contracts directly once per valid context. Existing names, creation keywords, versions, and properties outside the approved delta remain intact; current catalog metadata or naming guidance is not permission to rename or migrate a control. An approved migration must name its affected instances and contract changes. If a response cannot describe the existing version or conflicts with a required preserved contract, report the exact mismatch for coordinator reconciliation rather than changing versions or guessing support.

Use the exact selected control's returned inputs, outputs, enums and creation keywords. A copied brief, QA example or another alias's metadata is not authority. Inputs are not automatically readable outputs; never infer `Self.Items`. Refresh document-dependent Canvas/Code Component descriptions after an import, definition change or relevant compile invalidates them. Other contexts' calls do not supply your metadata.

Quote dotted enum names as identifiers: `='ButtonCanvas.Appearance'.Primary` when that exact name is returned; `=ButtonAppearance.Primary` when the selected control returns `ButtonAppearance`. Quote non-simple members too: `=DecimalPrecision.'1'`. For YAML-sensitive formulas use a block scalar, for example:

```yaml
OnSelect: |-
    =UpdateContext({showDetails: true})
Text: |-
    ="Status: " & currentStatus
```

Consult `${PLUGIN_ROOT}/references/YamlSyntax.md` or `${PLUGIN_ROOT}/references/ControlGuide.md` only for the relevant details; preserve supported existing syntax and control families.

## Read and inspect proportionally

Read large YAML and QA/implementation guides in explicit ranges of at most 100 lines. Small focused references may be read fully once. For every applicable QA check read its full body, continuing through successive ranges when needed. Reuse complete covered sections in the current context. On overflow, shrink the range on the original file; do not treat a truncated preview or escaped spill as full evidence.

Scope inspection to changed regions and regression-sensitive dependencies, not just edited lines. Include ancestors/siblings when their layout is affected and other consumers when shared state or data semantics change. Do not load all guides or audit every screen for a small edit. The ordinary one-leaf route can use its inline instructions without reading this reference unless uncertainty, coupled behavior or a diagnostic requires it.

Builders inspect their target file and supplied dependency contracts only; they report cross-file gaps to the coordinator, which owns cross-file inspection. Unchanged evidence is reusable only when neither the file nor its shared assumptions changed.

## Applicable checks

Use `${PLUGIN_ROOT}/references/QAChecks.md` for the full applicable checks. Evaluate applicability across its check list; N/A means outside the affected scope or genuinely inapplicable, not skipped inspection. These checks do not authorize unrelated repairs:

- **Preservation:** compare current and final named properties, handlers, record fields, layout ownership and bindings. Do not rebuild a screen for a local edit. Preserve working fixed layouts and existing responsive shells unless changing them is necessary for the approved result.
- **Geometry:** account for default `FillPortions`, minimum sizes, gaps, padding and fixed child heights. Show numeric evidence for affected horizontal/fixed-height branches, gallery rows and action reachability at relevant existing viewports. Outer scrolling cannot rescue clipped inner content. No app-wide mobile redesign absent an approved responsive change.
- **Data:** keep source identity, typed date/time/filter semantics and finite option values consistent through producers and consumers. For each affected list classify fixed mock, mutable local or live/unbounded; state a justified maximum or unknown, its invariant and invalidation conditions. A seed count is not a maximum. A unique subset of an immutable six-record source may be bounded by six; adding records invalidates that bound. Never truncate records, remove creation actions or allocate permanent maximum height merely to satisfy layout.
- **Journeys:** trace changed actions and affected preservation scenarios against canonical state, not static success text. Include record changes and return paths: where relevant, add A -> open B -> remove A -> revisit A. Feedback must stay bound to the correct record/operation and clear or recompute when selection/membership changes. Preserve unaffected handlers and observers.
- **Manual accessibility:** inspect affected labels, contrast, focus/interaction order and targets using supported properties. No automated checker policy changes are introduced here; keep existing EDIT checker behavior.

## Evidence and completion

Keep reports concise, not the inspection shallow:

`QA scope:` changed regions, affected dependencies and applied checks.
`Preservation:` concrete unchanged bindings/behavior and scenario outcomes.
`Functional:` changed transition traces, with record identity and visible result.
`QA layout evidence:` numeric budgets only for affected geometry.

Record each affected mutation's feedback mode under `${PLUGIN_ROOT}/references/MutationBehavior.md`. That reference owns preservation versus receipt applicability and the required static field/write and source-observer evidence.

Reports are static unless runtime-exercised. Coordinator owns cross-file evidence and finalization under `${PLUGIN_ROOT}/references/ValidationWorkflow.md`; gaps never pass.
