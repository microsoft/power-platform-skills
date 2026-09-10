# Native presentation handoff

Load after building or changing visible screens. This is a review of implemented presentation,
not a new design brief, another approval authority, or permission to change business behavior.
The accepted design is the minimum presentation baseline. A more distinctive design is welcome,
but dropping hierarchy, alignment, navigation cues or usable actions is not an acceptable tradeoff.
Do not tie that baseline to a particular model, industry, palette or screen template.

## Evidence and scope

Keep three results separate in the existing memory-bank handoff:

| Evidence | Establishes | Does not establish |
|---|---|---|
| Type/configuration/source-pattern tests | The specific tested properties and rules | Rendered layout, all contrast pairs or native behavior |
| Current source-derived full-screen preview | An approximation of the implemented composition and simulated journey | Native font metrics, device safe areas, authentication or connector execution |
| Current user-supplied device screenshots / requested native debugging | The observed device state and exact reproduced behavior | Untested screens, themes, text sizes or workflows |

Review complete affected screens and necessary journey destinations, including the surrounding
header, content and footer. A shared-header change needs root and contextual examples; a gallery
of header or tab fragments is supplemental, not a substitute. Honor an explicit component-only
request, but label the remaining full-screen review unverified. Do not expand a focused edit into
unrelated routes or automatically crawl the native app.

Record the exact source basis: selected routes, referenced local components, theme/font config,
and relevant local assets. Use `scripts/preview-provenance.js` to bind those reviewed inputs to
the generated HTML. Its `current` status checks freshness of that declared set only; it cannot
discover omitted dependencies or grant approval. A later source or preview edit requires a new
comparison before recording provenance again. Reload the browser from disk before reviewing;
a newly captured screenshot of an old open tab is not evidence of the current file.

## Compare at the same usable viewport

Use the reference's usable app dimensions, with preview bezels outside them. Do not compare a
downscaled multi-phone canvas to a full-resolution device screenshot as if their text sizes were
equal. Check the target width and a narrow width, offered themes, and enlarged text/reflow.
Keep touch targets accessible; do not shrink all text or controls just to fit a screenshot.

| Surface | Inspect in current source and rendered approximation |
|---|---|
| Typography | Actual component weight, line height and tracking, not only configured font roles. Plain native Text does not apply every role property just because its family and size are set. |
| Header / Back | Clear Back ownership, intended row count, title/action alignment, visible labels or accessible icon names, no accidental duplicate header or safe-area padding. |
| Tabs / footer | Approved icon-label-selected-state contract, consistent targets, one owner for bottom insets, and content/action clearance. Measure the remaining task viewport with short and long content; remove repeated pinned explanations before shrinking controls. Do not force every screen to have tabs or sticky actions. |
| Repeated rows / cards | Deliberate alignment of comparable media, titles and actions; wrapping/long content and larger text remain usable. Do not impose equal heights on intentionally different content. |
| Media | Recognition, subject proportions, crop, resolution appropriate to display size, and stable loading/error layout. A sharp thumbnail is not proof of a suitable detail source or good artwork. |
| Primary action | Legible and discoverable placement; scroll to it and exercise it, including feedback/recovery. Below-fold is not automatically a defect, but accidental clipping/overlap is. |
| Horizontal controls | The strip contains the complete target plus vertical padding and allows larger text; a valid button size inside a clipped viewport still fails. Check first/last options, selected states and native scrolling. |

Test one coherent illustrative journey using ordinary clicks/keyboard, with its required recovery
and reset. Compare both appearance and handlers. Do not make the HTML look better by inventing
styles, working handlers or image sources absent from the native source; report those mismatches.
Use [typography integration](../../skills/design-system/references/tamagui-integration.md) and
[media sources](media-sources.md) for the corresponding repairs.

## Outcome

- Record source findings, rendered comparisons, measured geometry, exercised actions, and
  unavailable checks separately. Fix deterministic implementation drift before claiming the
  presentation handoff is complete; cap visual repair/review at two passes.
- If the accepted design must change materially, return to the foreground's existing approval
  gate. Do not freeze an early provisional layout or silently approve a redesign.
- If browser/device evidence is unavailable or the user opts out, report `DONE_WITH_CONCERNS`
  with the unverified scope, not a visual pass. Structural compile/route/configuration failures
  remain blockers. An idle Metro terminal is not proof of runtime health.
- Runtime diagnosis remains user-requested, terminal-driven `/debug-app`; no React Native Web,
  Metro HTTP probes, forced clicks or automated native screen crawling.
