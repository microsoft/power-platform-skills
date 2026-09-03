# Final Experience Preview

Use this workflow only inside the design-system model execution that has just
materialized the approved design. The model authors `_plan_preview.html`;
deterministic code prepares and validates its contract but never chooses the
final composition.

## Prepare the contract

After writing and drift-checking `brand/design-system.md`, `brand/tokens.ts`,
and `brand/signature-components.ts`, run:

```bash
node "${PLUGIN_ROOT}/scripts/compile-screen-build-pack.js" \
  --project-root "<working_dir>" --check
node "${PLUGIN_ROOT}/scripts/validate-fixture-scenarios.js" \
  --project-root "<working_dir>" --check
node "${PLUGIN_ROOT}/scripts/validate-product-experience-preview.js" \
  --project-root "<working_dir>" \
  --contract-output "<working_dir>/.tmp/product-experience-final-preview-contract.json"
```

These commands are execution-only. Do not glob, grep, search, or read
`${PLUGIN_ROOT}/scripts` before or after running them. Never inspect validator
implementation or test output to author or repair the preview; use only the
emitted finding codes and messages.

This command is mandatory and its canonical output file must remain present for
React Native screen builders. If it fails, repair the generated brand artifact
named by the finding and rerun this same command. Do not author
`_plan_preview.html` until the command returns `"ok": true`. Do not substitute
Python HTML parsing, a custom script, visual inspection, TypeScript compilation,
or a different sidecar path for this command.

Keep the prepared full contract for deterministic validators and native screen
builders, but do not read it for HTML authoring. Read only
`.tmp/product-experience-preview-authoring.json`, the compact projection of the
same experience directive, selected screen packs and rationale, first viewport,
navigation, scenario values, generated tokens, signature contracts, actions,
states, and prohibited defaults. Do not edit either projection or replace its
screen selection.

If preparation returns `NEEDS_CONTEXT`, stop and return the exact finding to the
planning owner. Never reorder journeys or rewrite screen, navigation, or
scenario authorities to obtain different frames.

Test fixtures, snapshots, and benchmark implementations are prohibited
authoring inputs. Generate the experience only from the current run's contracts
and approved design references. Never read a previous `_plan_preview.html` as an
input; author the current file from the prepared contract and generated brand
artifacts only.

## Author the HTML

Write one self-contained `<working_dir>/_plan_preview.html` in this same model
execution. Exercise design judgment from the generated design system rather
than translating a universal phone template. Different products must earn
different composition, hierarchy, type treatment, density, imagery, status
treatment, and interaction emphasis. Product vocabulary alone may not choose a
style, and color changes alone do not count as a different composition.

Each selected frame must look like a credible mobile product screen at first
glance, not documentation, a schema viewer, a requirement list, or a contract
dump. Give it one bounded phone surface, intentional hierarchy, styled product
navigation, realistic controls/content components, coherent spacing, one clear
focal point, and one unmistakable primary action. Preserve the approved visual
character and let each screen's job change its composition; do not repeat one
shell with renamed labels.

The selected frames tell one coherent primary-journey story. Preserve every
approved job, route, action, first-viewport order, media meaning, trust signal,
state, and signature intent. Use only canonical scenario values. Keep only the
scenario evidence needed to understand the decision or action in each phone
frame: at least one value when evidence exists, at most eight values and 640
evidence characters. Put remaining scenario evidence, exact state copy,
signature rationale, approved requirement statements, and the complete graph in
one compact collapsed review. The review proves coverage; it must not dominate
the product storyboard.

The HTML must satisfy this mechanical envelope while all visual markup and CSS
outside it remain model-authored:

1. Use `<!doctype html>`, semantic HTML, responsive layout, keyboard-operable
   controls, focus styles, and reduced-motion handling.
2. Set `<body data-preview-mode="final"
   data-preview-authorship="design-system-model"
   data-preview-contract-revision="<contractRevision>">` using the exact
   revision returned by contract preparation and stored in the sidecar.
3. Copy `designTokens.css` exactly into
   `<style id="product-experience-token-contract">`. Use those CSS variables
   throughout a separate substantive authored stylesheet; do not add alternate
   hard-coded brand colors. The authored stylesheet must visibly affect page
   background, typography, storyboard layout, phone frames, navigation,
   components, actions, and the review index, and include a responsive rule.
4. Do not copy the complete contract JSON into the HTML. Keep the prepared
   sidecar as the authoring input; the validator reconstructs it from canonical
   artifacts and binds the HTML through `data-preview-contract-revision` plus
   the visible markers below.
5. Use `<nav id="preview-navigation">`, `<main id="preview-storyboard">`, and
   `<section id="preview-all-screens">` landmarks.
6. Put every `selectedScreenId` in one visible storyboard element using
   `data-preview-screen-id="<screenId>"` and its exact
   `data-pack-revision="<packRevision>"`, in contract order. Inside it, provide
   exactly one `data-mobile-frame="<screenId>"` with bounded phone dimensions,
   surface/edge treatment, internal spacing, and declared overflow behavior.
7. Inside each phone frame, provide one
   `data-first-viewport="<screenId>"`. Render every canonical
   `firstViewport.regionOrder` entry once and in order as
   `data-viewport-region="<regionName>"`. Mark the single focal element
   `data-focal-point="<screenId>"`.
