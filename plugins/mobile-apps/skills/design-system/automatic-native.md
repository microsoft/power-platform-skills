# Automatic Native Design

This is the complete model-facing instruction set for prompt-only prototype
design. All product decisions already live in approved contracts; this mode
performs no additional model call.

## Inputs

Consume only the approved local machine contracts used by
`compile-native-prototype-design.js`: semantic plan, Experience, Context,
Workflow/Journey, Screen, Foundation, Navigation, Domain, and Execution. Do not
read Markdown plans, design references, brand material, screenshots, Figma,
HTML, galleries, or sibling apps.

## Universal UX Rules

- Preserve semantic product roles, permanent Home, launch/resume routing,
  bounded-flow ownership, first-viewport hierarchy, exact actions, states,
  capability placement, media policy, and hard negatives.
- Keep one obvious focal point and one primary action when the state requires
  immediate action. Do not repeat headers or fill useful space with decoration.
- Use semantic tokens only. Selection, warning, error, destructive, and brand
  roles remain distinct. Never infer a real organization's palette or marks.
- Cards communicate grouping, navigation, selection, or emphasis; do not wrap
  every section in a card.
- Required product, place, person, document, or evidence media cannot become an
  icon or color block. Offline-critical required media cannot be remote-only.
- Optional capabilities open on demand and remain subordinate to the owning
  job. Preserve permission, unavailable, denied, failure, offline, and manual
  fallbacks. Only evidence-backed immersive utilities may dominate Home.
- Loading, empty, error, offline, permission, partial-data, success, and
  recovery states retain the selected hierarchy and visual character.
- Preserve Dynamic Type, screen-reader names/roles/values/hints, logical focus,
  modal containment, non-color cues, 44-point targets, reduced motion,
  keyboard reachability, sticky-action clearance, and safe areas.
- Navigation styling consumes the final Navigation Contract. It cannot change
  tabs versus stack, order, nested ownership, visibility, launch, resume, deep
  links, back, completion, or cancel behavior.

## Compile And Validate

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-native-prototype-design.js" \
  --project-root "<working_dir>"
node "${CLAUDE_SKILL_DIR}/../../scripts/validate-native-prototype-design.js" \
  --project-root "<working_dir>"
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-design-instruction-manifest.js" \
  --project-root "<working_dir>" --mode automatic-native
```

The compiler owns the strict recipe, byte-stable tokens, Tamagui platform
mapping, signature/Foundation components and registry, source bindings,
ownership manifest, and atomic writes. The validator checks preservation,
contrast, hierarchy, media/offline policy, Navigation chrome, states,
accessibility, and deterministic bytes.

Any missing AI-owned decision is `BLOCKED`. Do not ask a design question unless
approved inputs contradict each other materially; absence of brand input is not
ambiguity.
