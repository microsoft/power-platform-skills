# Direct intent-preview authoring

Load only for `--mode intent`, before native screen implementation. The model authors
HTML, CSS, and small in-memory interactions directly. Do not read the Tamagui component
conversion table, translate starter TSX, or require its example phone shell.
Tamagui is the eventual implementation technology, not a restriction on the HTML structure.

## Compact product context

Use the existing approved plan and relevant design sections as one coherent input.
Include all relevant decisions, not every source file, metadata response, or tool log:

| Context | What the preview must understand |
|---|---|
| Product/domain | Primary actors, jobs, terminology, operating conditions, mobile platforms |
| Journeys | Entry, decisions, primary actions, completion, next destination, recovery |
| Data model | Relevant records, relationships, selected fields, independent states, coherent example values |
| Business rules | Authorized actors, transition preconditions, affected records, observable postconditions |
| Connectors | Planned read/write operations, source of truth, loading/failure behavior; no live calls |
| Native capabilities | Approved/supported scanning, camera, location, files etc.; mock only what can be represented honestly |
| Navigation | Main destinations, task-appropriate entry, applicable scope/filters, contextual actions, selected-item/deep-link returns |
| Design | Approved tokens, typography, hierarchy, density, imagery, accessibility and explicit negatives |

Foreground may supply these facts inline. Retrieve only missing relevant plan sections.
Capability and connector decisions need to be planned before preview, not provisioned.
Unknown business policy remains an assumption or foreground question, never an invented rule.
For an explicitly requested mock-only prototype, label all unverified data/backend decisions
as illustrative; do not resolve environments or create Dataverse resources to render it.
Mock-only permission does not authorize later implementation or data mutation.

## Three representative screens by default

Select **three main screens by default** from `### Preview selection`, demonstrating
the actual product's primary journey. Not a List/Form/Detail quota and not a limit on
the eventual app. Use fewer when the product has fewer meaningful surfaces; expand only
when an essential journey cannot be explained otherwise or the user requests it.
Contextual details, dialogs, sheets, and recovery states can extend those main screens
without becoming filler navigation tabs.

Choose composition from the job and information hierarchy. Use readable mobile typography,
meaningful whitespace, task-relevant imagery/icons, clear action priority, and coherent
scenario data. Useful repeated cards/forms are allowed, but decorative furniture is not
evidence of domain experience. HTML semantics and CSS are free choices within the approved
design and feasible mobile/native boundaries.

Before authoring, establish one concise **visual thesis** grounded in the product and concrete
consequences for hierarchy, typography, container/surface strategy, and interaction—not a named preset.
Apply it visibly across the selected screens without making every screen the same card stack.
Explain the thesis briefly for review; assumptions are secondary to the screens.

### Container hierarchy and phone density

Use the parent skill's **device geometry** rule: match the reference device's width and height,
or use the documented phone default. Tablet-first work uses the approved tablet viewport and
adaptive layout; phone frames are not a universal device model.
Do not widen the phone, shorten its height, or shrink text/targets to make the review canvas fit.
If three full-size devices do not fit, switch the review layout; do not distort the app viewport.

- Give containers a semantic purpose; avoid redundant nesting or decoration that competes
  with the content. One continuous surface may suit a related collection; cards, grids or
  nested groups may be appropriate when comparison, media, hierarchy or task boundaries need them.
- Consider rows for rapid scanning, a timeline/agenda for chronological work, image grids for
  visual discovery, a reader/exercise canvas for learning, grouped sections for evidence,
  or a focused sheet for a short contextual action. These are choices, not mandatory archetypes.
  Do not replace a card-per-record default with a universal continuous-list default.
- Keep collection rows scannable: one primary label, the few secondary facts needed for the
  current decision, and an applicable state/action. Use progressive disclosure for secondary
  content, but keep comparison evidence, essential context and requested content visible.
  Give titles, supporting text, state and actions distinct visual levels; do not concatenate
  everything inline or squeeze the title beside a competing metadata column. Let important
  text wrap before shrinking it. Check a typical populated state, not only an empty-state screenshot.
- Reserve pills/chips for selectable filters or states that need emphasis. Ordinary metadata
  remains text; shadows, borders, accents, and rounded corners communicate hierarchy rather
  than decorating every item.
