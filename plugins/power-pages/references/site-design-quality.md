# Site design quality

Read and apply this shared visual-quality guidance when establishing a new site's identity or changing an existing visual treatment. It describes the outcome, not a framework, asset-import procedure, or preview workflow. Use the calling skill's platform adapter for authoring, approvals, asset delivery, and verification.

## Direction and safe brand reuse

- Start with the audience, visitor journey, primary action, and approved aesthetic/mood. Carry one coherent direction through typography, palette, imagery, shapes, spacing, and interaction states; avoid unrelated effects chosen merely to look elaborate.
- An explicit new-site design brief authorizes establishing a complete cohesive visual identity within the approved scope. Existing-site narrow changes remain preservation-first: reuse approved brand assets, typography, tokens, and successful patterns unless a redesign is requested. A new identity does not authorize changes to unrelated content or functionality.
- Adapt inspiration rather than copying a brand, proprietary artwork, or another site's distinctive content. Do not invent official logos, endorsements, testimonials, or business claims. Reuse brand material only with appropriate ownership, licensing, privacy, and user approval.
- Prefer distinctive, purposeful composition over a generic repeated-card template. "Modern" need not mean a dark hero, gradient, pill buttons, or oversized whitespace. A restrained solid surface is valid; atmosphere and decoration must support the content rather than substitute for it.

Use these directions as starting points, not required palettes or font purchases:

| Aesthetic | Mood | Typography direction | Palette direction | Motion direction |
|---|---|---|---|---|
| Minimal & Clean | Professional | Clear humanist sans, restrained mono accents | Neutrals with one decisive accent | Subtle or none |
| Minimal & Clean | Creative | Geometric display paired with readable serif | Muted tones with a focused accent | Gentle reveals |
| Bold & Vibrant | Professional | Confident display, quiet body face | Strong primary with contrasting accent | Brief, deliberate transitions |
| Bold & Vibrant | Creative | Expressive display with a simpler text face | Saturated complementary pair | Selective staggered reveals |
| Dark & Moody | Technical | Legible mono accents with a clear sans | Dark base with measured bright accents | Minimal fades |
| Dark & Moody | Elegant | Editorial serif with a readable sans | Charcoal with gold or copper accents | Slow, restrained transitions |
| Warm & Organic | Professional | Humanist sans or readable editorial serif | Earth tones with a warm accent | Gentle easing |
| Warm & Organic | Creative | Characterful serif with quiet body typography | Terracotta, sage, and cream | Soft, limited movement |

## Typography and hierarchy

- Choose a small, coordinated type system for display, body, and optional technical text. Contrast size, weight, or family to make the primary heading and action unmistakable, without making every heading compete. Keep body text and secondary information genuinely readable; do not use ultra-light weights to create hierarchy.
- Reuse approved fonts where suitable. Review licensing, privacy, loading cost, language/glyph coverage, and fallbacks before adding fonts through the platform's supported route. A design does not require a new download or a particular font vendor.
- Use comfortable body sizing and line-height; around 45–75 characters per prose line is a useful starting point, not a limit for every component. Adjust measure and heading scale on narrow screens. Let translated labels and enlarged text wrap without clipping.
- Keep semantic heading structure and meaningful reading order independent of visual size. Preserve native labels and text semantics; styling must not turn non-interactive text into an apparent control.

## Palette roles and exact contrast

Define coordinated roles for page background, surfaces, headings, body/muted text, links, button foreground/background, borders, and focus indicators. Pair each foreground with its actual surface and states. Muted text still needs readable contrast; never convey meaning through color alone.

Use the [WCAG 2.2 AA text contrast thresholds](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html):

| Text category | Minimum size | Minimum contrast |
|---|---|---|
| Normal text, including 18px bold | Below the large-text cutoffs | 4.5:1 |
| Large regular text | 24 CSS px (18pt) | 3:1 |
| Large bold text, weight 700+ | 14pt (approximately 18.667 CSS px) | 3:1 |

The bold cutoff is exactly `14 * 96 / 72` CSS pixels, not 18px. Compare ratios **without rounding**: 4.499:1 fails 4.5:1, and 2.999:1 fails 3:1. Do not enlarge text merely to pass. Necessary control boundaries, state indicators, and informative graphical objects need [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) of at least 3:1 against adjacent colors where applicable; this is separate from text contrast.

