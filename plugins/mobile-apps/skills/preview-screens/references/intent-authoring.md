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

Use the foreground's Experience outline, Information needs and coverage when present. Supported
facts can have realistic synthetic values; additional concepts, artifact counts or operations
are not authorized by their presence in a screenshot. Derive quantities/counts from one coherent
scenario, keeping units and selected-record relationships consistent across all frames.

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

Before rendering, check the selection against the primary journey's working rhythm. Where do
users repeatedly read, compare, capture or decide? That surface must be visible in the main
storyboard, not merely reachable through a hidden modal. If the selected frames only show
entry, a field editor and confirmation, return a targeted selection change to foreground.
Keep valid form/reader/conversation-centered journeys; this is not a ban on forms or a
requirement to add a dashboard, scanner or route.

Choose composition from the job and information hierarchy. Use readable mobile typography,
meaningful whitespace, task-relevant imagery/icons, clear action priority, and coherent
scenario data. Useful repeated cards/forms are allowed, but decorative furniture is not
evidence of domain experience. HTML semantics and CSS are free choices within the approved
design and feasible mobile/native boundaries.

Before authoring, establish one concise **visual thesis** grounded in the product and concrete
consequences for hierarchy, typography, container/surface strategy, and interaction—not a named preset.
Apply it visibly across the selected screens without making every screen the same card stack.
Explain the thesis briefly for review; assumptions are secondary to the screens.

