# Rendered preview review

Run after authoring an intent or source-derived implementation preview, before claiming
its visual review is complete. This is an executed inspect/critique/repair loop, not a
second product planner or a guarantee of aesthetic preference.

## Establish the review scope

Use the current plan's Preview selection for intent; use the complete affected screens
for implementation. Include the primary working surface where users repeatedly read,
compare or act, not only an entry queue, a field editor and a final confirmation.
Use the same declared populated scenario and usable app dimensions as the preview.
Record target and 320px reflow sizes separately, and every offered theme. Read-only jobs
need no invented CTA; long content may scroll.

Use existing provenance write/check commands with required source assertions first.
Do not treat their `current` result, a successful typecheck or DOM presence as a visual pass.
Use `data-preview-screen-id="<Screen ID>"` on each complete reviewed frame so tools can
identify it without confusing review chrome with the application.

## Select a working browser path

Discover only tools actually advertised by the host. Prefer a suitable shared/integrated
browser page, then another independent available browser adapter. Names below describe
common capabilities, not mandatory tool names:

1. An integrated page interface may expose `openBrowserPage`, `readPage`, `screenshotPage`,
   and normal click/type actions. Reuse the current page when appropriate; reload from disk.
2. A separate browser adapter may expose Playwright navigation, snapshots, screenshots
   and interactions. Use it only with its actual supported arguments and URL protocols.
3. If neither works, open the file through the supported OS opener or provide its link for
   manual review. Opening a file is not completed screenshot/interaction verification.

One failed adapter does not mean all browser tools are unavailable. A locked profile,
unavailable connection or unsupported local-file protocol requires trying a genuinely
independent advertised path before declaring rendering unavailable. Calling `tabs` after
`navigate` on the same locked adapter is not an independent fallback. Do not loop repeated
attempts on a permanent failure or install another browser/framework to force a pass.

Never terminate the user's browser, delete profile locks, reuse private browsing data,
bypass a tool's access restriction or start Metro to review static HTML. Respect browser
opt-out. Record actual attempts and reasons in the existing handoff; do not simulate attempts.

### Calibrate capture before the matrix

First capture one complete frame and inspect the actual returned/saved image before taking the
remaining matrix. On integrated pages, requested browser viewport size, measured CSS geometry,
device pixel ratio and screenshot pixels can differ. Measure the usable app frame separately
from the browser/review canvas and decorative bezel; record it as `renderedViewport`. Check that
the image shows that full frame at readable scale, not a clipped region, blank canvas or thumbnail.
A file name containing `390x844`, a successful screenshot call or an element bounding box alone
does not establish usable evidence. Open saved files as well as tool-returned images.

After a resize/reload/scroll, wait for stable geometry and remeasure before capture. If an adapter
keeps returning inconsistent crops, try its supported screenshot interface or an independent
adapter once; otherwise mark the affected cases unverified. Do not collect a large invalid batch,
repeatedly restyle the app to compensate for capture artifacts, or alter DOM/CSS/theme state just
for screenshots. Exercise the offered theme and scenario controls normally; injected state is
not proof that those controls work.

## Inspect and critique the actual screens

Capture and inspect screenshots of every required frame at the target size, after internal
scrolling where needed, and at 320px reflow in each offered theme. Exercise normal pointer
and keyboard actions, including the primary local journey, recovery and reset. No forced
click or direct handler injection counts as reachability.
Record the action and observed result, including selected identity and changed local state;
visibility or "affordances remain available" is not an exercised interaction. Do not copy one
case's successful checks into untested viewport/theme cases. A read-only surface can demonstrate
selection, reading, scrolling and return without inventing a write.

Compare rendered output with the intended treatment, not merely with component names:

- Does the primary working activity visibly lead, with recognizable record/context?
- Are information groups coherent rather than unrelated equal-weight boxes?
- Do actual typography, spacing and effective targets preserve legibility at the chosen density?
- Are icons recognizable and decision-bearing media meaningfully represented?
- Are normal actions clear, correctly emphasized and reachable with their prerequisites?
- Are preview-only scenario controls and explanations outside the app composition?
- Do rendered records, counts, selected state and transitions agree with the approved scenario?

Names such as "comparison band" or "evidence rail" are not evidence of successful realization.
Do not fix every critique by adding cards, removing cards, shrinking text, changing the palette
or expanding the data model. Choose the smallest presentation repair that serves the job.
No supplied screenshot is required to perform this critique.

## Record evidence, not approval

