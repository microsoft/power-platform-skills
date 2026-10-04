# Design Aesthetics Reference

Perception, layout, typography, color, imagery, and motion guidance for Power Pages code sites. Used by the `create-site` skill during planning, implementation, and review.

## Frontend Aesthetics Principles

> **Design is perception engineering.** Do not begin with colors, cards, or animation. First decide how the page will create clarity, direct attention, establish trust, and lead to action. Distinctive styling matters, but only when it supports those outcomes.

### The Four-Question Test

A visitor should be able to answer these questions within the first few seconds:

1. **What is this?** State the product, service, or page purpose plainly.
2. **Is it for me?** Name or strongly signal the intended audience and use case.
3. **Can I trust it?** Provide credible evidence and a professionally resolved visual system.
4. **What should I do next?** Make one next action visually and verbally obvious.

Every prominent element should help answer one of these questions. Remove elements that do not improve understanding, trust, navigation, or action.

### Engineer the First Impression

Visitors infer operational quality from visual quality before reading closely. Alignment, typography, spacing, imagery, and consistency create a halo effect: a deliberately crafted interface makes the underlying service feel more capable and trustworthy.

Protect that first impression:

- Use a coherent grid, spacing rhythm, type scale, image treatment, and interaction language.
- Avoid generic imagery, weak contrast, accidental misalignment, crowded sections, and components that look copied from unrelated templates.
- Prefer fewer, stronger design moves over many decorative ones.
- Make every visible choice feel intentional. If an element has no communication or navigation job, remove it.

### Hero Sections Eliminate Confusion

The hero is an orientation system, not a decoration area. For landing and home pages, cover four functions:

| Function | Question answered | Typical element |
|----------|-------------------|-----------------|
| Headline | What do you do? | Specific outcome or value proposition |
| Context | Is it for me? | Audience, scenario, or qualifying sentence |
| Proof | Why should I believe you? | Metric, customer logo, certification, testimonial, or product evidence |
| Action | What should I do next? | One dominant primary CTA |

Use a product screenshot, diagram, or meaningful image only when it helps explain the offer or strengthens the focal point. Do not let hero media compete with the headline and CTA.

### Control the Scan Path

People scan before they read. Create an unmistakable attention order:

1. Page purpose or main headline
2. Supporting context
3. Primary action
4. Proof or decision-supporting information
5. Secondary details

Use size, contrast, color, weight, position, and spacing to produce this order. Do not make every heading, card, badge, and button equally loud. Each viewport or section should have one dominant focal point.

### Design for Cognitive Ease

Whitespace is cognitive infrastructure. It groups related information, separates decisions, and lowers the effort required to understand a page. Users often interpret easy-to-process experiences as more credible and higher quality.

- Use generous section spacing and clear grouping rather than filling every gap.
- Keep navigation labels, menu choices, CTA variants, colors, and font families deliberately limited.
- Prefer progressive disclosure over presenting every option at once.
- Keep prose widths around 65-75 characters and break dense content into meaningful chunks.
- Make location, state, available actions, and next steps obvious without instruction.

Simplicity is not emptiness. It is the removal of decisions and details that do not help the current user move forward.

### Place Proof at the Point of Doubt

Do not collect testimonials, logos, badges, and metrics in an isolated "social proof" section by default. Identify the objection each page section creates, then place the most relevant evidence nearby.

| Decision point | Likely doubt | Useful proof |
|----------------|-------------|--------------|
| Hero | Is this established and relevant? | Recognizable customers, certification, adoption metric |
| Features | Does this actually solve my problem? | Product evidence, workflow example, measurable outcome |
| Pricing or plan choice | Is this worth the cost or commitment? | ROI metric, review, guarantee, comparison |
| Form or sign-up | What happens after I submit? | Response-time promise, privacy reassurance, process steps |
| Final CTA | Will this work for an organization like mine? | Relevant case study, outcome quote, support commitment |

