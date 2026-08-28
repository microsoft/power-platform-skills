# Product Experience Compiler

Canonical planning contract for turning an app brief into a focused, designed
mobile product before Dataverse tables or React Native screens are generated.

The compiler separates five decisions that must not be collapsed into an
industry preset:

1. **UX DNA** — who uses the app, what they repeatedly need to accomplish, and
   the conditions in which they use it.
2. **Product scope** — which jobs ship now, which support those jobs, and which
   are explicitly deferred.
3. **Workflow journey** — the ordered user-visible steps that complete each
   core job.
4. **Product experience** — the information hierarchy, interaction tempo,
   media, trust, accessibility, and visual personality appropriate to the
   approved jobs.
5. **Screen build packs** — deterministic, per-screen implementation contracts
   consumed by screen builders and the HTML experience preview.

Industry supplies vocabulary only. It must never directly choose palette,
typography, density, radius, Home composition, or a design preset.

## Planning order

```text
confirmed requirements
  -> UX DNA + product jobs
  -> product scope and adaptive budgets
  -> minimum supporting data model
  -> workflow journey
  -> design materialization
  -> screen build packs
  -> interactive HTML experience preview
  -> React Native implementation
```

The UX DNA and product scope are resolved before `data-model-architect` runs.
This prevents descriptive nouns from becoming tables before the planner knows
which records require independent persistence.

## UX DNA

Write `<working_dir>/.tmp/product-experience-contract.json`. The contract
contains:

- `primaryUser`
- `primaryGoal`
- `primaryIntent`
- `workflowShape`
- `operatingContext`
- `sessionPattern`
- `informationDensity`
- `interactionTempo`
- `decisionRisk`
- `contentEmphasis`
- `collaborationMode`
- `visualPersonality`
- `mediaStrategy`
- `accessibilityPriorities`
- `firstViewport`
- `signatureExperience`
- confidence and exact short prompt evidence for inferred fields

Use semantic values that remain meaningful for an unfamiliar domain. Do not
reduce the contract to an industry keyword or a fixed archetype lookup.

## Product jobs and scope

Write `<working_dir>/.tmp/product-scope-contract.json`.

Classify every independently understandable user job as:

- **Core** — required to complete the primary release journey.
- **Supporting** — necessary data or behavior behind a core job but not an
  independent destination.
- **Deferred** — useful later, but not necessary for the first complete
  release.

Adaptive screen guidance:

| Product shape | Expected user-facing screens |
|---|---:|
| One focused journey | 4-7 |
| Two or three connected journeys | 7-12 |
| Complex enterprise workflow | 12-16 |
| Multiple independent roles/workspaces | 16-20 |

These ranges are review budgets, not hard caps. More than 20 user-facing
screens requires an explicit exceptional justification naming the independent
roles and journeys that cannot be composed into fewer surfaces.

Authentication redirects, OAuth callbacks, layouts, and infrastructure routes
do not count as user-facing product screens.

Table guidance is also adaptive. A new table requires at least one:

- independent lifecycle;
- independent ownership or security;
- repeated child records;
- independent querying or reporting;
- offline synchronization boundary;
- explicit history or audit requirement;
- many-to-many relationship.

Prefer a Choice column, parent column, local configuration, view-model value,
or transient UI state when none applies. A noun in the brief is not sufficient
table justification.

## Surface coverage

Every core job must map to a usable surface, but a surface may be:

- a screen;
- a section of a screen;
- a sheet or modal;
- a step in a focused workflow;
- a contextual action.

Do not create a route merely to satisfy coverage. Supporting/reference entities
normally have no dedicated screen. Only independently managed entities require
their own destination.

Create and edit should share one form contract when their fields and workflow
are substantially the same.

## Product-experience enrichment

The planner may safely infer presentation details needed to make the approved
journey coherent:

- information hierarchy;
- search, filtering, grouping, and progressive disclosure;
- media placement and approved fallbacks;
- trust and decision-support signals;
- contextual recommendations;
- confirmation and continuation behavior;
- loading, empty, error, offline, and populated states.

