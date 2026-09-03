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

Read the prepared contract. It is a projection of the same canonical
authorities supplied to native screen builders: the root experience directive,
semantically selected screen packs, navigation, scenario facts, generated
tokens, and signature-component revision. Do not edit it or replace its screen
selection.

## Author the HTML

Write one self-contained `<working_dir>/_plan_preview.html` in this same model
execution. Exercise design judgment from the generated design system rather
than translating a universal phone template. Different products must earn
different composition, hierarchy, type treatment, density, imagery, status
treatment, and interaction emphasis. Product vocabulary alone may not choose a
style, and color changes alone do not count as a different composition.

The selected frames tell one coherent primary-journey story. Preserve every
approved job, route, action, first-viewport order, media meaning, trust signal,
state, and signature intent. Use only canonical scenario values. Expose the
complete graph in a compact `All screens` review surface without giving every
route an equal-weight phone frame.

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
   throughout the authored design; do not add alternate hard-coded brand
   colors.
4. Do not copy the complete contract JSON into the HTML. Keep the prepared
   sidecar as the authoring input; the validator reconstructs it from canonical
   artifacts and binds the HTML through `data-preview-contract-revision` plus
   the visible markers below.
5. Use `<nav id="preview-navigation">`, `<main id="preview-storyboard">`, and
   `<section id="preview-all-screens">` landmarks.
6. Put every `selectedScreenId` in one visible storyboard element using
   `data-preview-screen-id="<screenId>"` and its exact
   `data-pack-revision="<packRevision>"`, in contract order.
7. Inside its screen element, visibly render signature name and description in
   an element marked `data-signature-intent="<screenId>"`.
8. Mark every primary action with its contract `markerId` as
   `data-primary-action="<markerId>"`, retain the exact action label, and when
   present set `data-target-screen-id="<targetScreenId>"`.
9. Mark every state as `data-preview-state="<screenId>:<stateName>"` and retain
   its exact state copy. States may use tabs, segmented controls, disclosure, or
   another accessible model-owned treatment.
10. Mark each canonical media surface with
    `data-media-asset-key="<assetKey>"`. Preserve its role, crop intent,
    fallback, and decision-support meaning.
11. Render every `scenarioEvidence` value as visible text inside its owning
    screen and mark the nearest containing element with
    `data-scenario-evidence-id="<evidenceId>"`.
12. Render every durable navigation destination inside the navigation landmark
   with `data-navigation-destination="<destinationId>"`,
   `data-navigation-target-path="<targetPath>"`, and its exact label.
13. Render every `allScreenId` inside the All screens landmark with
    `data-all-screen-id="<screenId>"`.
14. Render every approved requirement exactly once, either in its selected
   storyboard frame or in the compact All screens review surface, with
   `data-requirement-id="<requirementId>"` and its exact statement.

Do not expose contract JSON as visible copy. Do not use Lorem Ipsum, generic
sample values, TODO/TBD text, explanatory prototype copy, or labels from the
neutral structural renderer. Do not load external scripts. Canonical HTTPS
media assets are allowed; every asset still needs its declared fallback.

## Validate and repair

Run:

```bash
node "${PLUGIN_ROOT}/scripts/validate-product-experience-preview.js" \
  --project-root "<working_dir>"
```

Fix the authored HTML and rerun the same validator until it passes. A contract,
token, scenario, navigation, signature, action, state, media, landmark,
placeholder, or authorship finding is `BLOCKED`; never replace the final file
with deterministic output.

`render-product-experience-preview.js` is a separate diagnostic. It always uses
neutral styling and writes `_plan_preview.structural.html`; it cannot create or
overwrite `_plan_preview.html`, and its output cannot advance Gate 3.

The final HTML approves design and experience intent only. React Native remains
authoritative after implementation; do not claim native rendering or pixel
verification and do not start Metro here.