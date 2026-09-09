# Optional Style Comparison

Read only when the user requests alternatives or passes `--compare`. Creation and reskin do not automatically enter this flow.

## Scope

- Reuse approved job/context and `### Primary journeys` / `### Preview selection` (legacy `### Primary Preview`) in `native-app-plan.md`, matching heading capitalization case-insensitively.
- Let the requested design question determine the representative screen/journey and number of alternatives. No mandatory three-up, first-List selection, or industry-keyword recommendation.
- Read only explicitly requested direction files from [the catalog](./design-directions.md). If the user wants fresh alternatives, infer meaningfully different task-appropriate approaches; named presets do not limit the design space.
- For an explicitly named reference brand, read only its linked example in [brand examples](./brand-examples.md), treating web-oriented patterns as inspiration rather than native capabilities.
- Supplied assets follow the applicable security policies in [input modes](../input-modes.md); do not execute imported HTML/config or fetch arbitrary dependencies.

## Author the comparison

Generate one `_design_vibe.html` with model-authored HTML/CSS using the [preview mapping](../../../../shared/references/tamagui-html-mapping.md). Keep the same illustrative scenario, job, information, required actions, and capability constraints across alternatives.

Design differences may include hierarchy, layout, media, density, and typography—not merely tinting identical cards. Conversely, do not force visual diversity where the user's alternatives intentionally differ only in palette.

Explain each option's task tradeoff briefly. Mark native-only simulations, resolve actual theme/font/token inputs, and provide useful navigation/actions if reviewing an entire journey. Accessibility and safety remain hard constraints; decorative similarity is advisory.

Respect `visual_companion`. Open and exercise via available browser tools, or provide the file link with an honest validation limitation. No new browser/renderer package is required.

## Apply selection

Accept a named pick, custom feedback, or a hybrid. Change only the requested dimensions; do not force a fallback winner because an arbitrary regeneration cap was reached.

Return the choice and concrete decisions to `/design-system`, which updates the existing plan/design record and ordinary brand files. If the project already contains `## Design Direction`, reconcile it using the [legacy block guidance](./design-bundle-schema.md); do not require a second bundle on new projects.

Regenerate `_design_preview.html` from the chosen design, then let the caller apply integration and any approved source changes. After source changes, `preview.html` must be regenerated from implementation, not copied from this comparison.
