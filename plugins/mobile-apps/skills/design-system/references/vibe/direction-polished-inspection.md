# Optional Direction: Polished Inspection

Use only when explicitly requested. This is not the no-brand or first-run default and carries no special industry routing.

## Character

Light neutral surfaces, a green action accent, clear status labels, generous targets, and confident sans-serif hierarchy. Useful when that treatment supports the requested operational job—not because a demo or industry name implies it.

## Starting palette

| Role | Candidate |
|---|---|
| Background / surface | `#ffffff` / `#f9fafb` |
| Primary / accent | `#007d48` |
| Text / muted | `#0f172a` / `#52606d` |
| Border | `#74838f` |
| Success / warning / danger / info | `#22683b` / `#805400` / `#a12424` / `#224e73` |

These are starting values, not production-validation claims. Materialize the normal [brand export](../design-system-schema.md), resolve host aliases, and contrast-test actual foreground/background pairs in both themes.

## Adapt to the task

- Status stripes or soft-tinted pills can support scanning; do not apply them to every card or encode status through color alone.
- Use a supported sans family and appropriate weights. Do not assume Inter or a custom face is installed.
- Choose row/card/sequence layouts, action position, and media from the primary journey. No fixed FAB, bottom-pinned CTA, or three-card composition.
- Preserve at least 44pt iOS / 48dp Android targets; increase for actual glove/motion context.
- Motion supports orientation/feedback and respects reduced motion.

Only explicit user negatives become style requirements. Contrast, labeling, supported native behavior, and coherent tokens are hard constraints; exact pill shapes, accent ratios, and card counts are advisory.
