---
name: design-power-pages-website
description: This skill should be used when the user asks to "redesign the site", "improve the design", "make it look better", "restyle the website", "update the visual design", "customize the look and feel", "design my website", "make it more polished", "improve the UI", "apply a new theme", or wants to transform the visual appearance of a Power Pages code site with distinctive, high-quality frontend design.
user-invocable: true
allowed-tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "AskUserQuestion", "Task", "EnterPlanMode", "ExitPlanMode", "mcp__plugin_power-pages_playwright__browser_navigate", "mcp__plugin_power-pages_playwright__browser_snapshot", "mcp__plugin_power-pages_playwright__browser_click", "mcp__plugin_power-pages_playwright__browser_close"]
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/skills/design-website/scripts/validate-design.js\""
          timeout: 15
        - type: prompt
          prompt: "If a Power Pages website design session was active (via /power-pages:design-website), verify before allowing stop: 1) The design changes were applied to real files (CSS, components, layouts) — not just discussed, 2) The user was given the dev server URL and asked to review the redesigned site, 3) Each major design change was verified via browser_snapshot, 4) Git commits were made after significant design milestones, 5) No build errors remain unresolved. If any of these are incomplete, return { \"ok\": false, \"reason\": \"<specific issues>\" }. If no design session happened or everything is complete, return { \"ok\": true }."
          timeout: 30
---

# Design Power Pages Website

Transform the visual appearance of a Power Pages code site with distinctive, polished frontend design that avoids generic AI aesthetics. Works on both freshly scaffolded and established sites.

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

### Backgrounds
Create atmosphere and depth rather than defaulting to solid colors. Layer CSS gradients, use geometric patterns, or add contextual effects that match the overall aesthetic.

---

## Workflow

> **CRITICAL: Steps MUST be executed in strict sequential order.** The dev server MUST be running and verified via Playwright BEFORE any design changes begin (Step 5). After each significant change in Step 5, verify via `browser_snapshot`. Do NOT batch all changes together — the live feedback loop ensures quality.
>
> **Do NOT take screenshots.** Use `browser_snapshot` (accessibility snapshot) to verify pages yourself, and give the user the dev server URL so they can preview in their own browser.

1. **Verify Site Exists** → Confirm this is a Power Pages code site
2. **Analyze Current Design** → Understand the existing styling, framework, and structure
3. **Gather Design Direction** → Ask about aesthetic preferences, mood, inspiration
4. **Plan** → Enter plan mode, propose specific design changes, get approval
5. **Launch Dev Server** → Start dev server (if not running), verify via Playwright
6. **Apply Design Changes** → Transform typography, colors, motion, backgrounds — verify each change via Playwright
7. **Review & Commit** → Final verification, share URL, commit changes

---

## Step 1: Verify Site Exists

Check for a Power Pages code site in the current working directory (or one level of subdirectories):

1. Look for `powerpages.config.json` — if not found, inform the user and suggest `/power-pages:create-site` first
2. Look for `package.json` — verify the project has been scaffolded
3. Detect the framework — see `${CLAUDE_PLUGIN_ROOT}/references/framework-conventions.md`

> **Note:** This skill works on any Power Pages code site — including freshly scaffolded sites that haven't been deployed yet. A deployed `.powerpages-site/` folder is NOT required.

Store the project root path as `PROJECT_ROOT` and the detected framework for subsequent steps.

---

## Step 2: Analyze Current Design

Read and understand the existing design system before proposing changes:

1. **Global styles** — Find and read the main CSS/SCSS file (e.g., `src/index.css`, `src/styles/global.css`, `src/styles.css`)
2. **CSS variables** — Identify any existing CSS custom properties (colors, fonts, spacing)
3. **Layout components** — Read the main layout/shell component (Header, Footer, Sidebar)
4. **Theme colors** — Extract current color palette from `powerpages.config.json` placeholders or CSS
5. **Font imports** — Check for existing Google Fonts or other font imports
6. **Key pages** — Read 2-3 primary page components to understand the current component styling approach

Summarize the current state to the user: what framework, what fonts, what color scheme, what layout patterns are in use.

---

## Step 3: Gather Design Direction

Use `AskUserQuestion` to collect design preferences (batch into 1-2 calls):

**Call 1:**

| Question | Header | Options |
|----------|--------|---------|
| What aesthetic direction do you want? | Aesthetic | Minimal & Clean, Bold & Vibrant, Dark & Moody, Warm & Organic |
| What's the overall mood? | Mood | Professional & Trustworthy, Creative & Playful, Technical & Precise, Elegant & Premium |

