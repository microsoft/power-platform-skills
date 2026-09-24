# Design Aesthetics Reference

Code-site adapter used by the `create-site` skill during Step 6 (Design), after SPA scaffolding. Read and apply [shared site design quality](../../../references/site-design-quality.md) first for cohesive aesthetic/mood, hierarchy, typography, palette/contrast, spacing, responsive composition, imagery, safe brand reuse, and accessible states/motion. Keep the shared reference as the source of those principles; this adapter owns code-site execution.

The SPA font-loading, global CSS, and browser steps below apply only to code sites. Classic sites use [their own adapter](../../style-site/references/design-quality.md), not this workflow.

## Code-site design defaults

Choose distinctive typography using the shared mood directions. For new code-site font choices, prefer Google Fonts where the chosen family is available; confirm licensing and approved loading for other families. Preserve an already-approved brand font rather than replacing it solely for novelty.

**Avoid as the default new code-site choice:** Inter, Roboto, Open Sans, Lato, Arial, default system fonts. This creative preference is not a prohibition on approved brand fonts or accessible fallback stacks, and does not apply to classic sites.

**Code-site font candidates by mood:**
- Code/Technical aesthetic: JetBrains Mono, Fira Code, Space Grotesk
- Editorial/Content: Playfair Display, Crimson Pro, Fraunces
- Modern/Startup: Clash Display, Satoshi, Cabinet Grotesk
- Technical/Corporate: IBM Plex family, Source Sans 3
- Distinctive/Unique: Bricolage Grotesque, Obviously, Newsreader

Use the shared palette roles and aesthetic/mood mapping rather than a generic purple-gradient-on-white scheme. Match the approved brief and keep readable contrast ahead of stylistic novelty.

Apply the shared exact WCAG contrast rules: **4.5:1** for normal text; **3:1** only for large text at 24 CSS px regular or 14pt (approximately 18.667 CSS px) bold at weight 700+. **18px bold remains normal text at 4.5:1.** Compare ratios without rounding.

Implement shared accessibility requirements with semantic HTML/native controls, associated `<label>` elements, appropriate `aria-required`/`aria-invalid`/`aria-describedby` where needed, and accessible names for icon actions. Do not substitute a styled `<div>` and `tabindex` for a working keyboard-operable control.

## Design Application Steps

Apply design changes in this order. After each subsection, verify via `browser_snapshot` and fix any issues before proceeding.

### Typography

1. **Add Google Fonts** — For approved Google Fonts choices not already loaded, add `<link>` tags to `index.html` (or the framework's HTML entry point). Include only the specific weights needed (e.g., 200, 400, 700, 900). Reuse existing approved loading for brand fonts.

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

3. **Apply to elements** — Update `body`, `h1`-`h6`, `code`, and any component-specific typography using the approved hierarchy. Keep display contrast deliberate and body text legible.

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

Compose the approved hero/supporting images using the shared imagery guidance; decorative effects do not replace meaningful photographs or illustrations. Add depth and atmosphere to key sections where it supports the aesthetic:

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

5. **Apply reduced-motion alternatives** — Keep content visible and controls usable with nonessential motion disabled, following the shared guidance.

**Verify via `browser_snapshot`**

### Layout & Spacing Refinement

Apply the shared spacing and responsive-composition guidance to the SPA's layout containers and components. Refine the spacing scale, prose max-widths, heading hierarchy, image crops, and narrow-screen stacking without changing the logical reading order.

**Verify via `browser_snapshot`**

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