Proof must be accurate, specific, and appropriate for the user's content. Never invent customers, awards, certifications, testimonials, or performance claims. If real proof is unavailable, use transparent process details or product evidence instead.

### Engineer the Journey, Peak, and Ending

A site is a sequence of decisions, not a collection of independent pages. For every page, determine:

- Where the visitor likely came from
- What they need to understand or believe next
- What action naturally advances the journey
- Where that action leads

Create at least one meaningful peak in important journeys: a clear product demonstration, useful calculator, compelling comparison, strong case study, or especially effective visualization. End journeys deliberately with a helpful success state, confirmation, next-step checklist, or onboarding handoff. The final interaction should reduce uncertainty rather than merely say "Success."

### Typography
Typography should signal maturity while disappearing into the reading experience. Choose fonts that are distinctive, readable, and appropriate for the audience. Load from Google Fonts.

**Never use:** Inter, Roboto, Open Sans, Lato, Arial, default system fonts

**Recommended choices by mood:**
- Code/Technical aesthetic: JetBrains Mono, Fira Code, Space Grotesk
- Editorial/Content: Playfair Display, Crimson Pro, Fraunces
- Modern/Startup: Clash Display, Satoshi, Cabinet Grotesk
- Technical/Corporate: IBM Plex family, Source Sans 3
- Distinctive/Unique: Bricolage Grotesque, Obviously, Newsreader

**Pairing principle:** High contrast = interesting. Display + monospace, serif + geometric sans, variable font across weights. Use weight extremes — 100/200 vs 800/900, not 400 vs 600. Size jumps of 3x+, not 1.5x.

Use one family when it can carry the full hierarchy well; use two complementary families when the contrast has a clear purpose. Define a restrained type system for display, section heading, body, label, and supporting text. Favor comfortable line height and readable contrast over novelty.

### Color & Theme
Color should improve readability and direct attention, not decorate every surface. Commit to a cohesive aesthetic and use CSS variables for consistency. Dominant neutrals with one purposeful brand color and a sharp accent often feel more confident than evenly distributed color.

- Reserve the strongest accent for primary actions, active states, and genuinely important information.
- Keep secondary actions visually subordinate.
- Use semantic colors consistently for success, warning, error, and information states.
- Verify contrast in every state, including hover, focus, disabled, and text over imagery.

**Never use:** Purple gradients on white backgrounds as the primary scheme. Avoid the cliched AI-generated color palette.

### Motion
Motion should explain change, preserve context, or acknowledge input. Prioritize CSS-only solutions. Use a small motion vocabulary with consistent duration and easing. One well-orchestrated reveal can create more delight than scattered effects.

Good motion reassures: hover feedback, loading state, validation response, disclosure, or a transition that shows where content came from. Bad motion competes with the task, delays access, or exists only to attract attention.

Give memorable journeys a restrained micro-interaction at the peak or ending, but never make completion dependent on animation.

### Graphics & Imagery

Every graphic must earn its place by explaining, demonstrating, directing attention, establishing context, or creating useful structure.

- Prefer real product UI, diagrams, process visuals, or contextually relevant photography over abstract filler.
- Keep photography cohesive in lighting, crop, color treatment, and subject matter.
- Use decorative graphics sparingly and ensure they do not compete with the focal point.
- Do not invent visual proof. Label conceptual diagrams or mock data when users could mistake them for real results.

### Accessibility
Accessibility is mandatory (WCAG 2.2 AA). Semantic structure, strong contrast, visible focus states, keyboard navigation, accessible form validation.