- Density follows frequency and task: an operational queue can be compact; a consequential
  review needs more evidence and breathing room. Do not manufacture empty space or decorative
  variation when a repeated row is the clearest pattern.

### Task substance before polish

Before choosing containers, identify what the actor must understand, compare, decide or do
on each selected screen. Select the relevant facts and relationships from the product context,
then choose their visual hierarchy. A title, generic status badge and timestamp are not a
complete experience when the task depends on other evidence. They may be sufficient for a
simple task; do not require every item to have an owner, progress bar, image or action menu.

Use a believable **typical populated scenario**, not the smallest fixture that makes handlers
work. Represent relevant variation and relationships so the maker can judge real usage; no
minimum record count or instruction to fill the viewport. A genuinely small or empty collection
is valid. Do not broaden scope, duplicate records or pad cards merely to make a screen look full.
Unconfirmed facts in mock-only work are labeled assumptions, never silently added to the
approved schema or operations. Progress indicators need meaningful evidence, not invented percentages.

Before handoff, inspect each screen and ask: can the actor understand the situation and take
the next supported step? Does selection open the relevant task/content, or only a related record?
Does the composition make important relationships and priorities legible, rather than merely
removing borders? Revise weak screens from this evidence. This is an authoring self-review,
not a new maker questionnaire, approval gate, universal layout or domain-field checklist.

Create one polished, self-contained HTML with working navigation and local action/state
transitions. On a wide review canvas, put the three representative screens side by side above
the fold where space permits, without resizing their device geometry. On narrow viewports, present one
screen at a time with an accessible switcher. Fewer screens use the available canvas rather than
empty frames. Keep assumptions, data-model notes, and limitations compact/collapsible or below
the primary review canvas; they must not displace the screens. A phone frame is optional
presentation, not a fixed app layout. Native scanning/capture and remote
writes are labeled simulations, not fake successful device/API calls.
Use actual approved token values as CSS variables directly. No brand input permits
task-appropriate inferred presentation; explain it rather than silently choosing a preset.

Apply the parent skill's safety, accessibility, first-use, domain-transition, and interaction
checks. Show what the user can judge and change. Avoid unrequested galleries, sidecars,
new renderers, or real-service setup.

Exercise bindings before handoff:

- Exercise each applicable scope/filter/search against its declared data source and affected
  surfaces. Keep displayed records, derived counts, and labels consistent. No out-of-scope record
  remains; an empty filtered result preserves and explains its scope. Independent views need
  not share a filter. Do not add search, filters, counters or mutations just to satisfy this check.
- A selected/scanned/deep-linked ID opens the exact record and correct parent context. Back
  restores the originating scope/filter/selection, or uses the approved direct-entry fallback.
- Mock mutations, when part of the approved job, update only the declared records/states and
  dependent views. Reset restores the exact initial scenario; shared context stays synchronized.
- For phone previews at desktop and 320px widths, essential content/actions remain visible without horizontal
  overflow. Validate unique rendered IDs, reachable destinations, dialog focus/close/recovery,
  no external resources/network calls, and no unescaped user text.
- At the target device width, inspect container nesting and information density. Simplify
  borders, radii or shadows that add no meaning without flattening useful hierarchy or removing
  affordances. Confirm essential detail is legible and secondary detail remains reachable.
  Inspect every selected screen, including populated collections and detail states, not just
  the first/home screen. Check the full fixed-height viewport, internal scrolling, and bottom actions.

Do not report these checks from source inspection alone. Use available browser interaction;
if unavailable, state which binding and responsive checks remain unverified.

## Approval and implementation handoff

Return the preview path, selected screen IDs, scenario, checks, assumptions, and limitations.
The foreground collects changes and acceptance, updates affected existing screen specs/shared
conventions/design values, and records the accepted preview revision. No approval is inferred
from a rendered page.

The native builder receives the relevant accepted preview screen/interaction as a visual
reference alongside the updated spec, tokens, actual services, and typed skeleton.
It implements that direction using supported native components, not HTML-to-TSX conversion
and not an independently redesigned layout. Resolve material mismatches in foreground;
mock data and browser handlers are never copied as production persistence.
