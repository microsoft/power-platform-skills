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

For a supplied screenshot or HTML reference, record **Adopt / Adapt / Exclude** in the existing
brand provenance: transferable hierarchy/media/density, native or accessibility adjustments,
and unsupported data/actions. A visual reference does not authorize new business behavior.
Inspect it without executing imported scripts. If it cannot be viewed, disclose that limitation.
Without a supplied reference, infer presentation from the approved job; do not require one.

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