- **Semantic HTML**: Use `<header>`, `<nav>`, `<main>`, `<section>`, `<footer>`, `<article>` — never rely on `<div>` soup. Headings (`h1`–`h6`) must follow a logical hierarchy with no skipped levels.
- **Color contrast**: Text must meet WCAG AA minimums — 4.5:1 for normal text, 3:1 for large text (18px+ bold or 24px+ regular). Never convey meaning through color alone.
- **Focus states**: Every interactive element must have a visible focus indicator. Use `outline` (not just `box-shadow`) with sufficient contrast against the background. Never use `outline: none` without a replacement.
- **Keyboard navigation**: All functionality must be operable via keyboard. Tab order must follow a logical reading sequence. Use `tabindex="0"` for custom interactive elements, never positive `tabindex` values.
- **Images & media**: All `<img>` tags must have meaningful `alt` text (or `alt=""` for purely decorative images). Icons used as actions need `aria-label`.
- **Forms**: Every `<input>` must have an associated `<label>`. Use `aria-required`, `aria-invalid`, and `aria-describedby` for validation messages. Error messages must be announced to screen readers.
- **Motion**: Wrap non-essential animations in `@media (prefers-reduced-motion: reduce)` to disable or minimize them. Essential transitions (e.g., loading indicators) may remain but should be simplified.
- **Links**: Link text must be descriptive — never use "click here" or "read more" without context. Links that open new windows must indicate this (e.g., `aria-label` or visible icon with `sr-only` text).

### Backgrounds
Create atmosphere and depth when it strengthens section hierarchy or the focal point. Layer CSS gradients, use geometric patterns, or add contextual effects that match the overall aesthetic. Quiet solid backgrounds are preferable when an effect would add noise.

---

## Aesthetic x Mood Mapping

Use this table to map aesthetic + mood preferences to concrete design choices:

| Aesthetic | Mood | Font Direction | Color Direction | Motion Direction |
|-----------|------|---------------|-----------------|------------------|
| Minimal & Clean | Professional | IBM Plex Sans + JetBrains Mono | Neutral with one sharp accent | Subtle fades, minimal |
| Minimal & Clean | Creative | Space Grotesk + Crimson Pro | Muted pastels with pop accent | Smooth reveals |
| Bold & Vibrant | Professional | Cabinet Grotesk + Fira Code | Strong primary + contrasting accent | Confident slide-ins |
| Bold & Vibrant | Creative | Clash Display + Bricolage Grotesque | Saturated complementary pair | Energetic staggers |
| Dark & Moody | Technical | JetBrains Mono + Space Grotesk | Dark base (IDE-inspired) + neon accent | Terminal-style fades |
| Dark & Moody | Elegant | Playfair Display + Source Sans 3 | Deep charcoals + gold/copper accent | Slow, cinematic reveals |
| Warm & Organic | Professional | Newsreader + IBM Plex Sans | Earth tones + warm accent | Gentle eases |
| Warm & Organic | Creative | Fraunces + Satoshi | Terracotta/sage/cream palette | Organic, springy motion |

If the user provides a specific inspiration reference, adapt the design choices to match while maintaining the site's functionality.

---

## Design Application Steps

Apply design decisions in this order. Build the hierarchy and journey before polishing visual details. Use `browser_snapshot` after each subsection for structure and interaction. Use temporary screenshots only at the combined visual checkpoints below, where several choices can be judged together.

### Visual Review Protocol

Accessibility snapshots and visual screenshots serve different purposes:

- Use `browser_snapshot` to inspect semantic structure, reading order, accessible names, content, and available interactions.
- Use `browser_take_screenshot` to inspect hierarchy, spacing, balance, typography, color relationships, imagery, density, and focal-point dominance.

Prefer screenshots returned directly by the tool without specifying `filename`. If the host requires a file, save it to a uniquely named session-temporary location outside the site project, review it, and delete that exact file immediately. Never commit or retain visual-review screenshots.

Capture at these checkpoints:

1. **Design system + hero** — typography, palette, spacing, background, navigation, hero message, proof, and CTA are visible together.
2. **Representative content layout** — the first dashboard, form, table, search, detail, or similarly distinct layout is complete.
3. **Final routes** — one screenshot for each visually distinct page layout before handoff; pages sharing the same composition can use a representative capture.