**Call 2:**

| Question | Header | Options |
|----------|--------|---------|
| What aspects should change? (multi-select) | Scope | Typography & Fonts, Color Palette, Animations & Motion, Backgrounds & Textures, Layout & Spacing, All of the above (Recommended) |
| Any design inspiration? (e.g., "like Stripe's website", "Dracula theme", "Solarpunk aesthetic") | Inspiration | I have a specific reference, Surprise me — pick something distinctive, Keep the current direction but elevate it |

**Map aesthetic + mood to concrete design choices:**

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

If the user provides a specific inspiration reference, adapt the design choices to match that reference while maintaining the Power Pages site's existing functionality.

---

## Step 4: Plan

1. Enter plan mode with `EnterPlanMode`
2. Create a design implementation plan covering:
   - **Typography changes** — Specific fonts to use, where they load from (Google Fonts CDN link), weight/size scale
   - **Color palette** — Full palette with CSS variable names and hex values (primary, secondary, accent, background, surface, text, muted)
   - **Motion/animation plan** — What animations to add and where (page load, hover states, transitions)
   - **Background treatment** — Gradients, patterns, or effects to apply
   - **Component updates** — Which components get styling changes and what changes specifically
   - **Files to modify** — Exact list of files that will be changed
3. Present plan to user
4. Use `ExitPlanMode` only after user approves

---

## Step 5: Launch Dev Server

### If dev server is already running
Verify by navigating to the expected URL (typically `http://localhost:5173` for Vite, `http://localhost:4200` for Angular, `http://localhost:4321` for Astro) using `browser_navigate` + `browser_snapshot`. If the site loads, proceed to Step 6.

### If dev server is NOT running

```powershell
cd "<PROJECT_ROOT>"
npm install   # Only if node_modules is missing
npm run dev
```

Run `npm run dev` in the background using `Bash` with `run_in_background: true`.

After the dev server starts:
1. Use `browser_navigate` to open the dev server URL
2. Use `browser_snapshot` to verify the page loads
3. **Share the URL with the user**: "Your site is running at `<URL>` — open it in your browser to follow along as I redesign."

> **GATE: Do NOT proceed to Step 6 until the dev server is running and verified via Playwright.**

---

## Step 6: Apply Design Changes

> **Prerequisite:** The dev server MUST already be running and verified. After each significant change, use `browser_snapshot` to verify — do NOT take screenshots.

Apply changes in this order. After each subsection, verify via `browser_snapshot` and fix any issues before proceeding.

### 6.1 Typography

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

### 6.2 Color Palette

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

### 6.3 Backgrounds & Atmosphere

Add depth and atmosphere to key sections. Choose techniques matching the aesthetic:

- **Gradient backgrounds**: Layer multiple CSS gradients for depth
- **Geometric patterns**: SVG patterns via `background-image` or pseudo-elements
- **Ambient effects**: Subtle radial gradients, mesh gradients, or backdrop blur
- **Dark themes**: Use `background: linear-gradient(...)` with dark-to-darker transitions rather than flat `#000` or `#111`

Apply to the main layout container, hero sections, and card components. Update the global CSS and key layout components.

**Verify via `browser_snapshot`**

### 6.4 Motion & Animation

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

### 6.5 Layout & Spacing Refinement

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
- After typography changes (6.1)
- After color palette changes (6.2)
- After background/atmosphere changes (6.3)
- After motion/animation changes (6.4)
- After layout refinement (6.5)

---

## Step 7: Review & Commit

1. Navigate through each page using Playwright and run `browser_snapshot` to verify all pages look correct
2. Share the dev server URL with the user and list all pages they should review
3. Ask the user to review using `AskUserQuestion`:
   > "The redesign is complete. Preview at `<dev server URL>`. Would you like any adjustments?"
4. If the user requests changes, apply them and re-verify with `browser_snapshot`
5. Close the Playwright browser with `browser_close` when done
6. Ensure all changes are committed:

```powershell
git add -A
git commit -m "Complete website redesign: <aesthetic> theme with <key change summary>"
```

### Suggest Next Steps

After the design session, suggest relevant follow-up skills:
- `/power-pages:deploy-site` — Deploy the redesigned site to Power Pages
- `/power-pages:add-seo` — Add SEO assets to complement the new design
