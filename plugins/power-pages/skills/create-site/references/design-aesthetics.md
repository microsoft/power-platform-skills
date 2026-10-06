# Design Aesthetics Reference

The design system for Power Pages code sites built by `create-site`.
Phase 3 uses it to write the experience brief and pick tokens, Phase 4 to fill the plan, and Phase 5 to build.
Two sibling references complete it:

- [`page-blueprints.md`](page-blueprints.md) - what goes on each page and in what order: first screen, hero patterns, narrative blueprints, section rhythm, copy.
- [`design-critique.md`](design-critique.md) - how the finished site is judged in Phases 5.2 and 5.7: the capture, the two-pass critique, and the rubric.

## The bar

The site must earn a "wow" in the first five seconds and keep earning it on every scroll.
Wow here means intentional, effortless, trustworthy, and specific to this organization - not decoration.
Every page answers four questions within its first screen:

1. What is this?
2. Is it for me?
3. Why should I trust it?
4. What should I do next?

Design for this path of attention: **focal point → value proposition → supporting evidence → primary action**.

These leading words carry the same meaning in all three design references:

| Word | Meaning |
|------|---------|
| **first impression** | The first screen of a page at load, before any scroll. It sets a halo for everything after it, so it gets the most craft. |
| **focal point** | The single element a viewport is built around. Exactly one per viewport. |
| **design thesis** | One or two sentences naming the mood, visual metaphor, type, color roles, geometry, imagery, and motion. Every later choice must trace back to it. |
| **signature moment** | The one memorable peak of the site: an interactive proof, a product reveal, a live preview. One per site, placed where it proves the value. |
| **point of doubt** | The place where a visitor hesitates (commitment, data entry, price, sign-in). Proof belongs here. |
| **template look** | Output that could belong to any site. The opposite of what this reference is for. |

## 1. Experience brief

Write the brief in Phase 3, before any token or layout choice.
Each field is one or two sentences, specific to this site.

