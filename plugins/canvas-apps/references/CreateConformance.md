# CREATE Conformance: Inspect More, Report Less

This file owns CREATE inspection, repair and evidence procedures. Builders inspect their assigned YAML before returning. The coordinator independently inspects actual files before accepting a wave and across screens before completion. Compilation proves parsing/binding, not usable composition or working journeys.

## Canonical checks and specialist routing

Apply `${PLUGIN_ROOT}/references/CreateBuilderCore.md` and the applicable topic modules in its ownership map. They contain the complete routine CREATE rules; do not read the QAChecks index, duplicate legacy bodies or legacy plan/acceptance schemas.

Only features below require a bounded specialist check from `${PLUGIN_ROOT}/references/QAChecks.md`. Locate the named heading and read its complete body, not the whole manual or its general run/report instructions. Direct control descriptions remain authoritative. Interpret legacy brief/shared-plan references as current functionality, compositions, design and bindings.

| Feature actually present | Additional check body |
|---|---|
| GridLayout | `QACHK-GRID-CONTRACT`; use the relevant `${PLUGIN_ROOT}/references/GridLayoutGuide.md` section for track implementation |
| ModernDataGrid | `QACHK-DUPLICATE-GRID-SEARCH` |
| ModernCard imagery or slots | `QACHK-CARD-PLACEHOLDER` |
| Automatic Timer | `QACHK-TIMER-LIFECYCLE` |
| Badge, avatar or another semantic display | `QACHK-SEMANTIC-VALUE-BINDING` |
| ManualLayout or deliberately positioned overlay | `QACHK-MANUAL-BOUNDS` |
| Interactive descendants with View/Disabled ancestor modes | `QACHK-READ-ONLY-ANCESTOR` |

For advanced behavior not covered by the CREATE modules, use these exact bounded sections. Read the section body only, not the guide's generic preamble, prerequisite references or artifact schemas. Any approximation still needs the CREATE revision/approval process.

| Requested capability | Additional reference section |
|---|---|
| Periods/recurrence | `${PLUGIN_ROOT}/references/DataBehavior.md` - **Program periods and recurrence** |
| Export/report | `${PLUGIN_ROOT}/references/DataBehavior.md` - **Export and report output** |
| Mutable setup needed to exercise a visualization/operation | `${PLUGIN_ROOT}/references/DataBehavior.md` - **Operational setup for requested behavior** |
| Move/reorder/drag | `${PLUGIN_ROOT}/references/DataBehavior.md` - **Reordering, moving, and drag interactions** |
| Metrics or ranking | `${PLUGIN_ROOT}/references/DataBehavior.md` - **Metrics and dashboards** or **Leaderboards and ranked lists** |
| Immutable versions | `${PLUGIN_ROOT}/references/DataBehavior.md` - **Versions and comparison** |
| Role-scoped records/review | `${PLUGIN_ROOT}/references/MutationBehavior.md` - **Role-scoped record management and review** |
| Category lifecycle | `${PLUGIN_ROOT}/references/MutationBehavior.md` - **Category management** |

## Inspect current source

Read generated YAML and large specialist guides in original-file ranges of at most 100 lines per call. Small focused references may be read fully once; reuse complete sections in the same context. Continue longer sections in successive ranges. On overflow shrink the original range, never follow serialized spill files or count a preview as complete.

Before first write, preflight composed screen text against the core's creation-keyword, enum and YAML rules; a rejected write may leave no file to inspect. After writing, inspect the whole assigned file, not only the last changed range. Include every formula with a record literal or `: `, duplicate keys/names and leftover scaffold roots. Re-read current `[working directory]` content after it may have changed.

## Functional coverage

`QACHK-ACTION-CONTRACT`: trace every approved R/A ID as requirement -> screen/state -> composition region -> actual entry/event -> canonical source and stable identity -> postcondition -> bound visible result. Check the eligible path and the relevant invalid, empty, cancel and failure paths. Names in a plan or controls without events do not implement behavior.

For each required record field, inspect its visible current-record binding inside the intended row/detail. Combined text must include every promised field. Canonical human-readable identity, quantity/status and other requested fields cannot be replaced by IDs, icons, tooltips or accessible labels. Check declared state-driven visibility on the owning surface itself, not merely on a child or an unrelated navigation action.