Every inferred datum is classified as one of:

- `safe-presentation`
- `sample`
- `schema-backed`
- `proposed-requires-approval`

Production behavior may not depend on `sample` or
`proposed-requires-approval` data until the user approves it and the data model
or connector contract supports it.

## Workflow journey

Write `<working_dir>/.tmp/workflow-journey-contract.json`.

For each core job, record:

- ordered journey steps;
- owning surface;
- visible action;
- data operation or local state;
- entry and exit conditions;
- populated, loading, empty, error, and recovery behavior.

For a commerce experience, a valid journey may be:

```text
Discover -> Product -> Cart -> Checkout -> Confirmation
```

It must not be replaced by generic List, Form, and Detail routes merely because
the underlying schema contains products and orders.

## Screen build packs

Author `<working_dir>/.tmp/screen-build-pack.json`, then run:

```bash
node "${PLUGIN_ROOT}/scripts/compile-screen-build-pack.js" \
  --project-root "<working_dir>"
```

The compiler writes
`<working_dir>/.tmp/compiled-screen-build-pack.json`, the revision-bound
artifact consumed by screen builders and the HTML preview. Each user-facing
screen contains:

- purpose and user question;
- exact first-viewport region order;
- dominant information hierarchy;
- primary and secondary actions;
- trust signals and decision support;
- media and fallback treatment;
- domain context;
- signature interaction;
- loading, empty, error, offline, and populated states;
- incoming and outgoing navigation;
- forbidden generic defaults;
- data assumptions and their classification;
- classified preview content: product-specific headline/supporting copy,
  metrics, records, fields, summary rows, and media labels used only by the
  Gate 3 approval preview.

The compiler rejects thin preview content, canned placeholder values, and a
media-bearing screen that has no preview media label. This keeps the renderer
deterministic without allowing it to fabricate generic dashboard numbers,
form values, or repeated list descriptions.

Build packs bind to the current UX DNA, scope, journey, and authored build-pack
hashes. Builders must run the compiler with `--check` and must not consume
stale packs.

## Design materialization

`/design-system` materializes the approved UX DNA. With no brand input it still
writes:

- `brand/design-system.md`
- `brand/tokens.ts`
- `brand/design-system.html`
- `_plan_preview.html`

No-brand does not mean inspection styling. Use the approved visual personality,
content emphasis, density, operating context, media strategy, Home
composition, and first viewport. `direction-inspection.md` and
`direction-polished-inspection.md` remain explicit choices for apps whose
approved experience calls for them.

## HTML experience preview

The pre-build preview is the experience approval artifact, not a generic
component gallery.

Render it deterministically:

```bash
node "${PLUGIN_ROOT}/scripts/render-product-experience-preview.js" \
  --project-root "<working_dir>"
```

- Render at least three representative user-facing screens.
- When the primary journey has five or fewer critical screens, render all of
  them.
- For larger apps, render Home/entry, the core workflow, and outcome/detail,
  plus up to two additional screens needed to understand the primary journey.
- Show every selected phone frame together on one presentation board. Keep all
  critical screens visible simultaneously when the journey has five or fewer;
  for larger journeys, show the five representative screens together.
- Use tabs and journey actions only to focus or scroll to a phone. They must
  never replace or hide another selected screen.
- Use the approved design tokens, screen build packs, journey order, populated
  sample content, and state controls.

Reject the preview before implementation when it:

- misses a core job or critical journey step;
- substitutes generic CRUD screens for the approved journey;
- omits required media or trust/decision-support information;
- has no meaningful first viewport or visible primary action;
- repeats the same composition on every screen without justification;
- relies on unsupported production assumptions;
- exceeds the approved scope without justification.

Native screenshot or emulator visual QA is not part of this workflow. The HTML
experience gate, source validators, and TypeScript checks are the supported
quality path.