Keep one small review record per preview mode under project-local `.tmp/`, for example
`.tmp/intent-preview-review.json` or `.tmp/implementation-preview-review.json`.
It contains observations of work actually performed, not a new design/data authority or a
beauty score. Never prefill successful observations before taking screenshots and interacting.
Screenshot outputs stay in the project or are referenced by their actual browser-tool output.

Get the current preview fingerprint after recording provenance:

```bash
node "${PLUGIN_ROOT}/scripts/validate-preview-review.js" \
  --project-root "<working_dir>" --preview "<preview.html>" --mode "<intent|implementation>" \
  --fingerprint --require-source "<required-source>"
```

Record one observation per reviewed screen/viewport/theme. `state` describes the actual
populated/recovery and scroll states inspected. `observation` describes visible hierarchy,
content, typography/density, icons/media, scrolling and action placement; `interaction`
names normal actions exercised and their observed results. Use multiple screenshot references
when both initial and scrolled states are needed. Each inspected observation records its own
`previewSha256` from the version actually captured; changing the top-level hash cannot refresh
old observations. A passing case also needs measured `renderedViewport` (usable app CSS width
and height, within 1px of its declared `viewport`). Leave either absent while unverified;
never copy desired dimensions into a measurement.

```json
{
  "version": 1,
  "previewSha256": "<fingerprint from the current preview>",
  "observations": [{
    "screenId": "<selected-screen-id>",
    "viewport": { "width": 390, "height": 844 },
    "theme": "light",
    "state": "Populated; initial viewport and scrolled actions",
    "status": "unverified",
    "observation": "Not inspected yet; replace only with actual observed findings.",
    "interaction": "",
    "screenshots": []
  }]
}
```

Screenshots use `{ "kind": "file", "path": ".tmp/<capture>.png", "sha256": "<hash of inspected image bytes>" }`
for a saved image or
`{ "kind": "tool", "reference": "<actual image-output reference>" }` when the tool only
returns an image in the conversation. Tool references and reviewer observations are declared
evidence: the validator cannot independently authenticate them or judge the image contents.
Use an actual output identifier, not a made-up caption that sounds like a tool call.
Missing per-observation bindings or file hashes leave older records incomplete; changed HTML
or screenshot bytes make their bound evidence stale. The validator never backfills evidence.
Do not put screenshots or review records into the preview's source list; they are outputs
of review, not circular authoring inputs.

Validate against the intended scope, not whatever observations happened to be recorded:

```bash
node "${PLUGIN_ROOT}/scripts/validate-preview-review.js" \
  --project-root "<working_dir>" --preview "<preview.html>" --mode "<intent|implementation>" \
  --review ".tmp/<mode>-preview-review.json" \
  --screen-id "<selected-screen-id>" --viewport 390x844 --viewport 320x844 --theme light \
  --require-source "<required-source>"
```

Repeat `--screen-id`, `--theme` and `--require-source` for the current selected screens,
offered themes and plan/brand or source/config inputs. Substitute actual target dimensions.
The command is read-only and exits nonzero for missing, stale, failed or unverified evidence.
`complete` means the declared current review coverage is complete, not that the app is
beautiful, semantically correct, approved or native-verified.

## Repair and hand off

Collect findings across the selected screens before editing, then make one focused repair pass
and recheck affected visual and interaction behavior. Preserve scope and unrelated presentation.
Do not alternate every screenshot with another micro-restyle or repeatedly announce a final
version while still discovering defects. Freeze candidate source/HTML bytes before the final
review matrix. Regenerate/check
provenance after an HTML edit, then record current screenshot/interaction evidence against
the new fingerprint; old observations must not be silently restamped as a new review. The same
applies if accepted plan/design reconciliation changes a provenance source: refresh provenance,
reload and review the final bound artifact instead of only updating its review hash.

A remaining required failure returns `BLOCKED` with the screen and reason. Missing evidence
returns `DONE_WITH_CONCERNS: visual review incomplete` with precise missing cases; never a
visual pass. Browser opt-out/unavailability does not waive factual reporting. Foreground's
existing design review may capture the user's explicit decision to proceed with that
unverified scope, but cannot relabel it verified.

Return actual browser attempts, evidence record path, validator result, observed findings,
repairs and remaining gaps in the existing handoff. The foreground records approval separately.
Report evidence coverage, observed usability and user acceptance separately. A `complete`
declaration is not permission to dismiss a known wrong-record action, clipped decision-bearing
fact, unsupported read, or unresolved failed check.
Native builders preserve the accepted treatment; they are not a later beautification stage.
