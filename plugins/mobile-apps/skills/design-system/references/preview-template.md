# Optional Component Gallery

Read only for `--gallery` or an explicit component-reference request. Ordinary design produces one journey preview, not this gallery.

## Inputs and output

**Telemetry checkpoint: `render_design_system_gallery`**

Read the current compact `brand/design-system.md`, `brand/tokens.ts`, and relevant resolved theme/font configuration. Model-author `brand/design-system.html`; do not promise a deterministic zero-cost render or introduce a renderer dependency.

Use [HTML mapping](../../../shared/references/tamagui-html-mapping.md) for actual token/theme/typography projection and safety. The gallery is an adaptable reference sheet, not a fixed template that dictates app composition.

Include only what helps the request:

- Palette/status samples labeled with actual token names/values and intended roles.
- Typography roles using the configured family, weight, size, line-height, and tracking.
- Relevant components and their meaningful focus/disabled/error/selected states.
- A representative journey screen only if useful; reuse the plan's selected screen ID and scenario rather than choosing the first List.
- Explicit negatives and known native/browser/font limitations.

Both advertised themes must use resolved values; define every CSS variable used. No hardcoded white foreground on arbitrary accent/status fills. Test their contrast. Use local approved font assets or a disclosed fallback; no remote Google Fonts import.

## Review

Write semantic, keyboard-operable HTML with labels, visible focus, non-color state cues, and reflow. Component demos may simulate local state; native actions stay labeled placeholders. No service calls, tenant writes, imported scripts, or analytics.

Respect `visual_companion`; use existing browser tools to inspect relevant states when available. Otherwise provide the link and report the browser-validation gap.

The gallery supplements `_design_preview.html`; it never replaces the primary-journey intent review and must not be presented as source-derived `preview.html`. Record its optional path only if actually generated.