`QACHK-PRIMARY-ACTION-REACHABILITY`: follow the entire ancestor chain from the initial state. Required entries must be visible when eligible, have satisfiable enabled conditions, fit bounds and target sizes, and remain uncovered. Below-fold actions require an obvious working scroll/menu path. Explicitly locate Save, primary actions and required inputs at each width/height. For confirmation, evaluate the position AFTER opening it; setting Visible on an offscreen panel is not reachability.

Check focus order/visibility and accessible/visible labels using the core. An approved modal must block background interaction and define entry/return focus; a dim rectangle is not a modal. Route unavailable support back to discovery rather than silently substituting an offscreen inline panel.

`QACHK-BEHAVIOR-ACCEPTANCE`: symbolically execute every approved journey using actual formulas, including relevant boundary, rejection, recovery and persistence paths. Apply the topic rules to the implementation, not just the discovery narrative. Requested edit means reachable prepopulation and stable-ID save, not review/status buttons. Disclosed mocks must actually support the approved local flows; they are not live integration, export or backend persistence. A notification cannot replace an output artifact or operation.

`QACHK-CORE-VISUALIZATION`: a requested hierarchy, timeline, comparison or dashboard needs populated controls bound to its source, not a titled blank container or decorative cards. Require meaningful approved first-load data or a truthful empty state with reachable setup. Relationships must expose parent/group, depth and connections. Comparisons must show two distinct labeled sources together; a side-by-side requirement cannot become tabs or a single reused panel. Derive added/removed/moved/changed states by stable identity. Ensure overlays do not hide or intercept populated content. Disproved feasibility requires an approved revision, never a silent approximation.

## Geometry and visual system

At every agreed width AND height, inspect initial, expanded-filter, confirmation, empty/error and longest-record states that exist. Include defaults from direct descriptions, not only written properties.

1. Resolve actual main-axis sizing, minimums and cross-axis alignment before computing bounds. Missing FillPortions can override nominal Height; proportional descendants are not zero-content children.
2. Compute each local width through its ancestors and compare required child widths/minimums, gaps and padding at exact branch thresholds. Do not count padding twice. Check stack/wrap heights and reachable cross-branch combinations, including hosts that retain wide logical geometry.
3. Compare content-sized heights with children, labels, text wrapping, gaps and padding. Four 44px inputs plus three 8px gaps need **200px before labels**, not a 152px wrapper. A 20px text box with 5px top/bottom padding leaves only 10px for glyphs.
4. Locate the bottom edge of the first COMPLETE main record and its primary action after chrome, heading and filters. Reporting only the gallery's top edge is insufficient. Compact secondary UI that unnecessarily displaces the main task.
5. Inspect every constrained ancestor and approved scroll owner. No outer scrollbar rescues inner clipping. Use the gallery module for viewport/template budgets, dataset bounds and row-specific behavior.
6. Verify local breakpoint reachability: `Parent.Width >= 768` inside a card capped at 760 never uses its wide branch. Check longest text and AutoHeight descendants; character-count estimates alone do not prove fit.

`QACHK-EXCESS-WHITESPACE`: unassigned space greater than one approved spacing increment needs a purpose. Remove oversized fixed panels, empty spacers, accidental proportional fill or SpaceBetween that separates ordinary content into distant islands. A 496px panel containing 332px has 164px to explain. Assign remaining space to useful content, except deliberate approved negative space.

`QACHK-VISUAL-CONTRACT`: compare exact header/nav placement, local breakpoint source, labels/order, control identities, type roles, colors, spacing, surfaces and action treatments to bindings. Require one clear page title and focal region. Distinguish primary, secondary, destructive and disabled actions. Inspect shadow/border/padding defaults; explicitly set unwanted DropShadow to the described None value so layout wrappers do not become accidental cards.

The coordinator recomputes decisive budgets from current YAML independently. Reject wrong-parent arithmetic, omitted padding/defaults, zero-valued proportional content, unexamined branches and budgets that omit the last required field/action. Repair the owning file, not the report.

## Concrete journey evidence

Use actual seed records or explicit representative values of the returned remote schema. Do not pretend unqueried production records were tested. The topic modules define required filter/reset, identity, mutation and navigation semantics; execute their paths as sequences, not isolated controls.