| Field | What to decide |
|-------|----------------|
| Audience and job | Who arrives, and the job they came to do. |
| Primary action | The one action the site exists to drive, with one consistent label (e.g., "Submit a request"). |
| Secondary action | The fallback for visitors who are not ready (e.g., "Browse the knowledge base"). |
| Principal doubt | The main reason a visitor would not act. |
| Proof strategy | Which honest evidence answers that doubt, and where it sits. See [Honest proof](page-blueprints.md#honest-proof). |
| Design thesis | See the table above. Derive it from the aesthetic, mood, brand source, and audience. |
| Hero concept | The Home first screen: headline idea, focal point, visual, and CTA placement. Pick a pattern from [`page-blueprints.md`](page-blueprints.md#hero-patterns). |
| Signature moment | What it is, which page holds it, and what it proves. |

Example for a city permits portal:

> **Design thesis:** Civic-modern and calm - warm paper surfaces, confident deep-teal actions, Schibsted Grotesk headlines with tight tracking, soft 8px corners, and a live permit tracker as the hero visual. It should feel like the city finally answers back.
> **Signature moment:** On Home, a permit-status timeline animates step by step as the visitor scrolls, showing exactly what happens after they apply.

## 2. Brand source

The brand source decides where tokens come from.
Aesthetic and mood still drive composition, imagery, and motion in every case.

| Brand source | Tokens come from |
|--------------|------------------|
| Fresh identity | The [aesthetic x mood map](#11-aesthetic-x-mood-map). |
| Existing website | The extracted brand (below). It is the source of truth for color, type, and geometry. |
| Brand colors or logo supplied | The supplied colors become `--color-primary` and `--color-accent`; derive the neutrals and semantic colors around them. With only a logo, view the image, propose primary and accent from its dominant colors, and name them in the plan's brand source so plan approval confirms them. |
| Template customization | The template's existing theme tokens, unless the user asks for a redesign. |

**Extracting an existing website's brand.**
Navigate the Playwright browser to the URL, take one viewport screenshot to read the visual identity, then run this read-only `browser_evaluate` function:

```js
() => {
  const pick = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const s = getComputedStyle(el);
    return { font: s.fontFamily, weight: s.fontWeight, color: s.color, background: s.backgroundColor, radius: s.borderRadius };
  };
  // Cross-origin stylesheets throw on cssRules access, so skip them rather than fail.
  const rootVars = [...document.styleSheets]
    .flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } })
    .filter((rule) => rule.selectorText === ':root')
    .flatMap((rule) => [...rule.style].filter((p) => p.startsWith('--')).map((p) => `${p}: ${rule.style.getPropertyValue(p).trim()}`))
    .slice(0, 60);
  return {
    themeColor: document.querySelector('meta[name="theme-color"]')?.content ?? null,
    body: pick('body'), h1: pick('h1'), h2: pick('h2'), link: pick('a'),
    button: pick('button, .btn, a[class*="btn"], [class*="button"]'),
    header: pick('header, [role="banner"]'),
    rootVars,
  };
}
```

Convert `rgb()` values to hex and map them onto the token roles in section 3.
Navigate the Playwright browser back to the dev server URL when the extraction is done.
Use a brand font when it is on Google Fonts; otherwise pick the closest Google Fonts match by classification (geometric, humanist, grotesque, or serif) and x-height, and say so in the plan.
Use a logo only when the user supplies the file; copy it into `public/` and reference it from there.
With no logo file, set the site name as a wordmark in the display face.

## 3. Design tokens

Write every token into `theme.css` (`styles.css` for Angular) as CSS custom properties.
Components consume tokens only: raw hex values, font names, and pixel shadows live in the theme file and nowhere else.

```css
:root {
  /* Color roles - neutrals carry most of the page; the accent is reserved for priority actions */
  --color-bg: #f8f5ef;              /* page background, tinted toward the brand hue */
  --color-surface: #ffffff;         /* cards, panels */
  --color-surface-strong: #ece6da;  /* alternate section bands */
  --color-text: #15181c;            /* never pure #000 */
  --color-text-muted: #545b63;
  --color-border: #ddd5c7;          /* decorative dividers */
  --color-border-strong: #857b6b;   /* input and control boundaries - 3:1 against bg */
  --color-primary: #0f5257;         /* primary actions and key highlights only */
  --color-on-primary: #ffffff;      /* text and icons on primary */
  --color-accent: #e07a3f;          /* sparing second voice: illustration and data marks */
  --color-accent-text: #a8501f;     /* accent when it carries text - 4.5:1 against bg */
  --color-focus: #0f5257;
  --color-success: #2a7046;
  --color-warning: #8f5400;
  --color-danger: #b42318;

  /* Type */
  --font-display: 'Schibsted Grotesk', system-ui, sans-serif;
  --font-body: 'Public Sans', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --text-sm: 0.875rem;
  --text-base: 1.0625rem;
  --text-lg: clamp(1.125rem, 0.9rem + 0.6vw, 1.375rem);
  --text-h3: clamp(1.375rem, 1.1rem + 0.9vw, 1.75rem);
  --text-h2: clamp(2rem, 1.4rem + 2.2vw, 3.25rem);
  --text-hero: clamp(2.75rem, 1.6rem + 5vw, 6rem);

  /* Space - 4px base; sections breathe more than components */
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
  --space-6: 1.5rem; --space-8: 2rem; --space-12: 3rem; --space-16: 4rem;
  --section-space: clamp(4rem, 3rem + 6vw, 9rem);

  /* Shape and elevation - pick one corner language; shadows are tinted, not grey */
  --radius-sm: 6px; --radius-md: 10px; --radius-lg: 18px; --radius-pill: 999px;
  --shadow-sm: 0 1px 2px rgb(21 24 28 / 0.06), 0 1px 1px rgb(21 24 28 / 0.04);
  --shadow-md: 0 8px 24px -8px rgb(15 82 87 / 0.18);
  --shadow-lg: 0 24px 60px -20px rgb(15 82 87 / 0.28);

  /* Layout */
  --container: 1200px;
  --container-wide: 1440px;
  --measure: 68ch;
  --gutter: clamp(1rem, 0.5rem + 3vw, 2.5rem);

  /* Motion */
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --duration-fast: 150ms;
  --duration-base: 250ms;
  --duration-slow: 600ms;
}
```

The values are an example for the permits-portal thesis, and every color pair in it meets AA; choose every value from the brief.
Keep the token names so later skills and the plan can rely on them.
When a decorative color is too light for text, add an `-text` variant the way `--color-accent-text` does rather than using the decorative value on text.
List the color tokens in the plan's `PALETTE_DATA`.

## 4. Typography

Pick a deliberate pair with a clear role split: a display face with character for headlines, and a highly legible body face for reading and UI.
Add a mono face only when the site shows data, codes, or reference numbers.

**Ramp.**
The hero headline is at least 3x the body size.
Contrast weights by role, using only weights the chosen family publishes: display at 600-800 where the family ships them, body at 400, small labels at 500-600.
Instrument Serif, DM Serif Display, Gloock, Young Serif, and Libre Caslon Display ship only 400 - set them at 400, get the contrast from size and tracking, and add `font-synthesis: none` to those headings so the browser never fakes a bold.
Track large display type tight (`-0.02em` to `-0.04em`) and set it at line-height 1.0-1.1.
Set body text at line-height 1.5-1.7 within `--measure`.
Apply `text-wrap: balance` to headings and `text-wrap: pretty` to paragraphs; both degrade safely in older browsers.

**Faces.**
Pick from this list; every family below was verified to resolve on `fonts.googleapis.com/css2`.

| Role | Families |
|------|----------|
| Grotesque display | Schibsted Grotesk, Hanken Grotesk, Familjen Grotesk, Host Grotesk, Funnel Display, Epilogue |
| Expressive display | Bricolage Grotesque, Syne, Unbounded, Sora, Archivo (with the `wdth` axis), Big Shoulders Display |
| Technical | Space Grotesk, Geist, Geist Mono, JetBrains Mono, IBM Plex Mono, Martian Mono, Spline Sans Mono |
| Serif display | Instrument Serif, Fraunces, Newsreader, DM Serif Display, Bodoni Moda, Gloock, Young Serif, Libre Caslon Display, Cormorant Garamond |
| Body sans | Public Sans, Figtree, Onest, Manrope, Albert Sans, Instrument Sans, Source Sans 3, IBM Plex Sans, Red Hat Text, Karla |
| Body serif | Source Serif 4, Literata, Newsreader, Spectral |

The common defaults - Inter, Roboto, Open Sans, Lato, Montserrat, Poppins, Arial, bare system stacks, and the scaffold's DM Sans + Outfit - read as an unstyled template.
Use one only when an existing brand already uses it.

**Loading.**
Load both families in one `<link>` with `preconnect`, in `index.html` (`Layout.astro` for Astro):

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@500..800&family=Public+Sans:wght@400;500;600&display=swap" rel="stylesheet">
```

Use a weight range (`wght@500..800`) only for variable families; a range on a static family such as DM Serif Display fails.
For static families, list only the weights the family publishes (its Google Fonts page shows them): a discrete list silently drops a weight that does not exist, and the browser then synthesizes it.
Google Fonts silently drops a misspelled or non-Google family from a combined request and still returns HTTP 200, so the page falls back to the system font with no error.
The design review's capture lists the families that actually loaded, which catches this (see [design-critique.md](design-critique.md#capture)).

## 5. Color

- Neutrals carry roughly 80-90% of every page.
- `--color-primary` is reserved for primary actions, the current navigation item, and the one or two highlights per viewport that deserve it.
- `--color-accent` is a sparing second voice for illustration, data marks, and tags - not a second CTA color. Text in the accent uses `--color-accent-text`.
- A dominant hue with one sharp accent beats an evenly spread palette.
- Tint neutrals toward the brand hue: a warm `#f8f5ef` instead of `#ffffff`, an ink `#15181c` instead of `#000000`.
- Meet WCAG 2.2 AA contrast: 4.5:1 for body text, 3:1 for large text (24px, or 18.66px bold), and 3:1 for UI component boundaries and focus indicators. Check text over images and gradients at every breakpoint.
- Color is never the only carrier of meaning; pair it with text or an icon.
- A purple-to-blue gradient on white or black is the most common template look. Use one only when the brand already does.

## 6. Visuals and imagery

Every image must explain, orient, demonstrate, or reinforce identity.
Reach for visuals in this order:

1. **The site's own UI.** Compose a product moment from the site's real components: a status card stack, a request tracker, a search preview with real-looking results. Crop and layer it to show one feature at a time. This is usually the strongest hero visual for a portal.
2. **Bespoke SVG.** Diagrams, process lines, patterns, and spot illustrations drawn inline in the palette and corner language.
3. **Photography.** Specific to the audience and the job - people doing the actual task, the actual kind of place. Source it from Unsplash with `https://images.unsplash.com/photo-{id}?w={width}&h={height}&fit=crop`, finding IDs through `WebSearch`.

Give all photography one art direction: the same crop ratios, the same grade (a palette-tinted overlay, duotone, or consistent scrim), and similar lighting.
Draw icons as inline SVG from one style: one stroke weight, one corner style, one size grid.
For performance, set explicit `width` and `height` on every image, `fetchpriority="high"` on the hero image, `loading="lazy"` below the fold, and a `srcset` built from the Unsplash `w=` parameter.
Ship no image placeholders, `placehold.co`-style services, or broken `<img>` tags.

## 7. Backgrounds and atmosphere

Build depth that supports the focal point:

- Layer palette-tinted gradients - a soft radial light behind the hero visual, a darker-to-darker fade on dark themes instead of flat `#000`.
- Add a subtle SVG noise or grain texture at 3-6% opacity for warmth and print-like depth.
- Use geometric patterns or grid lines that echo the design thesis (a blueprint grid for technical, paper texture for organic).
- Change the background between sections to mark narrative hand-offs (`--color-bg` → `--color-surface-strong` → an inverted primary band).

Atmosphere stays behind content: glassmorphism, neon glow, and floating blobs appear only when the thesis calls for them by name.

## 8. Motion and interaction

Motion explains state, hierarchy, spatial relationship, continuity, or progress.
Animate only `transform` and `opacity`, and use the motion tokens.

- **First-screen entrance.** One orchestrated sequence: the headline is visible within 100ms, supporting elements follow in 60-90ms steps, and the whole sequence ends by 700ms.
- **Scroll reveals.** Content is visible by default. JavaScript adds the hidden starting state only after it attaches an `IntersectionObserver`, so content never stays hidden when a script fails. CSS scroll-driven animations (`animation-timeline: view()`) are fine inside `@supports`. First-screen content never waits on a reveal.
- **Signature moment.** The one place that earns richer motion. It must still read correctly with motion off.
- **Route transitions.** Optional: a cross-fade of 250ms or less through the View Transitions API where the framework supports it (React Router's `viewTransition`, Angular's `withViewTransitions()`), feature-detected.
- **Reduced motion.** Inside `@media (prefers-reduced-motion: reduce)`, remove transforms, parallax, and staggers, and keep instant state changes.

Design these states for every interactive component:

| State | Treatment |
|-------|-----------|
| Hover | A color or elevation shift within `--duration-fast`. Lift only things that are clickable. |
| Focus | `:focus-visible` outline in `--color-focus`, 2px or thicker, with an offset, at 3:1 contrast. |
| Pressed | A brief `scale(0.98)` or darker fill. |
| Disabled | Lower contrast plus `cursor: not-allowed`, with the reason nearby when it is not obvious. |
| Loading | A skeleton shaped like the incoming content, or an inline spinner in the control, with `aria-busy`. |
| Empty | A short explanation and the next action - never a blank area. |
| Error | Plain-language cause and fix next to the field or region, announced to assistive tech. |
| Success | Confirmation that names what happened and what comes next. |
| Current | The active nav item is marked visually and with `aria-current="page"`. |

## 9. Responsive behavior

Design at five widths: 390px (compact mobile), 768px (tablet), 1024px (laptop), 1440px (desktop), and 1920px (wide).
For each, decide the container and gutter, column count, type scale (the `clamp()` tokens cover most of it), navigation treatment, image crop (`object-position` or a different crop), CTA placement, and density.

- Reprioritize on mobile rather than stacking the desktop: the primary action and the focal point come first, secondary content moves down or into disclosure.
- The primary CTA stays visible on the mobile first screen without crowding the header.
- Collapse navigation into an accessible toggle (`aria-expanded`, `aria-controls`, focus moved into the open menu, Escape closes it).
- Touch targets are at least 44x44px for primary controls and never under 24x24px (WCAG 2.2 SC 2.5.8).
- Tables keep task completion on mobile through labeled stacked rows or horizontal scroll with a sticky first column.
- At 1920px, cap content width and let atmosphere fill the edges; lines never stretch past `--measure`.

## 10. Accessibility

WCAG 2.2 AA is mandatory and is a design input, not a final audit.

- **Semantics.** Use `<header>`, `<nav>`, `<main>`, `<section>`, `<article>`, and `<footer>`. One `h1` per page; heading levels never skip.
- **Keyboard.** Every function works from the keyboard in reading order. Use native elements over custom ones, and no positive `tabindex`.
- **Focus.** Every interactive element shows the focus treatment from section 8. A sticky header must not cover focused content: set `scroll-padding-top` to the header height (SC 2.4.11).
- **Images and icons.** Meaningful images get descriptive `alt`; decorative ones get `alt=""`. Icon-only controls get an `aria-label`.
- **Forms.** Every input has a visible `<label>`, the right `type` and `autocomplete`, a `--color-border-strong` boundary, and errors tied to it with `aria-describedby` and `aria-invalid`. Input is preserved after a failed submit.
- **Links.** Link text names its destination. Links that open a new window say so.
- **Language.** Set `lang` on `<html>`.
- **Zoom.** At 200% zoom and 320px width, content reflows without clipping, overlap, or two-dimensional scrolling.

## 11. Aesthetic x mood map

Use the cell matching the Phase 3 answers for a fresh identity.
Treat it as a starting point: swap a face for another in the same row of the [faces table](#4-typography) when the brief calls for it.

| Aesthetic | Mood | Display + body | Palette strategy | Geometry and atmosphere | Motion |
|-----------|------|----------------|------------------|-------------------------|--------|
| Minimal & Clean | Professional & Trustworthy | Schibsted Grotesk + Public Sans | Warm white, ink text, one deep confident accent | 6-8px radii, hairline dividers, generous whitespace | Quiet 200ms fades and 8px rises |
| Minimal & Clean | Creative & Playful | Bricolage Grotesque + Figtree | Paper white with one saturated pop color and tinted surfaces | 16-24px radii, oversized numerals, playful crops | Springy hovers, short staggers |
| Minimal & Clean | Technical & Precise | Geist + Geist Mono | Near-white, graphite, a single signal color | 1px grid lines, 4px radii, mono labels | Precise 150ms transitions, no bounce |
| Minimal & Clean | Elegant & Premium | Instrument Serif + Instrument Sans | Ivory, deep ink, a muted bronze accent | Hairlines, wide margins, near-square corners | Slow 600ms fades |
| Bold & Vibrant | Professional & Trustworthy | Archivo (expanded) + Albert Sans | Strong primary color fields with one contrasting accent | Big color blocks, strong 12-column grid, 8px radii | Confident 300ms slide-ins |
| Bold & Vibrant | Creative & Playful | Unbounded + Onest | Saturated complementary pair, color-blocked sections | Pills, sticker-like tags, rotated labels | Energetic staggers, elastic hovers |
| Bold & Vibrant | Technical & Precise | Space Grotesk + JetBrains Mono | High-contrast black and white with one electric accent | Numbered sections, sharp corners, visible grid | Snappy 150ms, a single type-on line |
| Bold & Vibrant | Elegant & Premium | Bodoni Moda + Albert Sans | Jewel tones on cream with gold details | Huge high-contrast serif headlines, framed imagery | Dramatic `clip-path` image reveals |
| Dark & Moody | Professional & Trustworthy | Familjen Grotesk + Source Sans 3 | Deep blue-slate layers with one luminous accent | Elevated layered surfaces, restrained glow | Smooth fades |
| Dark & Moody | Creative & Playful | Syne + Manrope | Ink black with a vivid coral and acid-lime duo | Oversized type, grain texture, asymmetric layouts | Scroll-linked reveals |
| Dark & Moody | Technical & Precise | JetBrains Mono + IBM Plex Sans | IDE-inspired base with one syntax-style accent | Terminal frames, grid, 4px radii | Terminal-style fades, one blinking cursor |
| Dark & Moody | Elegant & Premium | Cormorant Garamond + Albert Sans | Charcoal with gold or copper, warm off-white text | Hairline frames, full-bleed photography | Slow cinematic reveals |
| Warm & Organic | Professional & Trustworthy | Newsreader + IBM Plex Sans | Cream, forest green primary, terracotta accent | 10-12px radii, soft section dividers | Gentle eases |
| Warm & Organic | Creative & Playful | Fraunces + Figtree | Terracotta, sage, and cream | Rounded shapes, hand-drawn SVG accents | Organic springy motion |
| Warm & Organic | Technical & Precise | Epilogue + Spline Sans Mono | Warm paper, deep olive, amber data highlights | Notebook-grid texture, mono data labels | Precise but soft eases |
| Warm & Organic | Elegant & Premium | Libre Caslon Display + Karla | Linen, espresso, muted clay accent | Arched image frames, generous margins | Slow fades |

When the user gives an inspiration reference, adapt the cell toward it while keeping the site's function.

## 12. Template look and its replacement

| Template look | Build this instead |
|---------------|--------------------|
| Unrelated stock photos | The site's own UI, bespoke SVG, or specific photography with one art direction |
| Identical cards in endless rows | Cards only for true peers; a bento grid when importance varies; prose or a list otherwise |
| Every section centered at the same width | Varied rhythm per [`page-blueprints.md`](page-blueprints.md#section-rhythm) |
| Gradient blobs, neon, or glass without a reason | Atmosphere named by the design thesis |
| "Revolutionize your workflow" copy | Concrete, outcome-led copy per [`page-blueprints.md`](page-blueprints.md#copy) |
| Color sprinkled everywhere | Neutrals plus a reserved accent |
| Mixed radii, icon styles, shadows, or CTA labels | One token set and one label per destination |
| Motion added to look premium | Motion that explains state, hierarchy, or progress |
| The desktop layout stacked on a phone | A reprioritized mobile first screen |
