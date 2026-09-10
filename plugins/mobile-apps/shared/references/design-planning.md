# Context-Led Design Planning

Read when a planner or `/design-system` needs to resolve missing design decisions. Reuse approved context rather than loading every design reference.

## Start with the job

Use the primary actor, task frequency, journey, content, decision risk, device posture, and environment. Industry is evidence about context, not an aesthetic router. Do not infer an inspection preset from “field,” a blue preset from “finance,” or an aviation preset from the app name. With sparse input, state modest assumptions and choose a useful hierarchy; do not ask the user to choose among three styles just to proceed.

Respect supplied brand decisions. With explicit permission to infer, choose the visual direction
for the actual job. Otherwise the design phase resolves the [one-time input choice](../../skills/design-system/references/input-modes.md#one-time-input-choice)
before materialization; an inferred planning draft is not a user decision. Existing named
directions and reference brands remain optional inputs. Tamagui's host baseline is an
implementation resource, not the product's design brief.

## Resolve consequential choices

| Decision | Reason from |
|---|---|
| Hierarchy and entry point | What must the user notice, decide, and do next? |
| Composition | What makes the task legible: sequence, comparison, overview, content, evidence, spatial relationship? |
| Container hierarchy | Which content is one continuous collection/section, and which summary/decision truly needs a distinct surface? |
| Density and disclosure | Frequency/expertise, information needed now, one-handed use, interruption and recovery |
| Task substance | Which facts and relationships make the next decision/read/action possible? Is the illustrative state representative enough to judge this? |
| Typography | Reading versus scanning, language/text scaling, numerical comparison, available native font assets |
| Media | Recognition, evidence, orientation, or content value; omit when it adds no task value |
| Surfaces and palette | Grouping, state meaning, supplied brand, contrast and lighting—not mandatory card/color quotas |
| Tone and feedback | User's stakes, useful next action, saved versus queued versus failed state |
| Motion | Orientation or feedback value, installed capabilities, reduced-motion behavior |

Choose as needed; not every screen needs a hero, metric strip, progress ring, card grid, photo, or animation. Conversely do not ban these because a generic style guide favors sparse lists. Consistent tasks can share composition; different tasks may need different structures.
Do not confuse visual simplicity with missing task context, or realism with a large fixture.
Choose content before containers; neither removing cards nor adding records automatically improves UX.
Existing approved requirements bound the design; missing essential semantics return to foreground,
not invented schema fields or operations for visual richness.

## Experience synthesis

A short brief is not permission to deliver a thin screen. With permission to infer, turn the
approved job into concrete presentation decisions before choosing containers or colors. Record
them in the existing `## Design`, `Layout delta`, and brand `## Components`, not a new sidecar:

- **Recognition:** choose the human-readable identity and supporting facts needed to select
  the correct record; retain technical codes where the actual job needs them.
- **Working rhythm:** identify what users repeatedly read, compare or change, what stays in
  context, and what needs a focused detour. Changing an approved operation or route still
  requires its owning gate; grouping the existing evidence does not.
- **Density:** choose comparison-oriented, reading-oriented or mixed treatment with a reason.
  Specify which facts sit together and what is disclosed later at the target usable viewport.
  Dense means less redundant chrome, not smaller type or undersized touch targets.
- **Decision and feedback:** place the next supported action beside the evidence needed to
  take it; distinguish edited, saving, persisted, failed and completed states.
- **Distinctive interaction:** name the task-specific grouping or control treatment that makes
  this job easier, or say why the existing simple surface is sufficient.

For example, receiving goods benefits from aligned expected/received/damaged values and
evidence adjacent to discrepancies. Reading a lesson benefits from readable prose, retained
position and a quiet continuation action. Both can be high quality; neither implies a fixed
palette, card count, dashboard, sticky footer or new business feature.
Use supported facts and modest disclosed assumptions, not invented suppliers, totals,
notifications, media history or offline promises to make the screen appear complete.

### First-preview usefulness

Before materialization, use the existing Layout delta to answer three questions for the entry
surface: **Where am I? Which content or work is relevant? What can I do or read next?** Carry
the answers into the working surface and its result/recovery, not just a polished Home.
Choose the leading identity from the user's selection decision: equipment name for maintenance,
lesson/topic for learning, or claimant and expense context for review. Neither location-first
rows nor an organization-first header is a universal default.

Choose useful grouping from supported meaning (sequence, date, category, status, or relationship),
not a mandatory row/card pattern. Search and context controls belong near selection when the job
needs them and their sources support them; a focused reader or singleton needs neither by default.
In the first viewport, distinguish primary content from metadata and actions without hiding the
facts needed to decide. If the design feels empty, check missing task context, hierarchy and
representative state before adding records, banners or metrics. If it feels crowded, remove
redundant chrome and change grouping before shrinking typography or targets.

The first preview should communicate a plausible finished experience within approved scope,
not a sparse wireframe that relies on later native generation to supply visual judgment.
A reference may demonstrate a useful quality level, but its palette, density, navigation and
domain fields are not a recipe for other apps. User preference is not a percentage similarity gate.

## Component choice and creation

The AI may reuse, adapt, compose, or generate task-specific UI components when they better serve the approved user journey; the sample library is a starting point, not a closed catalog or a ceiling on design quality.
Inspect existing components first and reuse their working behavior where it fits, but do not force a task into an unsuitable sample or duplicate data, authentication, navigation, or state-management helpers just to obtain a different appearance.
For example, compose a new inspection evidence card when a generic information row cannot convey the required image, finding, and action together; keep its verified data access, accessibility, native support, and failure handling intact.
Component creation within approved presentation and scope needs no separate component-choice approval; changes to business behavior, data, routes, dependencies, or explicit design requirements still use their owning foreground gate.

For each task-specific treatment reused across screens, record a compact recipe in the existing
brand `## Components`: purpose and consuming screen IDs, content/typography hierarchy, grouping
and density, icon/media treatment, states, and action semantics. This is more than a component
name or prop interface. After services are resolved, foreground maps the recipe to a real
component/export before builder fan-out; use typed view data and callbacks without duplicating
service or persistence logic. A one-screen treatment may stay screen-local. Do not create a
mandatory component catalog, gallery or signature-component sidecar.

## Entry composition and reference transfer

Resolve the [entry composition](screen-planning/spec-contract.md#entry-composition-within-existing-specs)
from selected screen Layout deltas; standalone designs record it under Components in the brand
spec. "Clean/simple" means low cognitive load, not missing context or hierarchy.

**Behavior and presentation authority:**

- **Fixed:** approved data, operations, authorization, native/connector scope, routes/navigation
  behavior, first-entry scope, and explicit user brand/presentation decisions. Changing these
  requires the owning foreground approval; a visual reference cannot expand them.
- **Provisional until visual approval:** model-suggested content arrangement, hero usage, media
  size/crop, spacing, typography and emphasis. Record that status in existing Layout delta or
  brand Components prose. Early structural/spec approval does not freeze these suggestions.
  The design/intent author may revise them within fixed constraints without reopening business
  approvals. Preserve required evidence and workflow sequence; a visual rearrangement must not
  hide a prerequisite or change an operation.
- **After visual approval:** the accepted presentation is the implementation reference, not the
  earliest planner suggestion. Foreground reconciles affected specs and shared conventions with
  the accepted design at the existing design review. Later visual changes need targeted review.
  Children still do not edit the plan or approve themselves; foreground preserves receipt/hash
  integrity when writing the accepted delta.

For example, enlarging a recognition image within its container or removing an unrequested
introductory banner is presentation work; adding ratings, routing facts or fulfilment promises
is not. If a fixed requirement needs revision, return the delta to foreground rather than
silently changing it. Missing layout detail alone is not missing product context: infer a
presentation proposal from the approved job and disclose it for visual review.

Do not overcorrect a crowded composition into a visually empty one. Preserve accepted
identity, useful hierarchy and task context while reducing excess chrome, repeated copy or
oversized media. A compact hero, illustration, contextual panel or plain list can each be
appropriate; neither adding nor removing a hero is a universal quality rule.

When a reference contains unimplemented context, distinguish **real integration** from
**explicit demo presentation** instead of treating both as forbidden. Ask the foreground once
which is intended if the choice changes behavior. Approved demo context may be coherent
synthetic values and a clearly labeled local simulation; it must not impersonate a real
booking, patient record, payment, approval, delivery or service promise. Keep it separate from
live data and never use it to mask a failed request. Centralize shared demo values and preserve
them across screens; the completion explicitly states what did **not** happen.

For a supplied screenshot or HTML reference, record **Adopt / Adapt / Exclude** in the existing
brand provenance: transferable hierarchy/media/density, native or accessibility adjustments,
and unsupported data/actions. A visual reference does not authorize new business behavior.
Inspect it without executing imported scripts. If it cannot be viewed, disclose that limitation.
Without a supplied reference, infer presentation from the approved job; do not require one.

Reconcile visible content as well as styling before accepting a reference adaptation. Check
field/read availability, media cardinality (one stored image is not a two-photo gallery),
editable versus read-only controls, action destinations and persistence prerequisites.
Adding inline writes, a notification/share action or new tabs is behavior, not spacing.
Return a necessary scope delta to its owner; otherwise omit the unsupported affordance rather
than inventing a working-looking placeholder. Keep approved demo-only context explicitly separate.

## Constraints and active references

- All app styling maps to supported Tamagui/native properties and tokens, not web-only CSS. HTML previews translate those decisions to CSS.
- Use the existing native-host factory and semantic alias contract. No new outer providers, ad-hoc color parser, duplicated service layer, or native package expansion.
- Maintain at least 44pt iOS / 48dp Android targets, visible focus/labels, text scaling, non-color state cues, and tested contrast. Increase targets for gloves, motion, or other actual context.
- Palette work only: [color palette architecture](./color-palette-architecture.md). Typography/tone work only: [typography and tone](./typography-and-tone.md).
- Font assets must exist or have an approved loading plan using supported capabilities. Do not assume optional packages are installed or propose an unapproved native dependency.
- Broader experience guidance, only when needed: [mobile design philosophy](./mobile-design-philosophy.md).
- Imagery: [media sources](media-sources.md) permits verified licensed public HTTPS images as
  well as local assets; distinguish URL display from Dataverse Image/File byte storage.

## Persist one compact design decision record

Write the existing plan's `## Design` section. Avoid a second design bundle or repeating every screen:

```markdown
## Design
- Context and rationale: <actor, primary job, operating conditions; key assumptions>
- Direction: <context-led description or explicitly requested named direction>
- Hierarchy/layout: <entry focus, grouping, container strategy, disclosure, important composition decisions>
- Entry composition: <reference selected screen Layout deltas or standalone brand Components; do not duplicate>
- Typography: <roles, available families/weights, loading/fallback; scanning/reading rationale>
- Palette/theme: <approved brand or inferred choices; light/dark policy>
- Density/targets: <contextual spacing and usable target dimensions>
- Media: <task purpose, source, crop/fallback; or none with reason>
- Tone/feedback: <specific verbs; completion, pending and recovery treatment>
- Native/accessibility constraints: <relevant limits>
- Visual thesis: <one product-grounded idea and concrete hierarchy/type/surface/interaction consequences>
- tamagui-design-system: <required — brand import | add-aliases — verify host baseline>
```

Keep legacy `## Design Direction` if present as an input; reconcile it with the current record instead of creating another mandatory format. Explicit user requirements and safety/accessibility constraints outrank inferred style suggestions.

## Journey preview handoff

The screen planner records `### Primary journeys` within `## Screens`: actor/job, entry, decision, ordered screen IDs, actions and approved operations, outcome/recovery, and illustrative scenario. Model-selected preview screen IDs and rationale live in `### Preview selection` (legacy `### Primary Preview`); reuse it, matching heading capitalization case-insensitively. Select three representative main screens by default so makers can compare the overall direction,
fewer for a smaller product and more only when essential. This is a review-canvas default, not an
application screen-count target or List/Form/Detail checklist. Per-screen specs own detail.

Foreground owns approval of new or changed plan semantics. Design does not redesign Dataverse schemas, introduce operations, or expand native/connector scope to enable a visual idea. Keep those requirements in the existing plan, not a new UX JSON authority.

`/design-system` Step 6.75 materializes compact `brand/design-system.md` and `brand/tokens.ts`, then uses `/preview-screens --mode intent` for `_design_preview.html`. The intent preview tests design understanding before construction; post-build `/preview-screens --mode implementation` reads actual source for `preview.html`. Neither claims native execution.

## Implementation mapping

| Existing plan/context | Step 9b or `/edit-app` action |
|---|---|
| `brand/tokens.ts` exists / `tamagui-design-system: required` | Apply [Tamagui integration](../../skills/design-system/references/tamagui-integration.md); create missing approved brand tokens first |
| Legacy `tamagui-design-system: add-aliases`, no custom brand | Verify `createPowerAppsTamaguiConfig({})`; the host already supplies aliases |
| Custom typography | Bind approved roles to Tamagui fonts and verify asset loading/fallback while preserving config/provider ownership |

No unchecked integration path: exported light/dark themes and `PowerAppsProvider` must agree. Do not install packages or modify the bundled main template as a design step.
