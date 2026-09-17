# Native presentation handoff

Load after building or changing visible screens. This is a source/design fidelity handoff,
not a new design brief, another approval authority, or permission to change business behavior.
The accepted design is the minimum presentation baseline. A more distinctive design is welcome,
but dropping hierarchy, alignment, navigation cues or usable actions is not an acceptable tradeoff.
Do not tie that baseline to a particular model, industry, palette or screen template.

## Source scope and fidelity

Keep three results separate in the existing memory-bank handoff:

| Evidence | Establishes | Does not establish |
|---|---|---|
| Type/configuration/source-pattern tests | The specific tested properties and rules | Rendered layout, all contrast pairs or native behavior |
| Current source-derived full-screen preview | An approximation of the implemented composition and simulated journey | Native font metrics, device safe areas, authentication or connector execution |
| Current user-supplied device screenshots / requested native debugging | The observed device state and exact reproduced behavior | Untested screens, themes, text sizes or workflows |

Compare the actual source/configuration with the accepted design and approved specs.
Generate the source-derived HTML for the user to review; do not automatically exercise it,
capture screenshots or require browser evidence before completing this handoff.

Review the source of complete affected screens and necessary journey destinations, including
the surrounding header, content and footer. A shared-header change needs root and contextual examples; a gallery
of header or tab fragments is supplemental, not a substitute. Honor an explicit component-only
request, but do not claim it verifies full-screen quality. Do not expand a focused edit into
unrelated routes or automatically crawl the native app.

Record the exact source basis: selected routes, referenced local components, theme/font config,
and relevant local assets. Use `scripts/preview-provenance.js` to bind those reviewed inputs to
the generated HTML. Its `current` status checks freshness of that declared set only; it cannot
discover omitted dependencies or grant approval. A later source or preview edit requires a new
source/HTML comparison before recording provenance again; do not merely restamp stale output.
On the provenance `--check`, assert `--expect-mode implementation`, `--expect-scope full-screens`
(or `components` for an explicit component-only request) and repeat `--require-source` for every
selected screen plus its consumed local component, theme and typography files.
Derive this set from the reviewed source, not the recorded list.
Missing required inputs block the handoff without silently regenerating hashes.

## Check source/design fidelity

Preserve the reference's usable app dimensions, with preview bezels outside them. Inspect
source layout, scroll/inset ownership, offered theme styles and text-scaling behavior.
These checks do not measure rendered geometry, contrast, font metrics or effective hit areas.
Keep touch targets accessible; do not shrink all text or controls just to fit a screenshot.

| Surface | Inspect in current source against the accepted design |
|---|---|
| Typography | Actual component weight, line height and tracking, not only configured font roles. Plain native Text does not apply every role property just because its family and size are set. For wrapping action labels, override inherited Button.Text ellipsis; auto-height alone does not remove single-line truncation. |
| Header / Back | Clear Back ownership, intended row count, title/action alignment, visible labels or accessible icon names, no accidental duplicate header or safe-area padding. |
| Tabs / footer | Approved icon-label-selected-state contract, consistent targets, one owner for bottom insets, and content/action clearance. Inspect remaining task-space allocation for short and long content; remove repeated pinned explanations before shrinking controls. Do not force every screen to have tabs or sticky actions. |
| Repeated rows / cards | Deliberate alignment of comparable media, titles and actions; wrapping/long content and larger text remain usable. Do not impose equal heights on intentionally different content. |
| Media | Recognition, subject proportions, crop, resolution appropriate to display size, and stable loading/error layout. A sharp thumbnail is not proof of a suitable detail source or good artwork. |
| Primary action | Intended placement, scroll access and implemented feedback/recovery. Below-fold is not automatically a defect, but accidental clipping/overlap is. |
| Horizontal controls | The strip contains the complete target plus vertical padding and allows larger text; a valid button size inside a clipped viewport still fails. Review first/last options, selected states and native scrolling configuration. |

Trace one coherent illustrative journey through source handlers, including required recovery
and reset. Do not make the HTML look better by inventing styles, working handlers or image
sources absent from the native source; report those mismatches.
Use [typography integration](../../skills/design-system/references/tamagui-integration.md) and
[media sources](media-sources.md) for the corresponding repairs.

Summarize affected screen/state, accepted presentation and approved spec, actual source/component,
and any unresolved implementation gap in the existing handoff. No separate review record is required.
Compare content/identity order, density at unchanged type/target sizes, icons/media, action
placement and completion/recovery semantics. A matching palette or component interface is not
evidence that the accepted experience was implemented. Repeated treatments must use the actual
shared components, not separate approximations created by each builder.

## Manual preview delivery and requested testing

Deliver the `/preview-screens --mode implementation` output for the agreed full-screen or
explicit component-only scope. Open or link the HTML according to `visual_companion`; honor an
explicit preview opt-out. Stop after delivery. Do not automatically run browser interactions,
screenshot matrices, independent browser-adapter retries or visual repair loops. The absence
of browser testing in ordinary delivery is not a blocker or a `DONE_WITH_CONCERNS` prerequisite;
unobserved rendering remains unverified.

Browser testing runs only when the user explicitly requests it as a separate task. In that
requested scope, reload the preview from disk and compare at matching usable app dimensions;
do not equate downscaled multi-phone text with a full-resolution device screenshot.
Use ordinary clicks/keyboard for the requested journey, including its recovery and reset.
For a requested primary-action check, scroll to it and exercise it; report only actual observations.
Use user-supplied visual references and device screenshots without requiring new captures.
Neither a browser simulation nor design acceptance verifies native/device behavior.

## Outcome

- A missing required fact/action, unsupported capability, unreadable label or clipped primary
  control is not merely aesthetic. Repair verified failures or surface unresolved requirements
  before declaring the affected UX complete. Preferences about palette or optional decoration
  remain advisory. Missing rendered/native evidence remains explicitly unverified.
- Record source findings separately from any user-supplied observations or explicitly requested
  test results. Fix deterministic implementation drift before claiming the source/design
  handoff is complete; do not start an automatic browser test/repair cycle.
- If the accepted design must change materially, return to the foreground's existing approval
  gate. Do not freeze an early provisional layout or silently approve a redesign.
- Structural compile/route/configuration failures remain blockers. Report known nonblocking
  limitations without treating unrequested browser testing as a missing gate.
  An idle Metro terminal is not proof of runtime health.
- Runtime diagnosis remains user-requested `/debug-app` using sanitized `.powernative/metro-logs/`; no React Native Web,
  Metro HTTP probes, forced clicks or automated native screen crawling.
