## Phase 5: Implementation

**Goal**: Build all pages, components, and design elements with the design thesis applied from the start, then prove the result with a visual design critique

> **Prerequisite:** The dev server MUST already be running and verified via Playwright (completed in Phase 2). If it is not, go back and complete Phase 2.
>
> **Design references:** Build from `${PLUGIN_ROOT}/references/design-aesthetics.md` (the design system) and `${PLUGIN_ROOT}/references/page-blueprints.md` (page narratives, hero patterns, copy). Read them now if they are not already in context. All pages and components carry the chosen typography, color tokens, imagery, motion, and backgrounds from the start - do NOT build with neutral styling first and redesign later.

**Actions**:

### 5.1 Create Todos for All Work

**Before writing any code**, use a task list to create a todo for every piece of work. This gives the user full visibility into what will be built:

- **One todo per page** — e.g., "Create Contact page (`/contact`)", "Create Dashboard page (`/dashboard`)"
- **One todo per shared component** — e.g., "Create ContactForm component", "Create DataTable component"
- **One todo for routing** — "Update router with all new routes"
- **One todo for navigation** — "Update Layout/Header with navigation links"
- **One todo for design foundations** - "Apply design tokens (theme tokens, fonts, motion, backgrounds)"
- **One todo for the design critique** - "Run design critique pass (desktop and mobile)"

Each todo should have a clear action title, in-progress label and description that includes the file path and what the page/component does. Then work through the todos in order, marking each `in_progress` → `completed`.

### 5.2 Replace the Scaffold & Build

The scaffold is a temporary loading screen — it must be **completely replaced** during this phase. Do NOT build on top of it or try to modify the loading animation into a real page. Start fresh with the user's chosen design.

> **Narrate progress in the loader**: Before each of the steps below, update `<PROJECT_ROOT>/public/scaffold-status.json` so the user — who may still be watching the Home page loader — sees what's actually happening instead of the hardcoded placeholder cycle. Use a short present-participle `message` (e.g., `"Creating Navbar component"`, `"Creating Contact page"`). Include any useful grouping context inline in the message itself. The loader picks up changes within ~1.5 seconds. Updates become no-ops once step 4 replaces the Home page.

1. **Design foundations** - **Completely rewrite** `theme.css` (or `styles.css` for Angular) from scratch with the full token set from design-aesthetics.md section 3, base element styles, the interaction-state styles from section 8, a `prefers-reduced-motion` block, background treatments, and logical CSS properties. The selected font stack must cover `SITE_LOCALE`'s resolved script. Do not use physical left/right layout as the default, even for an initially LTR-only site. Add the chosen Google Fonts to the entry HTML's font `<link>` (`index.html`, or `Layout.astro` for Astro) *alongside* the scaffold's DM Sans + Outfit, which the loader still uses until step 4. The scaffold's loading-screen CSS is discarded entirely. Commit after this step. *Before starting, set the loader status to `{ "message": "Applying design tokens" }`.*
2. **Layout** - **Rewrite** the Layout component (and Header/Footer for Astro) with proper navigation, header, and footer that reflect the chosen design, with a link for every route in the approved plan so the header is final before the first-impression review. The scaffold's passthrough Layout is replaced with a real layout structure. *Set status to `{ "message": "Rewriting Layout" }`.*
3. **Shared components** - Build reusable components (Navbar, Footer, ContactForm, etc.) that pages will use, each with every state in the design-aesthetics.md state table that applies to it. *For each component, set status to `{ "message": "Creating <Component> component" }`.*
4. **Pages** - Create route components for each requested page, **replacing** the scaffold Home page and About placeholder entirely. **Build Home first, and its hero first**, following the hero concept from the brief. As soon as Home is built, run a **first-impression review** of `/` (see "Running a review" in the entry-linked design-critique workflow) and fix the hero until it passes, for at most three rounds - every later page inherits that foundation. Build each page's sections in the order of its planned narrative beats. Each page component must update `document.title` on mount to reflect the current page (e.g., `"Contact — Contoso Portal"`). Use the framework's idiomatic lifecycle hook: `useEffect` (React), `onMounted` (Vue), `ngOnInit` (Angular), or a `<title>` tag in the frontmatter (Astro). Format: `"<Page Name> — <Site Name>"`, with the home page using just `"<Site Name>"`. *For each page, set status to `{ "message": "Creating <Page> page" }` before writing the file. The loader disappears when the Home page itself is replaced - no further status updates are needed after that.*
5. **Router** — Register all new routes (the scaffold only has `/` and `/about` — add all requested routes)
6. **Navigation** - Confirm every Layout/Header link resolves to a registered route, and mark the current item with `aria-current="page"`
7. **Entry HTML** - Remove the scaffold's DM Sans + Outfit from the font `<link>` in `index.html` (or `Layout.astro` for Astro) so only the chosen families load, and set `<meta name="theme-color">` to the `--color-bg` value
8. **Reserve AI summary slots** — only if `AI_SUMMARY_PLACEMENTS` from Phase 3 is non-empty. For each placement, insert a single comment marker in the target page source at the intended insertion point. No visible placeholder UI, no stub components, no extra routes — just a grep-able anchor that `/add-ai-webapi` will later find and replace. Syntax depends on the framework:

   | Framework | Marker syntax |
   |-----------|--------------|
   | React (JSX) | `{/* POWERPAGES:AI-SLOT kind=<pick> */}` inside the component's return JSX |
   | Vue (SFC template) | `<!-- POWERPAGES:AI-SLOT kind=<pick> -->` inside `<template>` |
   | Angular (HTML template) | `<!-- POWERPAGES:AI-SLOT kind=<pick> -->` inside the component template |
   | Astro | `<!-- POWERPAGES:AI-SLOT kind=<pick> -->` inside the component's HTML |

   Where `<pick>` is one of `search-summary`, `data-summarization` — verbatim from the placement record.

   Placement within the page:

   - **`data-summarization`** (record detail): directly after the page heading, above the detail content — this is where a Copilot-style summary card naturally reads in the reading order.
   - **`data-summarization`** (list page): directly above the list / table, below the page heading and any filter bar.
   - **`search-summary`**: directly above the search-results list, below the search input — the summary paragraph reads before the keyword hits.

   One marker per placement, exactly as defined in the `marker` field of the `AI_SUMMARY_PLACEMENTS` record. Do NOT add stub components (`<CopilotSummaryCard />`, etc.), CSS classes, or empty `<aside>` elements — the slot is just a comment. The site must ship as if AI is not a consideration; the follow-up skill does the real work.

