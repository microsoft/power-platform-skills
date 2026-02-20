# Design Aesthetics Reference

Design principles, typography, color, and motion guidance for Power Pages code sites. Used by the `create-site` skill during Step 6 (Design).

## Frontend Aesthetics Principles

> **CRITICAL: Follow these principles throughout ALL design decisions. Generic "AI slop" aesthetics are the enemy — make creative, distinctive choices that surprise and delight.**

### Typography
Choose fonts that are beautiful, unique, and interesting. Load from Google Fonts.

**Never use:** Inter, Roboto, Open Sans, Lato, Arial, default system fonts

**Recommended choices by mood:**
- Code/Technical aesthetic: JetBrains Mono, Fira Code, Space Grotesk
- Editorial/Content: Playfair Display, Crimson Pro, Fraunces
- Modern/Startup: Clash Display, Satoshi, Cabinet Grotesk
- Technical/Corporate: IBM Plex family, Source Sans 3
- Distinctive/Unique: Bricolage Grotesque, Obviously, Newsreader

**Pairing principle:** High contrast = interesting. Display + monospace, serif + geometric sans, variable font across weights. Use weight extremes — 100/200 vs 800/900, not 400 vs 600. Size jumps of 3x+, not 1.5x.

### Color & Theme
Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes. Draw from IDE themes and cultural aesthetics for inspiration.

**Never use:** Purple gradients on white backgrounds as the primary scheme. Avoid the cliched AI-generated color palette.

### Motion
Use animations for effects and micro-interactions. Prioritize CSS-only solutions. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (`animation-delay`) creates more delight than scattered micro-interactions.

### Accessibility
Accessibility is mandatory (WCAG 2.1 AA). Semantic structure, strong contrast, visible focus states, keyboard navigation, accessible form validation.

- **Semantic HTML**: Use `<header>`, `<nav>`, `<main>`, `<section>`, `<footer>`, `<article>` — never rely on `<div>` soup. Headings (`h1`–`h6`) must follow a logical hierarchy with no skipped levels.
- **Color contrast**: Text must meet WCAG AA minimums — 4.5:1 for normal text, 3:1 for large text (18px+ bold or 24px+ regular). Never convey meaning through color alone.
- **Focus states**: Every interactive element must have a visible focus indicator. Use `outline` (not just `box-shadow`) with sufficient contrast against the background. Never use `outline: none` without a replacement.
- **Keyboard navigation**: All functionality must be operable via keyboard. Tab order must follow a logical reading sequence. Use `tabindex="0"` for custom interactive elements, never positive `tabindex` values.
- **Images & media**: All `<img>` tags must have meaningful `alt` text (or `alt=""` for purely decorative images). Icons used as actions need `aria-label`.
- **Forms**: Every `<input>` must have an associated `<label>`. Use `aria-required`, `aria-invalid`, and `aria-describedby` for validation messages. Error messages must be announced to screen readers.
- **Motion**: Wrap non-essential animations in `@media (prefers-reduced-motion: reduce)` to disable or minimize them. Essential transitions (e.g., loading indicators) may remain but should be simplified.
- **Links**: Link text must be descriptive — never use "click here" or "read more" without context. Links that open new windows must indicate this (e.g., `aria-label` or visible icon with `sr-only` text).

### Backgrounds
Create atmosphere and depth rather than defaulting to solid colors. Layer CSS gradients, use geometric patterns, or add contextual effects that match the overall aesthetic.

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

Apply design changes in this order. After each subsection, verify via `browser_snapshot` and fix any issues before proceeding.

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

4. **Verify via `browser_snapshot`**

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

3. **Verify via `browser_snapshot`**

### Backgrounds & Atmosphere

Add depth and atmosphere to key sections. Choose techniques matching the aesthetic:

- **Gradient backgrounds**: Layer multiple CSS gradients for depth
- **Geometric patterns**: SVG patterns via `background-image` or pseudo-elements
- **Ambient effects**: Subtle radial gradients, mesh gradients, or backdrop blur
- **Dark themes**: Use `background: linear-gradient(...)` with dark-to-darker transitions rather than flat `#000` or `#111`

Apply to the main layout container, hero sections, and card components. Update the global CSS and key layout components.

**Verify via `browser_snapshot`**

### Motion & Animation

Add CSS animations for high-impact moments. Prioritize CSS-only solutions:

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

4. **Apply animation classes** to key components (header, hero, cards, navigation items)

**Verify via `browser_snapshot`**

### Layout & Spacing Refinement

Refine the overall visual rhythm:

- Increase whitespace where the design feels cramped
- Use consistent spacing scale (e.g., 4, 8, 16, 24, 32, 48, 64, 96px)
- Ensure visual hierarchy through size contrast (headings should be dramatically larger than body text)
- Add container max-widths for readability (prose content at 65-75ch)

**Verify via `browser_snapshot`**

### Git Commit Checkpoints

Commit after each major design subsection:

```powershell
git add -A
git commit -m "<short description of design change>"
```

**When to commit:**
- After typography changes
- After color palette changes
- After background/atmosphere changes
- After motion/animation changes
- After layout refinement