8. Use at least two meaningfully named `data-product-component` regions per
   frame. Visibly realize the signature interaction inside the frame with
   `data-signature-component="<screenId>"`. Put its exact name and description
   in the collapsed review under `data-signature-intent="<screenId>"`.
9. Mark every primary action with its contract `markerId` as
   `data-primary-action="<markerId>"`, retain the exact action label, and when
   present set `data-target-screen-id="<targetScreenId>"`. Keep it inside the
   first viewport's `primary-action` region and visibly usable. Mark exactly
   the first canonical primary action as
   `data-primary-emphasis="<markerId>"`; it is the frame's single strongest
   action even when the contract includes additional primary actions.
10. Mark every state as `data-preview-state="<screenId>:<stateName>"` and retain
   its exact state copy in the collapsed review. Product UI may demonstrate a
   decision-relevant state without repeating exact contract prose.
11. Mark each canonical media surface with
    `data-media-asset-key="<assetKey>"`. Preserve its role, crop intent,
    fallback, and decision-support meaning.
12. Render every `scenarioEvidence` value exactly once and mark the nearest
    containing element `data-scenario-evidence-id="<evidenceId>"`. Keep only
    decision-relevant values in its owning phone frame and put the rest in the
    collapsed review.
13. Render every durable navigation destination inside the navigation landmark
   with `data-navigation-destination="<destinationId>"`,
    `data-navigation-target-path="<targetPath>"`, and its exact label. Style the
    landmark and destinations as product navigation rather than raw links.
14. Inside `#preview-all-screens`, add one closed `<details>` with a keyboard-
    operable `<summary>`. Put every `allScreenId` inside one compact styled
    `data-screen-index` region using `data-all-screen-id="<screenId>"`.
15. Render every approved shipping requirement exactly once inside that closed
    review with `data-requirement-id="<requirementId>"` and its exact statement.

Do not expose contract JSON as visible copy. Do not use Lorem Ipsum, generic
sample values, TODO/TBD text, explanatory prototype copy, or labels from the
neutral structural renderer. Do not load external scripts. Canonical HTTPS
media assets are allowed; every asset still needs its declared fallback.
Use the HTML `hidden` or `aria-hidden` state for inactive optional panels. Do not
apply stylesheet `display: none`, `visibility: hidden`, or
`content-visibility: hidden` rules to required landmarks, screens, signatures,
actions, media, scenario evidence, navigation, requirements, or their ancestors.

## Validate and repair

Run:

```bash
node "${PLUGIN_ROOT}/scripts/validate-product-experience-preview.js" \
  --project-root "<working_dir>"
```

This exact command is the only completion validator for the final preview. A
custom HTML parser, browser glance, file-size check, or TypeScript check is not a
substitute. Preserve
`.tmp/product-experience-final-preview-contract.json` after it passes, and do
not return `DONE` unless the command's JSON contains literal `"ok": true` plus
zero fixture-isolation findings.

Before returning any status, run packaged
`design-run-ownership.js --project-root "<working_dir>" --verify`. It restores
an immutable or out-of-allowlist write and returns `NEEDS_DESIGN_REPAIR`; repair
only design artifacts against the preserved plan. Never regenerate the plan.

The validator always runs semantic-contract validation plus a portable
parser-based structural quality gate. That mandatory gate catches ineffective
authored styling, missing phone frames or hierarchy, excessive visible evidence,
unstyled navigation/indexes, repeated shells, and contract-dump composition.
The optional adapter prefers an available agent/in-app browser, then a connected
Chrome or Edge, then a locally installed Chromium-family executable. It serves
the static HTML from memory on an OS-selected `127.0.0.1` port, measures three
mobile widths, and always stops the server afterward. It never installs a
browser, starts Metro, binds externally, uploads data, or inspects React Native
source. Results are `passed`, `failed`, or `skipped: browser-unavailable`.
Failure is non-blocking visual evidence; unavailability emits
`layout-validation-skipped`. Parser and semantic gates still run.
Browser absence is always non-blocking and never implies complete visual validation.

If authored-HTML semantic or mandatory structural findings fail, stay in this existing
design-system model execution. Feed the exact finding codes/messages back into one focused edit of
`_plan_preview.html`, preserving the current Product Experience,
`experienceDirective`, tokens, signature components, navigation, scenario facts,
and screen packs. Rerun the same validator exactly once. If only cosmetic
structural findings remain, return `DONE_WITH_CONCERNS` and continue app
generation. Use `BLOCKED` only for unsafe/unsupported capability, missing
explicit requirements, invalid relationships that prevent compilation, or
uncompilable output. Do not rerun planning, regenerate
the design system, invoke another model, or attempt a second repair.

After the focused repair, remaining preview-only semantic, styling, hierarchy,
layout, or browser findings are concerns, not app-generation blockers. Preserve
their exact codes in provenance and continue without substituting deterministic
HTML. Route genuinely missing product requirements or uncompilable planning
contracts to their owner.

`render-product-experience-preview.js` is a separate diagnostic. It always uses
neutral styling and writes `_plan_preview.structural.html`; it cannot create or
overwrite `_plan_preview.html`, and its output cannot advance Gate 3.

The final HTML approves design and experience intent only. React Native remains
authoritative after implementation. Do not inspect generated React Native TSX
with AST or regex, claim native rendering or pixel verification, or start Metro
here.