# Readable, coherent classic styling

Read for a new visual treatment, palette/background, typography, or readability fix. Skip for isolated spacing/radius changes. Read and apply [shared site design quality](../../../references/site-design-quality.md) for the visual principles; this adapter owns their classic-site application. [Create-site's code-site adapter](../../create-site/references/design-aesthetics.md) is a separate execution path: **do not execute that SPA workflow** or generate a preview.

## Design the complete treatment

- Match the user's approved direction. An explicit new-site design brief allows intentionally establishing a complete cohesive visual identity, not just preserving the downloaded template's appearance. Existing-site narrow changes remain preservation-first: preserve the site aesthetic unless a redesign was requested. Apply the shared aesthetic/mood, hierarchy, spacing, responsive-composition and imagery guidance in either case.
- Apply the shared coordinated palette roles to the actual components. A background change includes all text and interactive states on that background, not just the container.
- Reuse existing approved fonts, tokens and Bootstrap spacing/grid conventions where suitable. Newly approved fonts may be imported through [author-web-file](../../classic-site-skills/author-web-file/SKILL.md) and applied with reviewed `style-site` CSS, including appropriate `@font-face` definitions and fallback stacks. Do not import the SPA reference's font bans/downloads, theme.css rewrite or dependency installation. General CSS fonts, tokens, animation and explicit global themes are supported through the reviewed classic-site contract, not the SPA workflow.
- Define reusable site-global tokens/classes in custom CSS with explicit scope and expanded review, not by rewriting protected defaults. Preserve native DOM, Liquid, component IDs, accessibility/Studio markers, Bootstrap assets, `theme.css`, `portalbasictheme.css`, and existing default-file ordering. A new identity does not authorize replacing native components or unrelated source.
- Inspect actual **heading, paragraph, nested span, link and button source/rules**, including existing inline styles and Bootstrap utilities. A white container `color` does not override a child's explicit dark color. A requested token may resolve differently in the site theme. Optional separately consented runtime discovery can clarify the existing cascade, not verify the proposed local patch.
- Choose the verified local declaration **per property before choosing placement**. Native Studio typography/colors do not require handoffs: update an existing static child inline declaration when it wins; otherwise use effective scoped CSS. Add a quoted style attribute only where it is the right component representation, not a blanket palette technique. Preserve exact-property inline importance. Authored `!important` requires `importantReason` and expanded review; do not blindly add it or raise specificity/remove classes to evade a winning declaration. If the child edit is ambiguous or unrepresentable, block the dependent background with a specific local source-repair step.

Use the [component Design-panel map](studio-component-capabilities.md) to describe availability, not exclusive ownership. For example, `color` is not listed in this panel; other theme/text-toolbar surfaces are separate, not a prohibition on local color edits. Retain the unlisted warning without inventing a control. Text shadow is listed for Text but not Button; both default to local authoring, with different support warnings. Native support alone never forces a handoff. `owner: "studio"` requires explicitly requested instructions-only intent, `handoffReason: "user-requested"` and `studioAction`.

For a **verified local-source** hero whose actual source uses `h2`, `p` and `.btn`, with no winning inline declarations blocking these stylesheet rules, a dark palette might be:

| Request `part` | Role | Example declarations |
|---|---|---|
| omitted | Surface/default text | `background-color: #111827`, `color: #f9fafb`, `padding: 24px` |
| `" h2"` | Explicit heading foreground | `color: #f9fafb` |
| `" p"` | Body foreground | `color: #d1d5db` |
| `" .btn"` | Paired action colors | `background-color: #2563eb`, `color: #ffffff` |

These are separate stylesheet groups on the same verified `pp-*` component, not a universal theme. If an inline heading color wins, use a separate exact-tag inline group instead of the ineffective `" h2"` rule; see the [inline contract](proposal-and-verification.md#guarded-inline-declarations). Verify the actual heading tag; do not assume `h2`. Use `small`, `.text-muted`, `a` or a separately verified child hook only where needed. Apply at the already-resolved locale/scope/cascade position. Include hover/focus foreground/background pairs when those states change. Reuse unchanged, already-readable roles rather than emitting redundant rules. Do not paint every descendant white with `*`; that breaks light buttons, fields, and nested surfaces.

When responsive/state rules need to replace a winning inline property, the inline group may explicitly remove that exact existing property using `null` and supply scoped CSS in the same approved plan. Preserve other inline declarations/priority and inspect all affected states. Removing a shorthand removes its whole declaration; retain needed longhands in the planned treatment. Null is an inline-only request directive, not a CSS value or a gradient-specific workaround.

These parts are examples, not a closed list. Use general declarations or a raw responsive stylesheet for the requested design, including font stacks, shadows, layout functions, transitions, transforms, tokens and all gradient kinds. Check logical visual order against DOM/keyboard order. For animations, add `prefers-reduced-motion` alternatives and preserve visibility/function without motion. Namespace new keyframe/font/property/layer names with `pp-`/`--pp-`, or explicitly review shared naming with raw `global: true`. Global themes affect all matching elements in their placement scope and require expanded review. Review font/resource licensing, availability and CSP; external HTTPS references require exact `externalResources`, not automatic fetching.

## Deliver imagery through the existing asset workflow

Apply the shared hero/supporting-image art direction to new-site visual treatments, while honoring a bare-baseline request or explicit image decline; do not force image acquisition for existing-site narrow edits. Follow [visual asset planning](../../customize-declarative-site/references/visual-asset-planning.md) for provenance, legal/privacy/user approval and the selected delivery mode. During creation, add images using direct approved HTTPS URLs, not image downloads or new Web Files. Existing template images can remain. Local-only or newly generated illustrations need an approved hosted URL for this route; never publish them automatically.

Pass external image URLs directly to the native content owner, retaining responsive sizing and localized alt text; CSS image URLs also require exact `externalResources`. Review remote availability, hotlink policy, privacy and CSP without automatic fetching or implicit policy changes. Do not guess photo IDs or use placeholders. Outside URL-based creation, explicit Web File imports still use `${PLUGIN_ROOT}/scripts/prepare-declarative-asset.js`, then [author-web-file](../../classic-site-skills/author-web-file/SKILL.md), with verified public-URL bindings. `style-site` does not create or replace image components. Resolve actual page/section/site scope, crop/focal point and readability; final rendering remains pending live verification.

## Check effective contrast before approval

Inspect the winning foreground of each relevant child and its effective surface, not just the parent color or a screenshot. Apply the shared thresholds: normal text needs **4.5:1**; large text needs **3:1** (at least 24 CSS px regular, or 14pt, approximately 18.667 CSS px at weight 700+). The bold cutoff is exactly `14 * 96 / 72` CSS pixels. Eighteen-pixel bold is not large text. Ratios must meet the threshold **without rounding**. Do not enlarge text merely to pass.

Palette/typography proposals return `contrastReview: "required-before-approval"`, not a generated browser audit. Review the rules and dependencies before presenting the diff. For concrete foreground/background pairs, use the deterministic calculator:

```bash
node "${PLUGIN_ROOT}/skills/style-site/scripts/check-style-contrast.js" --foreground "#ffffff" --background "#111827" --fontSize 16 --fontWeight 400
```

Supply hex or resolved sRGB colors, an effective **opaque** background, font size in CSS pixels, and resolved weight. Foreground alpha is composited; no white canvas, token value or inherited color is assumed. The command writes no files, starts no browser, needs no site/server/dependencies, and exits nonzero for a failing pair or unresolved input.

The result's `evidence: "supplied-color-pair-only"` is **not a cascade check**. A passing white-on-navy pair cannot prove that a heading actually becomes white. Check child/inline overrides, existing tokens, state rules and the local patch. Never count a not-yet-performed Studio text-color change as part of the local result; author that declaration locally when safely representable, otherwise report the dependency as blocked.

Gradients are one use of [general CSS](proposal-and-verification.md#general-css-authoring), not a special-case grammar. `background-image`, including removal with `none`, triggers readability review. Inspect text across the full surface and alpha/fallback layers; checking only endpoint colors is not proof of contrast. The bundled parser's acceptance does not prove rendering; unknown or semantic-grammar-unverified values need explicit review. Fix invalid values or verify newer browser support before approving, not a blanket Power Pages rejection or a guessed solid-color pass.

Resolve known failures and local declaration dependencies before approval; there is no native-color Studio prerequisite. Gradients/images, group opacity, overlays, text effects, dynamic/native controls, unresolved tokens and fonts remain **pending real-surface verification**, not presumed passes. Keep unlisted/unknown/conditional Design-panel warnings in review, approval and the final report, without promising local values populate native controls. No HTML generation or browser review is required. Do not start a dev server or require a live preview. Later separately authorized checks should cover desktop/mobile wrapping, clipping, focus, keyboard behavior and affected states; source inspection and color math alone are not a complete WCAG audit or runtime/Studio proof.

## Sources and classic boundaries

- [WCAG 2.2 contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html): paired colors, thresholds, exact comparison and font size.
- [WCAG non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html): necessary control boundaries and states; not measured by this text-only helper.
- [Power Pages styling workspace](https://learn.microsoft.com/en-us/power-pages/getting-started/style-site): Studio-managed themes and typography.
- [Custom CSS](https://learn.microsoft.com/en-us/power-pages/configure/manage-css): custom styles within the platform's cascade.
- [Local placement policy](styling-policy.md) and [Bootstrap/Studio rules](bootstrap-and-studio.md) govern application; creative direction never overrides them.