Inspect effective child foregrounds, inline declarations, inherited values, and every affected state, not just a container's intended color. Resolve alpha against the actual background rather than assuming white. Across imagery, gradients, or overlays, check the full text-bearing surface and responsive crops; endpoint samples or a passing isolated color pair cannot prove readability. Prefer a reliable backing surface or composition change when text would cross unpredictable detail. Unresolved values and unperformed rendering checks remain unknown, not passes.

## Purposeful spacing and responsive composition

- Build a consistent spacing rhythm and aligned content edges. Use proximity to group related content, larger gaps between sections, and a deliberate container width. Keep short sections content-sized rather than inflating every section to viewport height.
- Compose a clear first impression: identity, useful headline, primary action, and a visual that explains the offering. Balance hero text with imagery and vary supporting sections according to their content rather than repeating one layout everywhere.
- Plan desktop and mobile composition together. Stack columns when needed, keep focal content visible, and avoid arbitrary fixed heights or widths that clip text. Preserve logical DOM/keyboard order rather than visually reordering information.
- Account for zoom, long labels, navigation, form errors, and localized content. Aim for usable reflow at 320 CSS pixels and text resizing to 200%; do not hide overflow to disguise a broken layout. Respect genuinely two-dimensional content such as data tables.

## Meaningful imagery and art direction

- For a new-site visual treatment, include purposeful real photographs or illustrations that communicate the offering, people, place, product, or process. Plan a relevant hero image/illustration and supporting imagery where it explains content. Logos, icons, decorative patterns, and gradient blobs alone do not satisfy content imagery.
- Honor an explicit request for a bare baseline or a user decision to decline images. Do not force existing-site narrow edits to acquire photographs. Otherwise, unavailable source material is a dependency to resolve, not permission to silently omit meaningful imagery.
- Reuse suitable approved assets first. If no suitable approved photo is available, an original safe SVG illustration that explains the subject is a legitimate alternative; arbitrary decoration is not. Do not copy an illustration or manufacture misleading photographic evidence.
- Honor the platform workflow's delivery policy. Site creation uses approved direct HTTPS image URLs rather than new image Web Files; an illustration must already have an approved hosted URL on that route. Do not publish a new asset, invent its URL, or fall back to file import implicitly.
- Choose the subject and visual role before the source. Coordinate lighting, color temperature, style, and visual density across hero and supporting images. Specify aspect ratio, crop, focal point, and desktop/mobile treatment; avoid cutting off key people, products, or diagram labels.
- Reserve quiet space for text or place it beside the image. When text overlaps imagery, design the backing/overlay and all text/action states for readability over the actual crop, not an assumed average color. A crop change must not expose text to a newly unreadable area.
- Use actual approved assets with verified provenance, not placeholder data, placeholder-image services, guessed photo IDs, or unresolved image slots. Follow the existing asset workflow for source selection, legal/privacy review, user approval, safe preparation, and delivery; this reference does not replace or relax those checks.
- Provide concise, localized alternative text for informative images and empty alternative text for purely decorative images. Keep essential text accessible and localizable rather than baking it into artwork. Preserve aspect ratio and reserve layout space; use appropriately sized files instead of unnecessarily large downloads.

## Interactive states, accessibility, and motion

- Design default, hover, focus, active, selected, visited, disabled, loading, and error states where applicable. Keep controls recognizable and preserve native behavior, accessible names, form labels, validation announcements, and descriptive link text. Identify links that open new windows.
- Keep all functionality keyboard-operable, with visible focus that is not obscured. Never remove a focus outline without an accessible replacement; do not use positive `tabindex` or rely on hover alone. Size or space pointer targets to meet [WCAG 2.2 target-size requirements](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), not just visual proportions.
- Use motion selectively to explain state or guide attention. Prefer a coherent, brief transition over continuous or scattered effects. Provide `prefers-reduced-motion` alternatives that disable or simplify nonessential movement, preserve visibility/function without animation, and simplify necessary loading feedback.

## Verification boundary

Inspect content, source, responsive rules, asset choices, resolved color pairs, and affected states using the calling skill's available evidence. Report which checks actually ran. Source inspection and color math are not a complete accessibility audit or proof of runtime rendering, font loading, image crop, or editor round trips. The platform adapter governs whether live verification is available or remains pending; this shared reference adds no dev-server, browser, or live-preview prerequisite.