**Content-language requirements**:

- Write content natively in `SITE_LANGUAGE`; do not author an English site and
  mechanically translate it afterward.
- Localize every user-visible SPA string: navigation, headings, body copy,
  buttons, links, forms, validation, loading/error/empty states, document
  titles, metadata, image alt text, and ARIA labels.
- Keep code identifiers, package names, CSS classes, Dataverse logical names,
  API endpoints, and environment variables technical and untranslated.
- Keep route paths as stable semantic English ASCII identifiers by default
  (for example, `/services`), while navigation labels and page titles use
  `SITE_LANGUAGE`. Do not translate paths during single-language site creation;
  stable routes avoid breaking bookmarks, analytics, integrations, tests, and
  a later `/add-localization` setup. Use localized paths only when the maker
  explicitly requests them for a permanently single-language SEO strategy.
- For every locale, use logical CSS properties and preserve meaningful DOM
  reading/focus order. Do not reverse arrays or use `row-reverse` to simulate
  RTL. Initial RTL sites must also be visually verified in RTL.
- Treat each form field as one compound direction surface: localized labels,
  placeholders, hints, helper text, validation messages, prefixes, suffixes,
  icons, and open menus follow the active UI direction and use logical
  alignment. Native free-form inputs and textareas use adaptive `dir`: the
  active UI direction while empty, `auto` while populated, and the active UI
  direction again after clearing. Preserve or add `dirname` where submitted
  direction metadata is appropriate. Keep only
  classified machine-oriented values such as email addresses, telephone
  numbers, URLs, code, paths, GUIDs, and identifiers LTR; add the adjacent
  `/* bidi-fixed: <specific reason>; verify=ltr,rtl */` or equivalent HTML
  directive required by the shared standard. Their surrounding field UI
  remains direction-aware.
- Wrap independently inserted unknown-direction content (names, comments,
  titles, search queries) with `<bdi>` or `dir="auto"`. Keep URLs, email,
  code, file paths, GUIDs, and other machine values explicitly isolated,
  normally LTR. Free-form native controls must not use permanent `dir="auto"`;
  bind their native direction to value emptiness and the active UI direction.
- Format dates, numbers, currency, percentages, and relative time with `Intl`
  APIs rather than concatenating locale-sensitive punctuation or symbols.
- Classify directional icons and assets as unchanged, mirrored, or replaced.
  Mirror only controls whose semantics follow reading progression.
- A required physical declaration may remain only with an adjacent
  `/* bidi-physical: <specific reason>; verify=ltr,rtl */` directive and
  successful browser verification in both directions.

**Important**: Build real, functional UI with the design thesis applied - not placeholder "coming soon" pages, and not generic unstyled markup. Every page and component reflects the thesis from the moment it's created. The scaffold loading screen should be completely gone after this phase - no trace of the Power Pages branded animation should remain.

### 5.3 Source Purposeful Visuals

Follow the visuals order in design-aesthetics.md section 6: the site's own UI composed as a product moment first, bespoke inline SVG second, photography third. Do NOT use placeholder services (e.g., `placeholder.com`, `placehold.co`), broken `<img>` tags, or empty image slots.

**Finding photography:**

1. Use web search to search Unsplash for the specific subject the section needs (e.g., `site:unsplash.com city clerk helping resident at counter`) - specific to the audience and the job, never a generic "business meeting".
2. Pick specific photos and use their direct URL with sizing parameters: `https://images.unsplash.com/photo-{id}?w={width}&h={height}&fit=crop` (`w=800` for cards, `w=1600` for heroes and full-bleed bands).
3. Choose photos that share one art direction - similar lighting and color temperature - and apply the same crop ratios and palette-tinted treatment to all of them.
4. Give every `<img>` descriptive `alt` text (or `alt=""` when decorative), explicit `width` and `height`, and `loading="lazy"` below the fold.

### 5.4 Git Commit Checkpoints

Commit after **every individual page and component** so breaking changes can be reverted. Each page and each component gets its own commit — do NOT batch multiple pages or components into a single commit.

```bash
git add -A
git commit -m "<short description of what was added/changed>"
```

Write each component's related files together.
When creating several components together, keep their Git checkpoints separate; never combine pages or components into one commit.

**When to commit:**

- After applying design foundations (tokens, fonts, motion)
- After creating each page (e.g., "Add Home page", "Add Contact page")
- After the first-impression review fixes on the Home page
- After creating each shared component (e.g., "Add Navbar component", "Add Footer component")
- After updating routing and navigation
- After each round of design critique fixes
- Before attempting anything risky or experimental

**If something breaks**, revert to the last good commit:

```bash
git revert HEAD
```