After each capture, state what the image demonstrates and list concrete visual defects before editing. Re-capture once after fixes to confirm the defects are resolved. Continue to use `browser_snapshot` for follow-up actions because screenshots are not an interaction surface.

### Perception Brief

Before coding, write a compact design brief for each important page:

| Decision | Required answer |
|----------|-----------------|
| Page purpose | What should a visitor understand within five seconds? |
| Audience cue | How will they recognize that the page is for them? |
| Primary doubt | What could prevent trust or action here? |
| Proof | What truthful evidence resolves that doubt, and where should it appear? |
| Focal point | What should receive attention first? |
| Primary action | What is the single preferred next step? |
| Journey | Where did the visitor likely come from, and where should the CTA lead? |
| Peak/end | What moment should be memorable, and how will the journey conclude? |

For a home-page hero, explicitly record the headline, context, proof, and action. If the project has no real proof content yet, plan a product demonstration, transparent process statement, or clearly labeled content slot rather than fabricating claims.

### Structure & Hierarchy

1. Order sections around the visitor's questions and likely objections, not a generic landing-page template.
2. Establish one focal point per section and one dominant CTA per decision stage.
3. Put supporting proof near the claim or decision it validates.
4. Remove redundant cards, duplicate CTAs, decorative badges, and navigation choices.
5. Use semantic landmarks and a logical heading order to make the visual hierarchy match the document structure.

### Typography

