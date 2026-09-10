# Phase 4 of 10 — Design

**Steps:** 6.75. **Previous:** [3 — Scaffold](phase-03-scaffold.md). **Next:** [5 — Authentication](phase-05-auth.md).
[Phase index](../SKILL.md#load-only-the-active-phase). Advance only after this phase's exit condition passes or its explicit opt-out is recorded.

Read only after the scaffold TypeScript gate and bank initialization.
`/design-system` is the sole owner of brand input, direction choice, tokens and design preview;
do not duplicate its style picker, token generator or HTML renderer here.

### Step 6.75 — Design system

If `--no-design` was explicit, preserve the plan's opt-out/deferred context, use the host baseline
with task-appropriate composition rather than an industry preset, and skip this phase (including visual preview). This flag does not skip approvals,
safe-area/accessibility rules or later TypeScript/quality checks.

Otherwise resolve the [one-time brand input choice](../../design-system/references/input-modes.md#one-time-input-choice)
in foreground before design generation. Offer existing references or AI inference only when
unanswered; reuse supplied material, an explicit choice, or an accepted design on resume.
Record `Brand input` in the existing memory bank; cancellation or an unanswered source request
remains `Pending decision`, not permission to proceed. No second picker inside the child.

Then invoke `/design-system --working-dir <working_dir>` in orchestrator mode
(`CODE_APPS_NATIVE_ORCHESTRATING=1`, or an explicit orchestrator context if the host does not
inherit environment between tool calls). Supply the approved plan path, confirmed brief and
workflow/domain context, platforms, brand-input choice and safe source references, known
brand/aesthetic constraints and visual-companion preference.
Also supply relevant record relationships, independent states/business rules, planned connector
reads/writes, approved native capabilities, and navigation/first-use behavior from existing plan
sections, including Experience outline, Information needs and their coverage rows. Pass compact
facts, not raw schema inventories or tool logs; no provisioning is needed
for the preview. Default to three representative main screens with coherent illustrative data.
Verify that the selection visibly demonstrates the primary working activity. If it only shows
entry/editor/confirmation while hiding the actual work surface, foreground revises the existing
Preview selection before rendering; preserve routes/operations and do not impose a fixed trio.
Request explicit `preview_mode: intent` (`/preview-screens --mode intent`), not auto-detection
from starter/auth routes. Do not make it rediscover already supplied answers.

Use the root status handler and verify the returned brand_path, tokens_path and preview_path
exist (`brand/design-system.md`, `brand/tokens.ts`, `_design_preview.html`, `preview_mode: intent`).
Choosing no brand input means context-led defaults with those artifacts, not a second
Field/Ops-only renderer or a missing preview. `integration: caller-required` is expected:
Step 9b applies the tokens; generation alone is not provider/font integration.
The preview uses locked `### Primary journeys` and `### Preview selection`, with illustrative local
interactions. It is not proof of native/data execution. Honor browser opt-out and show the actual link.

**Foreground design approval:** after the proposal/intent preview is ready, show consequential
choices and ask for accept / targeted revision through the permitted question tool.
Require the preview's compact per-screen rendered experience evidence first. Surface any
unverified screenshot/interaction checks with `DONE_WITH_CONCERNS`; a known unresolved review
failure blocks progression. Do not substitute artifact existence or TypeScript for visual review.
Require `review_path` and `review_status` from
[rendered preview review](../../../shared/references/rendered-preview-review.md). Re-run its
read-only `validate-preview-review.js` gate against the actual selected screens, target/reflow
viewports, offered themes and required sources. A `complete` result validates declared evidence
coverage only; inspect the observations/screenshots, not just that status.
Keep evidence coverage, observed usability and user acceptance distinct in the approval summary.
Do not turn a matrix count into a percentage of design quality or use acceptance to erase a
known wrong-record, unsupported-data or unreachable-action failure.
If every supported browser path failed or review was declined, surface the exact unverified
scope at this existing approval gate. Explicitly accepting it does not turn it into a visual pass.
The design child does not hold another creation approval gate. `DONE` alone is not acceptance.
On acceptance, record actual artifact paths, direction, confirmed status and `visual_companion`
in memory bank. Set `Approved preview` to the accepted intent path and exact plan/design revision,
clear that `Pending decision`, and update `Current phase` after validation. It is not runtime proof.
Continue to Step 7, not directly to data or builders.

The graph/spec gates in Step 3 were structural. Brand/design review belongs here, before screen
implementation. Inferred layout, media sizing and emphasis remain provisional until this review.
The designer may improve them within approved behavior and explicit brand constraints without
reopening business approvals; foreground presents the affected presentation delta here.
A graph change returns to Gate 4a; data/native/integration changes return to their gates.
If accepted design changes shared conventions/specs, send only affected specs back to
`mobile-app:screen-planner` with the locked graph and accepted visual reference to reconcile
presentation, not independently redesign it. Preserve approved operations and first-entry scope.
Before screen implementation, reconcile the accepted preview's hierarchy, layout and interactions
into those existing specs and design values. Builders use its relevant screen as a visual reference;
do not approve one experience and then independently redesign it during native generation.
Preserve the accepted first-viewport content order and below-fold access in Layout delta,
including deliberately selected preview states versus normal app entry.

Before that acceptance, reconcile the preview against approved data and operations using
[reference transfer](../../../shared/references/design-planning.md#entry-composition-and-reference-transfer).
Do not call a two-image gallery, extra tab or inline write a presentation-only delta when the
plan supports one image, different navigation or read-only rows. Style acceptance is not
acceptance of undisclosed scope changes or evidence that native controls have executed.
Carry the actual preview path, selected screen/state and observed review row forward with
each relevant builder's spec. Preserve failed/unverified checks in the memory handoff.
Include realized grouping, icon/media treatment and normal action hierarchy in that handoff;
do not copy preview-only simulator controls or expect native rendering to beautify the design.
Before accepting the preview, check its current provenance with `--expect-mode intent`,
`--expect-scope full-screens` and `--require-source` for the current plan, brand spec and tokens,
as documented by `/preview-screens`. Fresh hashes over an incomplete source set do not pass.
Re-run [information and interaction coverage](../../../shared/references/screen-data-coverage.md)
for any newly displayed fact, count, artifact or changed action. Resolve necessary data/capability
deltas through the existing gates before accepting that experience; pure layout changes preserve
supported needs and do not trigger unrelated metadata discovery.

**Receipt handoff:** `/design-system` never writes `.tmp/mobile-plan-status.json`.
Any change to `native-app-plan.md` before Step 8 invalidates its old plan-byte binding.
Use [approval-receipt.md](approval-receipt.md): show/reapprove affected design/spec deltas in
foreground and refresh hashes only after acceptance; preserve unchanged data approval.
The existing design review may explicitly accept that presentation/spec delta and complete
the screen-plan reapproval in one answer; no second identical confirmation is needed.
Do not blindly restamp the plan hash after a child returns `DONE`.