Include combined filters and every finite choice, at least two matching records where the source permits plus one nonmatching record and reset; nested navigation with a changed record/day; and add -> open intended destination -> remove -> return where applicable. Filtering must retain ALL matches, not just the first. Trace create -> bound list -> Edit -> change two fields including a finite choice -> save when edit is requested. Check each observer after each transition, including old success messages and current membership.

## Compile and repair

Only the coordinator calls `compile_canvas`. Compile initialization before dispatch and after each wave. Fix the highest diagnostic tier present, then compile before proceeding:

1. YAML parsing/structure, including `YamlInvalidSyntax`, duplicate mapping keys and `DuplicateNameInSequence`.
2. Control version/creation-keyword conflicts using refreshed direct descriptions when invalidated.
3. Duplicate app-wide entity names.
4. Unknown properties, respecting the described input/output distinction.
5. App-level property/formula/schema errors.
6. Remaining diagnostics.

Preflight creation-keyword and enum failures count too. Deduplicate by root cause; focus on roughly the first 30 distinct highest-tier messages, not cascades. Defer ONLY verified navigation references to exact pending-screen destinations in bindings, and only until those screens exist. Preserve the references and build the pending wave; no such diagnostic is acceptable at completion.

Repair files in place. Before exact-string edits, read current source around a unique anchor. After mismatch, re-read a smaller range and patch the actual substring; never append a replacement tree or guess indentation. Do not regenerate screens, restart planning or spawn another agent just to fix compiler errors. Shared contract corrections must reach already written consumers and undispatched assignments. Feasibility/resource changes follow `${PLUGIN_ROOT}/references/CreateWorkflow.md` revision and approval rules.

## Same-turn progress policy

After approval there is **no fixed compile-cycle limit**. Keep building and repairing in the same user turn while concrete progress is possible; do not ask for "continue" after five attempts. Clear repairable YAML errors before voluntarily yielding, then resolve binding/formula failures and pending screens toward a clean applied app.

For each diagnostic family:

1. Read the current reported location and relevant bounded technical section only if needed for its cause. Parsing often exposes only the first error, not every occurrence.
2. Sweep the whole affected file in bounded ranges for the same malformed pattern and repair all occurrences together. Include record literals/colon strings, duplicate properties/names and scaffold roots; do not spend one compile per colon.
3. Resolve causes before downstream symptoms: creation metadata, enum quoting, source/schema types, table/alias scope, then consumers. Use the owning CREATE module, not a conflicting legacy example.
4. Compile after the coherent repair. Track diagnostic identity (file, control/property or node, reason), attempted repair and verified outcome in bindings. Eliminating an offending instance or clearing a higher tier is progress even if new errors keep counts equal or increase them. An edit alone, shifting line numbers or alternating previously failing replacements is not progress.

If the same instance/root cause survives two targeted attempts, stop blind edits. Re-read its authoritative description and relevant bounded guide, change the hypothesis once, and attempt the evidence-led repair. If it still survives, report the exact blocker. Two consecutive steps that only reread already-covered unchanged material or narrate also require reassessment; a tracked full-file sweep through unread ranges is not stagnation.

Failed/denied tools, unavailable indispensable capability, material intent decisions and cancellation can require stopping; never bypass or call them successful. A user's "continue" permits another evidence-led attempt under valid approval, not a scope change or a requirement to say "new implementation cycle". The separate one-targeted-retry limit for experience/feasibility revisions is unchanged.

On resume reconcile synchronized YAML before trusting build status: unapplied drafts may disappear on a later turn. Expected pending-screen references are neither stagnation nor proof of application. On unavoidable stop record current diagnostics, affected R/A IDs, attempted causes/repairs, last applied state and unapplied-work risk in bindings and the user summary. This continuation policy does not change synchronization or guarantee durability.

## Report evidence, not recitals

Record affected controls/formulas, decisive geometry/record values, repairs with stable `QACHK-*` IDs, and unresolved limitations. Include the first complete main record/action position, scroll owner and constrained branch budgets. Do not reproduce upstream tables, per-control PASS dumps or generic quality assurances.

Keep runtime claims separate: static formulas and compilation do not prove painted layout, focus, pointer/keyboard interaction, server round trips or local durability. Mark runtime evaluation unrun unless actually exercised. CREATE does not call `check_accessibility` or `check_app`; manual functional/accessibility/layout inspection remains mandatory. `${PLUGIN_ROOT}/references/CreateValidation.md` owns the final completion gate.