1. **Add Google Fonts** — Add `<link>` tags to `index.html` (or the framework's HTML entry point) for the chosen fonts. Include the specific weights needed (e.g., 200, 400, 700, 900).

   ```html
   <link rel="preconnect" href="https://fonts.googleapis.com">
   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
   <link href="https://fonts.googleapis.com/css2?family=<FONT_1>:<WEIGHTS>&family=<FONT_2>:<WEIGHTS>&display=swap" rel="stylesheet">
   ```

2. **Update CSS variables** — Set font families in the global CSS:

   ```css
   :root {
     --font-heading: '<Display Font>', sans-serif;
     --font-body: '<Body Font>', sans-serif;
     --font-mono: '<Mono Font>', monospace;
   }
   ```

3. **Apply to elements** — Update `body`, `h1`-`h6`, `code`, and any component-specific typography. Use extreme weight contrasts and large size jumps.

4. **Verify structure via `browser_snapshot`**. Defer screenshot review until typography, palette, spacing, layout, and the hero can be judged together.

### Color Palette

1. **Define CSS variables** — Replace existing color variables (or add new ones) in the global CSS:

   ```css
   :root {
     --color-primary: <hex>;
     --color-secondary: <hex>;
     --color-accent: <hex>;
     --color-bg: <hex>;
     --color-surface: <hex>;
     --color-text: <hex>;
     --color-text-muted: <hex>;
     --color-border: <hex>;
   }
   ```

2. **Update component references** — Replace any hardcoded colors with the CSS variables. Use `Edit` with `replace_all: true` for bulk replacements.

3. **Verify structure via `browser_snapshot`**. Review the palette visually at the Design system + hero checkpoint.

### Backgrounds & Atmosphere

Add depth and atmosphere only to key sections. Choose techniques matching the aesthetic:

- **Gradient backgrounds**: Layer multiple CSS gradients for depth
- **Geometric patterns**: SVG patterns via `background-image` or pseudo-elements
- **Ambient effects**: Subtle radial gradients, mesh gradients, or backdrop blur
- **Dark themes**: Use `background: linear-gradient(...)` with dark-to-darker transitions rather than flat `#000` or `#111`

Apply selectively to the main layout container, hero, or a peak moment. Do not automatically decorate every card and section.

**Verify structure via `browser_snapshot`** and review the effect as part of the next visual checkpoint.

### Motion & Animation

Add CSS animations for useful state changes and selected high-impact moments. Prioritize CSS-only solutions:

1. **Page load sequence** — Stagger element reveals with `animation-delay`:

   ```css
   @keyframes fadeInUp {
     from { opacity: 0; transform: translateY(20px); }
     to { opacity: 1; transform: translateY(0); }
   }

   .animate-in {
     animation: fadeInUp 0.6s ease-out both;
   }
   .animate-in:nth-child(1) { animation-delay: 0.1s; }
   .animate-in:nth-child(2) { animation-delay: 0.2s; }
   .animate-in:nth-child(3) { animation-delay: 0.3s; }
   ```

2. **Hover states** — Add transitions to interactive elements (buttons, cards, links):

   ```css
   .card {
     transition: transform 0.2s ease, box-shadow 0.2s ease;
   }
   .card:hover {
     transform: translateY(-2px);
     box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
   }
   ```

3. **Page transitions** — If the framework supports it, add route transition animations

4. **Apply animation classes selectively** to the hero sequence, interactive controls, and the journey's peak or completion state. Do not animate every card or navigation item.

**Verify behavior via `browser_snapshot`** and review motion at runtime without creating extra still-image captures solely for animation.

### Layout & Spacing Refinement

Refine the overall visual rhythm:

- Increase whitespace where grouping or decision-making feels cramped
- Use consistent spacing scale (e.g., 4, 8, 16, 24, 32, 48, 64, 96px)
- Ensure visual hierarchy through size, contrast, weight, position, and spacing
- Add container max-widths for readability (prose content at 65-75ch)
- Check that each viewport has one obvious focal point and the primary CTA remains dominant
- Remove anything that creates a competing focal point without supporting the current decision

**Verify via `browser_snapshot`, then complete the Design system + hero screenshot checkpoint.** Review the five-second message, scan path, CTA dominance, proof placement, whitespace, alignment, image crop, and visual cohesion. Fix concrete issues and re-capture once.

### Trust, Action & Ending Review

For each page:

1. Confirm the purpose and intended audience are understandable without reading every paragraph.
2. Confirm the most likely doubt is answered close to the relevant claim or action.
3. Confirm the primary CTA is specific, visually dominant, and leads to the promised next step.
4. Confirm forms explain what happens after submission and provide a strong success state.
5. Confirm loading, empty, error, and success states preserve trust through clear language and polished feedback.
6. Confirm no customer, security, performance, or adoption claim was invented.

**Verify via `browser_snapshot`.** At the Representative content or Final routes checkpoint, use temporary screenshots to confirm the page also passes visually.

---

## Pre-Ship Design Review

### Clarity

- Can a visitor explain the page's purpose within five seconds?
- Does the hero or opening section communicate headline, context, proof, and action?
- Is there one obvious focal point at a time?
- Does the visual hierarchy match the intended scan path?

### Trust

- Does the page feel coherent and intentionally crafted?
- Is proof accurate and placed near the doubt it resolves?
- Are typography, spacing, imagery, color, and interaction states consistent?
- Are system states and form outcomes transparent?

### Cognitive Load

- Have unnecessary choices, CTAs, menu items, colors, and decorative elements been removed?
- Is whitespace doing useful grouping and separation work?
- Is the page easy to scan, with readable line lengths and meaningful sections?
- Can users tell where they are and what is available without instruction?

### Action

- Is the next step obvious and described with a specific verb?
- Is the primary CTA visually dominant over secondary actions?
- Does each page lead naturally to the next stage of the journey?
- Does the destination fulfill the CTA's promise?

### Delight & Memory

- Do micro-interactions acknowledge user actions without distracting them?
- Does motion improve understanding or continuity?
- Is there a meaningful peak in the main journey?
- Does the experience end with a polished confirmation and useful next step?

Premium design is not the maximum amount of design. It is the minimum mental effort required to create clarity, confidence, trust, and momentum.

### Git Commit Checkpoints

Commit after each major design subsection:

```bash
git add -A
git commit -m "<short description of design change>"
```

**When to commit:**
- After typography changes
- After color palette changes
- After background/atmosphere changes
- After motion/animation changes
- After layout refinement