Use the selected screen's **Layout delta** as a provisional entry-composition proposal, not
only the thesis's adjectives. For standalone intent use the brand spec's Components. Follow
[behavior and presentation authority](../../../shared/references/design-planning.md#entry-composition-and-reference-transfer):
improve suggested arrangement, media scale and emphasis within fixed behavior and explicit
brand decisions. Missing content order alone does not require `NEEDS_CONTEXT`; propose it
from the approved job. Conflicts with fixed requirements do require foreground resolution.
Preview does not rewrite the plan; return presentation deltas for the existing visual approval.
No hero, grid, or extra route is required to make a restrained design useful.

### Container hierarchy and phone density

Use the parent skill's **device geometry** rule: match the reference device's width and height,
or use the documented phone default. Tablet-first work uses the approved tablet viewport and
adaptive layout; phone frames are not a universal device model.
Do not widen the phone, shorten its height, or shrink text/targets to make the review canvas fit.
If three full-size devices do not fit, switch the review layout; do not distort the app viewport.
Apply [first-preview usefulness](../../../shared/references/design-planning.md#first-preview-usefulness)
before choosing the shell. Review chrome is not app content: keep scenario explanations collapsed
or outside the primary canvas, and use the same responsive switcher/layout during review that
the maker will open. Do not repair an obstructed screenshot by temporarily hiding that chrome.

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
- Fix fit at the container level first: reserve only needed action width, allow flex/grid content
  to shrink and wrap, and keep scrolling content within its real available height. Clipping or
  `overflow-x: hidden` is not a fix for off-screen controls. Truncation is acceptable for secondary
  text only when the decision-bearing identity/facts remain readable or have a reachable disclosure;
  it must not hide the date, amount, unit or distinguishing name the user needs to choose.

### Realize the visual treatment

Translate each accepted recipe into a concrete rendered arrangement, not only a named box.
Specify which identity leads, which facts share a group, where visual weight belongs, and how
the next action relates to its prerequisites. Compare those choices in the screenshot.

- Lead with recognizable task/record context; retain technical references where useful without
  letting a long code accidentally dominate the title and controls.
- Give controls, selection and focus clear boundaries. Decorative cards and separators need
  not all use the same strong control outline; use surfaces/spacing to express grouping too.
- A repeated full-width button in every row is not a default. Use a suitable whole-row action
  or quieter affordance when the operation is selection; keep independent actions separate.
- Use recognizable local SVG/icon artwork or a supported icon representation with accessible
  names. Letter blocks such as "PH", "TR" or "GPS" are not a finished icon treatment.
- For a populated photo/evidence state, use approved representative illustrative imagery,
  with visible subject/crop and source provenance. A colored box saying "photo" cannot validate
  media prominence. If imagery is unavailable, show an honest empty state or mark the selected
  populated media treatment unverified; do not silently forbid imagery to avoid realizing it.
- Choose a realistic workload and meaningful variation, not the smallest fixture that makes
  handlers pass. Do not fabricate fields, padding records or unsupported metrics to fill space.

No fixed colors, card count, density or screenshot imitation is required. Native controls
and helpers can preserve typography and behavior later; they do not automatically improve
weak grouping, action hierarchy or visual identity.

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

Bind each selected frame's initial state to **Preview selection**: declared scope/filter,
selected record, data state and outcome stage must agree with the visible controls, records
and counts. Reset restores those exact values, not merely the route. A deliberate filtered,
empty or later-stage preview is valid: label it and separately exercise the app's first-entry
scope from Data/Navigation. Do not switch to All or add records to make the image look fuller.
Exercise every offered filter and search with an expected match and no-match result; check
record identities and count labels, not only that a handler ran. A loaded-page count must not
be presented as a whole-dataset count.

Keep one local scenario state in the HTML and render dependent views from it. A selection
must carry the selected record ID and parent context, not always open the first example.
Test two distinct records when a collection has them, including a read-only/completed variant
where applicable; an explicit out-of-scope destination is better than showing the wrong record.
Save/confirm must change the intended local record and its dependent views, not only show a
"saved" message. Reset restores fields, selected choices, filters, errors, parent/child state
and enabled actions to the declared initial scenario. These are preview-only state operations,
not permission to create a production data store or execute a native/API call.

For each filter or visible related fact, recheck its source in every scope that offers it.
A location filter on one collection does not make location available on a different collection
whose records only expose a related display name. Return that gap through the existing coverage
audit instead of adding plausible sample properties that have no supported production read path.

Before handoff, inspect each screen and ask: can the actor understand the situation and take
the next supported step? Does selection open the relevant task/content, or only a related record?
Does the composition make important relationships and priorities legible, rather than merely
removing borders? Revise weak screens from this evidence. This is an authoring self-review,
not a new maker questionnaire, approval gate, universal layout or domain-field checklist.

Create one polished HTML with self-contained code, working navigation and local action/state
transitions. On a wide review canvas, put the three representative screens side by side above
the fold where space permits, without resizing their device geometry. On narrow viewports, present one
screen at a time with an accessible switcher. Fewer screens use the available canvas rather than
empty frames. Keep assumptions, data-model notes, and limitations compact/collapsible or below
the primary review canvas; they must not displace the screens. A phone frame is optional
presentation, not a fixed app layout. Native scanning/capture and remote
writes are labeled simulations, not fake successful device/API calls.
Use actual approved token values as CSS variables directly. No brand input permits
task-appropriate inferred presentation; explain it rather than silently choosing a preset.
Use local assets or verified licensed HTTPS imagery per [media sources](../../../shared/references/media-sources.md).
Optional remote images do not make remote scripts or live data calls acceptable. Reserve media
dimensions and exercise loading/error fallback; download locally only when the delivery/offline
requirement calls for it. Disclose external image dependencies in existing preview notes.

Apply the parent skill's safety, accessibility, first-use, domain-transition, and interaction
checks. Show what the user can judge and change. Avoid unrequested galleries, sidecars,
new renderers, or real-service setup.

Exercise bindings before handoff:

- Reconcile the illustrative content with approved data/native/route scope before styling it:
  fields and totals need supported reads; evidence count must respect storage cardinality;
  read-only decisions must not acquire editing controls. No supplier, extra photo, tab, share,
  notification or offline state is added just because it appeared in a reference. Keep explicitly
  approved demo context separate from production; return necessary scope changes to foreground.
- Exercise each applicable scope/filter/search against its declared data source and affected
  surfaces. Keep displayed records, derived counts, and labels consistent. No out-of-scope record
  remains; an empty filtered result preserves and explains its scope. Independent views need
  not share a filter. Do not add search, filters, counters or mutations just to satisfy this check.
- A selected/scanned/deep-linked ID opens the exact record and correct parent context. Back
  restores the originating scope/filter/selection, or uses the approved direct-entry fallback.
- An enabled action must perform its declared local transition or expose an explicitly labeled
  out-of-scope destination. A toast saying "opened" without navigation is not a working journey.
  Native-only controls explain the boundary; scenario controls, not fake capture handlers,
  select illustrative captured/uploaded/location states. Do not silently clamp one entered
  business value when another changes; preserve invalid input and show the approved validation.
- Exercise compound filters, a different selected record, invalid input, and reset after edits,
  not just the happy path of the first example. Record actual before/after identity and state.
  "Control visible" or "still available" is not evidence that its action worked.
- Mock mutations, when part of the approved job, update only the declared records/states and
  dependent views. Reset restores the exact initial scenario; shared context stays synchronized.
- For phone previews at desktop and 320px widths, essential content/actions remain visible without horizontal
  overflow. Validate unique rendered IDs, reachable destinations, dialog focus/close/recovery,
  only declared verified image-media requests (no remote scripts or live data calls), and no
  unescaped user text.
- At the target device width, inspect container nesting and information density. Simplify
  borders, radii or shadows that add no meaning without flattening useful hierarchy or removing
  affordances. Confirm essential detail is legible and secondary detail remains reachable.
  Inspect every selected screen, including populated collections and detail states, not just
  the first/home screen. Check the full fixed-height viewport, internal scrolling, and bottom actions.

Do not report these checks from source inspection alone. Use available browser interaction;
if unavailable, state which binding and responsive checks remain unverified.

## Rendered experience review

This is a required authoring review before foreground design approval, not a beauty score or
an additional user gate. Apply it to every selected screen, not just Home. Use actual screenshots
alongside normal browser interaction; an accessibility snapshot or valid CSS alone cannot show
visual hierarchy. Inspect the target device viewport, internal scroll/bottom actions, 320px
reflow and every offered theme without resizing the target device to hide weaknesses.

| Check | Evidence to observe | Repair when |
|---|---|---|
| Context | Approved task, scope or selected-record identity is visible where needed | The screen could be mistaken for a different task or selected record |
| Hierarchy | The intended focal content/decision is distinguishable from supporting information and controls | Task priorities are flattened into equal-weight blocks or competing decoration |
| Decision/read evidence | Approved facts, prose, media or inputs needed for the next step are legible | Generic placeholders or missing facts prevent the intended comparison, reading or action |
| Media proportions (when relevant) | Visible subject size/crop relative to its media container supports recognition or reading | A tiny subject is lost in a large empty frame, or cropping removes task-relevant detail |
| Usable first viewport | Meaningful content begins; continuation and navigation are discoverable | Chrome, introduction or empty padding displaces the task, or essential content is clipped |
| Action placement | Required controls are legible and reachable with normal click/keyboard actions, including after scrolling | Overlays, clipping or decoration obscure an action or separate it from prerequisite evidence |
| State fidelity | Initial controls, records, counts and reset match the declared preview state | The illustration silently narrows scope, changes records or contradicts its labels |
| Density and typography | Actual text roles and effective hit areas remain usable in populated/long-content states | Tiny labels or controls make a dense screenshot fit, or excess chrome forces task facts out |
| Affordance fidelity | Icons, media and controls convey the accepted task and supported action | Letter abbreviations stand in for icons, decorative blocks masquerade as evidence, or an enabled control only shows a success-shaped toast |

Measure the **visible subject**, media container, usable app width/height and scrolling viewport
separately. An image element or SVG viewBox includes transparent/internal whitespace; its CSS
dimensions do not establish the subject's prominence. Inspect the rendered silhouette/crop,
using an explicitly labeled estimate if the visible bounds cannot be measured precisely.
Keep decorative bezels outside the intended app viewport; compare designs at the same usable
width rather than treating different bezel thicknesses as different content quality.

When an introduction/hero is present, report its height relative to the scrolling viewport
and which task content it displaces. Decide whether to shorten, remove or retain it based on
the job, not a universal percentage or a presumption that a hero is better. More records,
larger containers or an added hero are not evidence of better design. Preserve the fixture's
approved facts and representative variation; do not invent metadata to make it appear richer.

Only applicable task requirements can fail this review. No fixed hero, image, palette, card
count, density or screenshot-similarity target. A short reader with clear prose and retained
position can pass; a decorative introduction that pushes all reading below the fold cannot.
A scoped queue with distinguishable pending rows can pass without a banner; generic rows
missing the approved decision evidence cannot. Genuine empty/error scenarios pass when their
context, recovery and state fidelity are correct. Long content and large text may scroll;
do not shrink text or move every action above the fold merely to pass.

Record a compact handoff row per screen/state: `Screen/state | viewport/theme | observed
context, focal content and next step | pass/fail/unverified + reason | repair/recheck`.
Name visible regions/labels and measured geometry, not "looks polished". Reuse the existing
handoff; include subject/container proportions when media matters and viewport/chrome allocation
when it affects the task. Do not create a score file, duplicate design document, or approval receipt.
Record only checks actually executed. A global 48px CSS rule does not prove a locally overridden
stepper's hit area; inspect its computed box and normal pointer/keyboard reachability. User
acceptance of appearance does not turn missing screenshots, failed checks or native simulations
into verified results. Put preview limitations in compact review chrome, not repeated pinned
explanations that crowd the product UI.

Execute [rendered preview review](../../../shared/references/rendered-preview-review.md):
try an independent available browser path after an adapter failure, capture actual screens,
critique the realized treatment and validate the preview-bound observation record. This small
evidence record is not a score file or product authority. No observation can be inferred from
the HTML existing, a component recipe name, or a successful source validator.

If any applicable check fails, make **one focused repair pass**, then rerun the affected
visual and interaction checks. Do not restyle unrelated screens. Provisional visual changes
within fixed constraints need no new business gate; include them in the design handoff.
A fixed behavior/schema/route or explicit brand requirement
change returns `NEEDS_CONTEXT` for foreground approval. A known failure remaining after the
repair returns `BLOCKED: intent experience review failed` with the screen and reason; do not
silently lower the bar or loop indefinitely. If browser/screenshot tools are unavailable or
opening was declined, mark those checks unverified and return `DONE_WITH_CONCERNS`; do not
invent visual evidence or treat tool absence as a design failure. No repair is required after
a clean review. This procedure cannot guarantee aesthetic preference or native runtime behavior.

## Approval and implementation handoff

Return the preview path, selected screen IDs, scenario, checks, assumptions, and limitations.
Include `review_path`, `review_status` and actual browser attempts from rendered review.
Include any fact/action that lacks coverage in the existing plan. A visually successful
illustration is not ready for implementation until those needs are resolved by foreground.
The foreground collects changes and acceptance, updates affected existing screen specs/shared
conventions/design values, and records the accepted preview revision. No approval is inferred
from a rendered page.

The native builder receives the relevant accepted preview screen/interaction as a visual
reference alongside the updated spec, tokens, actual services, and typed skeleton.
It implements that direction using supported native components, not HTML-to-TSX conversion
and not an independently redesigned layout. Resolve material mismatches in foreground;
mock data and browser handlers are never copied as production persistence.
