# CREATE: Experience Before Implementation

Use this workflow for every whole-app creation request, including a small one-screen app. Targeted changes to an existing blank screen remain EDIT. A creation request does not authorize overwriting a meaningful existing app: clarify replacement intent before proceeding. Inspect current `[working directory]` YAML to establish the starting state, but do not choose controls while doing so.

You are the coordinator. Own user communication, stage dispatch, approval, shared wiring and compilation. Do not load Canvas implementation guides or propose concrete controls before experience design. The five specialists have separate contexts and do not delegate to each other. CREATE never enters Planned EDIT handoff.

Before reading any `/references` file named below, reuse it when its complete contents
were successfully returned earlier in this same context. Do not reread it merely because
a new turn started. For a large reference, read only the already-known relevant section
or a bounded range when the whole file is not needed. Reread only after a failed,
partial, truncated, or insufficient prior result. This rule does not apply to `[working directory]`,
whose YAML is synchronized and mutable each turn. Top-level, planner, and builder
contexts are separate; one context cannot assume that another context loaded a reference.

## Stage Dispatch

Invoke stages 1-4 sequentially using `Task`, validating each result before continuing. Supply the original request and clarifications verbatim, known device/data/environment constraints, relevant source paths/revisions, and a targeted revision assignment when applicable. Do not paste accumulated conversation or all prior tables into each invocation. Missing data sources may be covered by a mock-data proposal for normal approval, not an early provisioning questionnaire. Do not treat proposed mocks as implementation approval or ask discovery for exhaustive properties/formulas; it owns feasibility decisions, not implementation recipes.

| Stage / agent_type | Additional inputs | Owned outputs |
|---|---|---|
| 1 / `canvas-create-functionality` | Original intent and known constraints only | `[working directory]/create-functionality.md` |
| 2 / `canvas-create-screens` | Functionality | `[working directory]/create-screens.md` |
| 3 / `canvas-create-layout` | Screens and relevant functionality | `[working directory]/create-design.md`, `[working directory]/<screen-id>.composition.md` |
| 4 / `canvas-create-discovery` | Current experience artifacts | `[working directory]/create-discovery.md` |

The first three stages preserve explicitly requested controls/screens/constraints verbatim without introducing implementation choices. Do not preload their contexts with control, layout-implementation, YAML or Power Fx guides.

Each stage returns `Status: Ready|NeedsRevision|Blocked`, artifact paths/revisions and applicable diagnostics. Read the artifacts, not just the reply. Check that:

- `Revision:` is a positive integer, incremented for changes, and `Inputs:` names current source revisions (functionality instead records original intent verbatim).
- Stable `R*`, `A*`, `S*` and screen-qualified region IDs resolve. Every requested capability/action has a reachable screen/state, a composition region, and feasible discovery coverage. Preserved explicit requirements have not disappeared through abstraction.
- Each output contains its own decisions, not copies of upstream tables. Discovery records exact candidate query identities, material tool-backed constraints and resource contracts, not property inventories or saved descriptions.
- No stage has silently replaced real persistence/integrations with mocks or dropped an unsupported interaction.
- Discovery has reconciled shared fixed/scrolling chrome, gallery scroll ownership and confirmation/focus behavior with the compositions. A set of available controls alone is not proof that the proposed arrangement is feasible.

Do not advance on missing artifacts, stale inputs or unowned IDs.

## Revision and Resume

For `NeedsRevision`, route the affected IDs, observed constraint and needed decision to the owning stage. Invalidate its affected downstream artifacts transitively; regenerate only affected decisions. If a shared design changes, all compositions consuming that revision must be reconciled. Never consume stale discovery or layout because the filename still exists.

Allow **one targeted retry** for the same unresolved experience/feasibility gap, keyed by affected IDs and constraint, not by agent name. This limit applies to design decisions, not ordinary YAML/compiler repairs; those follow the same-turn progress policy in `${PLUGIN_ROOT}/references/CreateConformance.md`. Keep the gap/retry record in the affected artifact so another turn does not reset it. A repeated unresolved design gap stops with an explicit blocker. `Blocked`, a failed tool, or material missing user intent goes to the user; do not cycle agents or substitute unsupported behavior. No specialist grants approval.

A disclosed mock-data proposal for absent sources is not a blocker and does not require a separate permission round. Accept discovery's qualified `Ready` and include the proposed mock scope in the normal approval step. Respect an explicit rejection of mock data; do not convert failed discovery calls into evidence that sources are absent.

On a later turn, read current artifacts and synchronized YAML before dispatch. Resume the active CREATE only when the request continues that creation; targeted subsequent app changes use EDIT. A new creation request invalidates the old artifact graph even if its filenames match. Existing artifacts are not authorization to replace a meaningful app.

Validate the approved revision tuple and original intent; reuse unaffected stages instead of restarting all planning. YAML is synchronized from Studio each turn, while staged Markdown persists: build status is advisory until verified against actual current files. Changes in document-dependent components/schemas require refreshed discovery. Changed user intent invalidates affected work; meaningful UX/data compromises require renewed approval. Cancellation stops dispatch and application; never claim completion after cancellation.

Older workspaces may retain legacy snapshots. They are not authority and are not required inputs: preserve valid YAML and experience decisions, reconcile old snapshot links into candidate identities, and have consumers describe selected controls directly. Reconcile implementation-only handoff corrections without restarting planning; apply the existing revision/approval rules to changed experience decisions. Do not delete files merely to change the handoff format.

## Approval

Only after discovery establishes feasibility, including feasible mock-backed flows, present one concise experience proposal and obtain user approval. Begin the response with this exact heading on its own line:

```markdown
## Canvas App Plan
```

Include screens and purposes, key interactions and visible outcomes, data/persistence assumptions, shared visual direction and explicit compromises. When sources are absent, explicitly identify the mock data, demonstration identity if used, local/session persistence scope, and real integration or cross-device behavior not provided. Approving this proposal also approves the disclosed mock data; do not ask for a second mock-data approval. No control/property tables. Clarify material questions when needed, not after every internal stage.

Record approval in the coordinator-owned `## Approval` section of `[working directory]/create-discovery.md`:

```text
Status: Pending|Approved|Preapproved
Revision tuple: <functionality, screens, design, each composition, discovery path@revision>
Evidence: <the user's explicit approval or automation instruction>
```

Wait for approval before any `.pa.yaml` mutation or `compile_canvas`. Only an explicitly identified noninteractive automation run that pre-approves a reasonable plan may use `Preapproved` and continue without pausing, unless the request is harmful. Pre-approval never covers harmful content. Ordinary requests to create an app are not pre-approval.

Approval applies to the displayed revision tuple. Rewriting discovery resets it to Pending; changing any approved input invalidates it. On resume, verify it still matches before implementation. Recording approval itself does not change the discovery decisions/revision. An implementation-only correction that preserves the approved experience can be reconciled by the coordinator and recorded against the current tuple; do not infer approval for material changes.

After approval, read `${PLUGIN_ROOT}/references/CreateImplementation.md`, implement shared wiring and screen waves, then follow `${PLUGIN_ROOT}/references/CreateValidation.md`. Do not invoke the legacy planner or builder for CREATE.
