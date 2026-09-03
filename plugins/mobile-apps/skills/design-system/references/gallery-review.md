# Gallery and Review Workflow

Use this workflow only after Full design or Spec + reference is explicitly
selected. The component gallery is optional; the journey preview remains
mandatory in orchestrated projects.

## Deterministic component gallery

Render `brand/design-system.html` from `brand/design-system.md` and
`brand/tokens.ts` using [`preview-template.md`](./preview-template.md). This is a
zero-model-cost projection and includes:

1. app name, direction, timestamp, and provenance;
2. palette and status swatches with token names and values;
3. the typography ladder at actual sizes and weights;
4. button, input, card, list-row, badge, and status variants and states;
5. one representative phone using the approved hierarchy and scenario facts;
6. accessibility decisions and forbidden-pattern summary.

Do not invent a component or screen solely to fill the gallery. Open the local
file when a visual companion is enabled; otherwise print its absolute file URL.

## Confirmation

Present direction, palette, typography, density and touch target, component and
negative counts, plus applied brand input. Allow one action at a time:

```text
[confirm]
[edit palette]
[edit typography]
[edit components]
[edit negatives]
[edit density]
[regenerate]
[skip - use as draft]
```

Refuse bundled dimension edits and ask which one to apply first. For one edit,
change only that design-system section, regenerate matching tokens and signature
presentation contracts, rerender the gallery, and show the summary again.
`regenerate` returns to style selection and counts against the two-attempt cap.

## Journey preview

For an orchestrated project, require current `native-app-plan.md`, Workflow
Journey, navigation manifest, compiled screen packs, scenario facts, and all
three generated brand artifacts. Read and execute
[`final-experience-preview.md`](./final-experience-preview.md) in this same
design-system model invocation: prepare the manifest, author
`_plan_preview.html` from the confirmed design, then validate it. Do not invoke
another model and do not substitute the neutral structural renderer.

Any applicable contract, token, signature-component, scenario, or final HTML
validation failure is `BLOCKED`.

The default `_plan_preview.html` board shows one to three phones: entry/root,
signature/core action, and outcome/review where distinct. `All screens` exposes
the complete planned graph and states. Tabs and actions may focus or scroll, but
must not replace or hide another storyboard phone.

Use canonical scenario facts, navigation, identity hierarchy, media keys, first
viewport, trust signals, actions, and screen contracts. Reject generic CRUD and
same-template composition with palette-only variation. This HTML approves
intent; it does not claim React Native or native pixels were rendered. Never
start Metro or capture native screenshots here.

Standalone projects with no plan may skip the journey preview after an explicit
choice. When a plan exists, skip is unavailable.

## Persist and return

Append timestamp, direction, confirmed/draft state, brand notes, artifact paths,
and `visual_companion` to `memory-bank.md`. In orchestrator mode return:

```text
DONE
brand_path: brand/design-system.md
tokens_path: brand/tokens.ts
signature_components_path: brand/signature-components.ts
gallery_path: brand/design-system.html
experience_preview_path: _plan_preview.html
direction: <locked direction>
visual_personality: <approved value>
visual_companion: <yes|no|skip>
```

Do not return `DONE` when required artifacts or checks are missing.