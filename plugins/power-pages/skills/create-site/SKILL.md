---
name: create-site
description: >-
  Creates a new Power Pages code site (SPA) using React, Angular, Vue, or Astro. Guides through
  the full process from initial concept to deployed site: requirements discovery, scaffolding,
  component planning, design, implementation, validation, and deployment. Use when the user
  wants to create, build, or scaffold a new Power Pages website or portal.
user-invocable: true
argument-hint: Optional site description
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, WebSearch, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_snapshot, mcp__plugin_power-pages_playwright__browser_click
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Create Power Pages Code Site

Guide the user through creating a complete, production-quality Power Pages code site from initial concept to deployed site. Follow a systematic approach: discover requirements, scaffold and launch immediately, plan components and design, implement with design applied, validate, review, and deploy.

## Core Principles

- **Use best judgement for design details**: Once the user picks an aesthetic direction and mood, make confident decisions about specific fonts, colors, page layouts, and component behavior. Do not ask the user to specify every detail — use the design reference and your own taste to make creative, distinctive choices.
- **Use TaskCreate/TaskUpdate**: Track all progress throughout all phases — create the todo list upfront with all phases before starting any work.
- **Scaffold early, design with intention**: Get the dev server running immediately after discovery so the user has something to look at. Then plan the design and features while the scaffold is live — apply the chosen aesthetic during implementation.
- **Live preview feedback loop**: The dev server MUST be running before any customization begins. Browse the site via Playwright (`browser_navigate` + `browser_snapshot`) to verify every significant change. Do NOT take screenshots — only use accessibility snapshots to check page structure and content.
- **Use real images**: Source high-quality photos from Unsplash wherever pages need visual content — hero sections, feature cards, about pages, backgrounds, etc. Use `https://images.unsplash.com/photo-{id}?w={width}&h={height}&fit=crop` URLs with specific photo IDs found via `WebSearch`. Never leave image placeholders or broken `<img>` tags pointing to nonexistent files.
- **Git checkpoints**: Commit after every individual page and component — each gets its own commit so breaking changes can be reverted.

**Constraint**: Only static SPA frameworks are supported (React, Vue, Angular, Astro). NOT supported: Next.js, Nuxt.js, Remix, SvelteKit, Liquid.

**Initial request:** $ARGUMENTS

---

## Phase 1: Discovery

**Goal**: Understand what site needs to be built and what problem it solves

**Actions**:

1. Create todo list with all 8 phases (see [Progress Tracking](#progress-tracking) table)
2. If site purpose is clear from arguments:
   - Summarize understanding
   - Identify site type (portal, dashboard, landing page, blog, etc.)
3. If site purpose is unclear, use `AskUserQuestion`:

   | Question | Header | Options |
   |----------|--------|---------|
   | What should the site be called? (e.g., "Contoso Portal", "HR Dashboard") | Site Name | *(free text — use a single generic option so the user types a custom name via "Other")* |
   | Which frontend framework? | Framework | React (Recommended), Vue, Angular, Astro |
   | What is the site's purpose? | Purpose | Company Portal, Blog/Content, Dashboard, Landing Page |
   | Who is the target audience? | Audience | Internal (employees, partners), External (public-facing customers) |
   | Where should the project be created? | Location | Current directory, New folder in current directory (Recommended), Any other directory |

4. Resolve the project location:
   - **If "Current directory"**: Project root = `<cwd>`.
   - **If "New folder in current directory"**: Create a folder named `__SITE_NAME__` inside the cwd. Project root = `<cwd>/__SITE_NAME__/`.
   - **If "Any other directory"**: Ask for the full path. Verify/create it. Project root = provided path.

   After resolving, confirm: "The site will be created at `<resolved path>`."

   Store this as `PROJECT_ROOT`.

5. From the user's answers, derive:
   - `__SITE_NAME__` (Title Case, e.g., `Contoso Portal`)
   - `__SITE_SLUG__` (kebab-case derived from site name, e.g., `contoso-portal`)
   - `__SITE_DESCRIPTION__` (one-line description based on name + purpose)
6. Summarize understanding and confirm with user before proceeding

**Audience influences site generation:**

- **Internal**: Prioritize data tables, dashboards, authentication, navigation depth, functional over flashy design
- **External**: Prioritize landing page appeal, SEO-friendly structure, contact forms, clean marketing-oriented layout

**Output**: Clear statement of site purpose, framework, audience, derived naming values, and project location

---

## Phase 2: Scaffold & Launch Dev Server

**Goal**: Get a running site immediately so the user has something to preview while features and design are planned

> **The scaffold is a temporary branded loading screen** — it shows a Power Pages animated "Building your site" experience with orbiting elements, status messages, and feature cards. Its only purpose is to get the dev server running quickly so the user has something to look at while you plan and build. **During Phase 5 (Implementation), the entire scaffold — including theme.css, Layout, Home page, and all placeholder components — is completely replaced** with the user's actual site: their chosen typography, color palette, pages, components, and navigation. Do NOT try to build on top of the loading screen; replace it entirely.

> See `${CLAUDE_PLUGIN_ROOT}/references/framework-conventions.md` for the full framework → build tool → router → output path mapping.

**Actions**:

### 2.1 Copy Template

> `${CLAUDE_PLUGIN_ROOT}` is already resolved to the plugin's absolute path at runtime. Use it directly in Glob/Read paths — do NOT search for the plugin directory.

Read and copy all files from the matching asset template to the project directory:

| Framework | Asset Directory |
|-----------|----------------|
| React | `${CLAUDE_PLUGIN_ROOT}/skills/create-site/assets/react/` |
| Vue | `${CLAUDE_PLUGIN_ROOT}/skills/create-site/assets/vue/` |
| Angular | `${CLAUDE_PLUGIN_ROOT}/skills/create-site/assets/angular/` |
| Astro | `${CLAUDE_PLUGIN_ROOT}/skills/create-site/assets/astro/` |

Use `Glob` to discover all files in the asset directory, `Read` each file, then `Write` to the project directory preserving the relative path structure.

### 2.2 Replace Placeholders

After copying, replace all `__PLACEHOLDER__` tokens in every file. Use `Edit` with `replace_all: true` on each file.

- **Name/slug/description placeholders**: Use the actual values from Phase 1 (`__SITE_NAME__`, `__SITE_SLUG__`, `__SITE_DESCRIPTION__`).

> **Note:** The scaffold loading screen uses hardcoded Power Pages branding colors — there are no color placeholders (`__PRIMARY_COLOR__`, etc.) to replace. The user's chosen color palette is applied fresh during Phase 5 when the scaffold is completely replaced.

### 2.3 Rename gitignore

Rename `gitignore` → `.gitignore` in the project root (stored without dot prefix to avoid git interference in the plugin repo).

### 2.4 Install Dependencies

Run `npm install` **before** initializing git so that `package-lock.json` is included in the initial commit:

```powershell
cd "<PROJECT_ROOT>"
npm install
```

### 2.5 Initialize Git Repository

Initialize a git repo and make the first commit. This captures all template files AND `package-lock.json` in one clean baseline:

```powershell
cd "<PROJECT_ROOT>"
git init
git add -A
git commit -m "Initial scaffold: __SITE_NAME__ (__FRAMEWORK__)"
```

From this point, **commit after every significant milestone** so any breaking change can be reverted.

### 2.6 Start Dev Server

**This MUST happen now — before any planning or customization begins.** The dev server gives the user a live preview while features and design are being planned:

```powershell
cd "<PROJECT_ROOT>"
npm run dev
```

Run `npm run dev` in the background using `Bash` with `run_in_background: true`. Note the local URL (typically `http://localhost:5173` for Vite or `http://localhost:4200` for Angular or `http://localhost:4321` for Astro).

### 2.7 Verify in Playwright & Share URL

Immediately after the dev server starts, verify the scaffold is working:

1. Use `mcp__plugin_power-pages_playwright__browser_navigate` to open the dev server URL
2. Use `mcp__plugin_power-pages_playwright__browser_snapshot` to verify the page loaded correctly (do NOT take screenshots — only use accessibility snapshots)
3. **Share the dev server URL with the user** so they can preview the site in their own browser (e.g., "Your site is running at `http://localhost:5173` — open it in your browser to follow along as I build.")

> **GATE: Do NOT proceed to Phase 3 until ALL of the following are true:**
>
> 1. Template files copied and placeholders replaced
> 2. Git repo initialized with initial scaffold commit
> 3. `npm install` completed successfully
> 4. Dev server is running in the background (`npm run dev`)
> 5. Playwright has opened the site and verified it loads via `browser_snapshot`
> 6. The dev server URL has been shared with the user
>
> If any of these are not done, complete them now before moving on.

**Output**: Running dev server with verified scaffold, URL shared with user

---

## Phase 3: Component Planning

**Goal**: Determine what pages, components, and design elements the site needs — while the user previews the running scaffold

**Actions**:

1. Use `AskUserQuestion` to collect feature and design requirements:

   | Question | Header | Options |
   |----------|--------|---------|
   | Which features? (multi-select) | Features | *(generate 3-4 context-aware options based on the site name, purpose, and audience from Phase 1)* |
   | What aesthetic direction do you want? | Aesthetic | Minimal & Clean (Recommended), Bold & Vibrant, Dark & Moody, Warm & Organic |
   | What's the overall mood? | Mood | Professional & Trustworthy (Recommended), Creative & Playful, Technical & Precise, Elegant & Premium |

   > **Feature options are NOT hardcoded.** Infer relevant features from Phase 1 answers. For example:
   > - "HR Dashboard" + Internal → Employee Directory, Leave Requests, Announcements, Org Chart
   > - "Contoso Portal" + External → Contact Form, Service Catalog, Knowledge Base, FAQ
   > - "Partner Hub" + Internal → Document Library, Partner Directory, Deal Tracker, Notifications
   >
   > Always generate options that make sense for the specific site — never reuse a fixed list.

2. Read the design aesthetics reference: `${CLAUDE_PLUGIN_ROOT}/skills/create-site/references/design-aesthetics.md`
3. **Map aesthetic + mood to design choices** using the Aesthetic x Mood Mapping table from the design reference. Record the chosen font direction, color direction, and motion direction.
4. Analyze requirements and determine needed components. Present component plan to user as a table:

   ```
   | Component Type      | Count | Details |
   |---------------------|-------|---------|
   | Pages               | 4     | Home, About, Services, Contact |
   | Shared Components   | 3     | Navbar, Footer, ContactForm |
   | Design Elements     | 4     | Google Fonts (Playfair Display + Source Sans Pro), Color palette (6 CSS vars), Page transitions, Gradient backgrounds |
   | Routes              | 4     | /, /about, /services, /contact |
   ```

5. Use best judgement to determine the final color palette based on the chosen aesthetic + mood. These will be written fresh into a new `theme.css` during Implementation (Phase 5) when the scaffold loading screen is completely replaced:

   | CSS Variable | Description | Value |
   |-------------|-------------|-------|
   | `--color-primary` | Primary hex color | *(choose based on aesthetic + mood)* |
   | `--color-secondary` | Complementary hex color | *(choose based on aesthetic + mood)* |
   | `--color-bg` | Background color | *(choose based on aesthetic + mood)* |
   | `--color-surface` | Surface/card color | *(choose based on aesthetic + mood)* |
   | `--color-text` | Main text color | *(choose based on aesthetic + mood)* |
   | `--color-text-muted` | Muted text color | *(choose based on aesthetic + mood)* |

**Output**: Confirmed list of pages, components, design elements, and routes to create

---

## Phase 4: Plan Approval

**Goal**: Get user approval on the implementation plan

**Actions**:

1. Read the design aesthetics reference: `${CLAUDE_PLUGIN_ROOT}/skills/create-site/references/design-aesthetics.md`
2. Present the implementation plan directly to the user as a formatted message. **The plan MUST have ALL of the following sections:**

   **Section A — Design & Pages**
   - Pages to create (with content outline for each)
   - Components needed for each page
   - Routing and navigation structure
   - Design decisions (from the chosen design direction):
     - Typography: specific Google Fonts chosen
     - Color palette: full CSS variable set with hex values (replacing the scaffold defaults)
     - Motion/animation plan: page load, hover states, transitions
     - Background treatment: gradients, patterns, effects

   **Section B — Review & Deployment**
   - What to verify before handoff
   - Deployment options

   > **CRITICAL:** The plan is written for the user — do NOT reference internal phase numbers, tool names, or implementation details. Describe what will be built and what it will look like. The scaffold is already running — this plan covers what will be built on top of it.

3. Use `AskUserQuestion` to get approval:

   | Question | Header | Options |
   |----------|--------|---------|
   | Does this plan look good? | Plan | Approve and start building (Recommended), I'd like to make changes |

   - **If "Approve"**: Proceed to Phase 5.
   - **If "I'd like to make changes"**: Ask what they want changed, update the plan, and re-present for approval.

**Output**: Approved implementation plan

---

## Phase 5: Implementation

**Goal**: Build all pages, components, and design elements with the chosen aesthetic applied from the start

> **Prerequisite:** The dev server MUST already be running and verified via Playwright (completed in Phase 2). If it is not, go back and complete Phase 2.
>
> **Design reference:** Read `${CLAUDE_PLUGIN_ROOT}/skills/create-site/references/design-aesthetics.md` and apply its principles throughout this phase. All pages and components should be built with the chosen typography, color palette, motion, and backgrounds from the start — do NOT build with neutral styling first and redesign later.

**Actions**:

### 5.1 Create Todos for All Work

**Before writing any code**, use `TaskCreate` to create a todo for every piece of work. This gives the user full visibility into what will be built:

- **One todo per page** — e.g., "Create Contact page (`/contact`)", "Create Dashboard page (`/dashboard`)"
- **One todo per shared component** — e.g., "Create ContactForm component", "Create DataTable component"
- **One todo for routing** — "Update router with all new routes"
- **One todo for navigation** — "Update Layout/Header with navigation links"
- **One todo for design foundations** — "Apply design tokens (fonts, colors, motion, backgrounds)"

Each todo should have a clear `subject`, `activeForm`, and `description` that includes the file path and what the page/component does. Then work through the todos in order, marking each `in_progress` → `completed`.

### 5.2 Replace the Scaffold & Build

The scaffold is a temporary loading screen — it must be **completely replaced** during this phase. Do NOT build on top of it or try to modify the loading animation into a real page. Start fresh with the user's chosen design.

1. **Design foundations** — **Completely rewrite** `theme.css` (or `styles.css` for Angular) from scratch with the chosen color palette as CSS custom properties, Google Fonts, motion/animation utilities, and background treatments. The scaffold's loading screen CSS is discarded entirely. Commit after this step.
2. **Layout** — **Rewrite** the Layout component (and Header/Footer for Astro) with proper navigation, header, and footer that reflect the chosen design. The scaffold's passthrough Layout is replaced with a real layout structure.
3. **Shared components** — Build reusable components (Navbar, Footer, ContactForm, etc.) that pages will use
4. **Pages** — Create route components for each requested page, **replacing** the scaffold Home page and About placeholder entirely. Each page component must update `document.title` on mount to reflect the current page (e.g., `"Contact — Contoso Portal"`). Use the framework's idiomatic lifecycle hook: `useEffect` (React), `onMounted` (Vue), `ngOnInit` (Angular), or a `<title>` tag in the frontmatter (Astro). Format: `"<Page Name> — <Site Name>"`, with the home page using just `"<Site Name>"`.
5. **Router** — Register all new routes (the scaffold only has `/` and `/about` — add all requested routes)
6. **Navigation** — Add links to the new Layout/Header component
7. **Entry HTML** — Update `index.html` (or `Layout.astro` for Astro) to load the chosen Google Fonts instead of the scaffold's DM Sans + Outfit

**Important**: Build real, functional UI with distinctive design applied — not placeholder "coming soon" pages, and not generic unstyled markup. Every page and component should reflect the chosen aesthetic from the moment it's created. The scaffold loading screen should be completely gone after this phase — no trace of the Power Pages branded animation should remain.

### 5.3 Source Real Images

Use high-quality photos from Unsplash wherever the site needs visual content. Do NOT use placeholder services (e.g., `placeholder.com`, `placehold.co`), broken `<img>` tags, or leave empty image slots.

**How to find images:**

1. Use `WebSearch` to search Unsplash for relevant photos (e.g., `site:unsplash.com modern office workspace`)
2. Pick specific photos and use their direct URL with sizing parameters: `https://images.unsplash.com/photo-{id}?w={width}&h={height}&fit=crop`
3. Choose images that match the site's aesthetic and mood

**Where to use images:**

- **Hero sections** — Striking, high-resolution photos that set the tone for the site
- **Feature/service cards** — Relevant photos that illustrate each feature or service
- **About/team sections** — Professional or contextual photos matching the site's purpose
- **Backgrounds** — Atmospheric photos used as full-bleed or overlay backgrounds
- **Content sections** — Supporting photos that break up text and add visual interest

**Guidelines:**

- Pick images that feel cohesive together — consistent style, lighting, and color tone
- Use appropriate sizing (`w=800` for cards, `w=1600` for heroes/backgrounds) to avoid slow loads
- Add descriptive `alt` text to every `<img>` for accessibility
- For icons and logos, use inline SVGs instead of photos

### 5.4 Git Commit Checkpoints

Commit after **every individual page and component** so breaking changes can be reverted. Each page and each component gets its own commit — do NOT batch multiple pages or components into a single commit.

```powershell
git add -A
git commit -m "<short description of what was added/changed>"
```

**When to commit:**

- After applying design foundations (fonts, colors, motion)
- After creating each page (e.g., "Add Home page", "Add Contact page")
- After creating each shared component (e.g., "Add Navbar component", "Add Footer component")
- After updating routing and navigation
- Before attempting anything risky or experimental

**If something breaks**, revert to the last good commit:

```powershell
git revert HEAD
```

### 5.5 Live Verification

After each significant change (new page or component), browse the site via Playwright to ensure everything is up to the mark:

1. Use `mcp__plugin_power-pages_playwright__browser_navigate` to reload or navigate to the updated page
2. Use `mcp__plugin_power-pages_playwright__browser_snapshot` to verify the page structure and content are correct — do NOT take screenshots
3. If something looks wrong in the snapshot, fix it before proceeding

The user is previewing in their own browser via the dev server URL shared in Phase 2.7.

> **GATE: Do NOT proceed to Phase 6 until ALL customization is complete with design applied.** The site must have distinctive typography (Google Fonts — no generic Inter/Roboto/Arial), a cohesive color palette (CSS variables), motion/animations, and all requested pages/features before moving to accessibility verification.

**Output**: All pages, components, and design elements implemented and verified

---

## Phase 6: Accessibility Verification

**Goal**: Verify the site meets WCAG 2.2 AA standards using axe-core automated testing and fix any violations

> **Prerequisite:** All pages and components must be fully implemented (Phase 5 complete). The dev server MUST be running.

**Actions**:

### 6.1 Install Playwright Dependency

Install `playwright` as a dev dependency in the project so the audit script can launch a headless browser. This uses the system-installed browser (Edge/Chrome) — no browser download is needed:

```powershell
cd "<PROJECT_ROOT>"
npm install --save-dev playwright
```

### 6.2 Run axe-core Audit on Every Page

Run the audit script via `Bash`, passing the dev server URL and all site routes:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/skills/create-site/scripts/axe-audit.js" --url <DEV_SERVER_URL> --routes /,/about,/services,/contact --project-root "<PROJECT_ROOT>"
```

The script launches a headless browser, navigates to each route, injects axe-core from CDN, runs the analysis, and outputs a JSON array of per-route results to stdout. Each result contains `violations` (with `id`, `impact`, `description`, `helpUrl`, and affected `nodes`), `passes` count, and `incomplete` count. The script exits with code 1 if any `critical` or `serious` violations are found.

Parse the JSON output and record all violations.

### 6.3 Fix Accessibility Violations

For each violation found, identify the source file and apply the fix:

| Violation | Fix |
|-----------|-----|
| Missing `alt` text on images | Add descriptive `alt` attributes to `<img>` tags |
| Insufficient color contrast | Adjust CSS color variables to meet 4.5:1 (normal text) or 3:1 (large text) ratios |
| Missing form labels | Add `<label>` elements or `aria-label` attributes |
| Missing landmark regions | Wrap content in `<main>`, `<nav>`, `<header>`, `<footer>` |
| Skipped heading levels | Correct heading hierarchy (h1 → h2 → h3, no gaps) |
| Missing link text | Add descriptive text or `aria-label` to links |
| Missing `lang` attribute | Add `lang="en"` to the `<html>` tag |
| Inadequate focus indicators | Add visible `outline` styles to interactive elements |

After fixing each group of related violations, commit:

```powershell
git add -A
git commit -m "Fix accessibility: <violation description>"
```

### 6.4 Re-verify After Fixes

After all fixes are applied, re-run the audit script (same command as 6.2) to confirm violations are resolved:

1. If new violations appear (e.g., a fix introduced a regression), repeat 6.3–6.4
2. Continue until the script exits with code 0 (zero `critical` and `serious` violations)

Present a summary table to the user:

```
| Page | Route | Violations Found | Violations Fixed | Status |
|------|-------|-----------------|-----------------|--------|
| Home | / | 3 | 3 | Pass |
| About | /about | 1 | 1 | Pass |
| Contact | /contact | 2 | 2 | Pass |
| **Total** | | **6** | **6** | **All passing** |
```

> **GATE: Do NOT proceed to Phase 7 until all pages pass axe-core with zero `critical` and `serious` violations.** Minor and moderate violations should also be fixed where possible, but are not blocking.

**Output**: Accessibility-verified site with zero critical/serious axe-core violations

---

## Phase 7: Review & User Testing

**Goal**: Ensure the site meets user expectations and all pages work correctly

**Actions**:

1. Browse through each page via Playwright (`browser_navigate` + `browser_snapshot`) to verify all pages load correctly — do NOT take screenshots
2. Present a summary of what was built:

   ```
   | Component Type      | Count | Details |
   |---------------------|-------|---------|
   | Pages               | 4     | Home (/), About (/about), Services (/services), Contact (/contact) |
   | Shared Components   | 3     | Navbar, Footer, ContactForm |
   | Design Elements     | 4     | Playfair Display + Source Sans Pro, 6 CSS variables, fade-in transitions, gradient backgrounds |
   | Git Commits         | 7     | scaffold + 6 feature commits |
   ```

3. Share the dev server URL with the user and list all available routes
4. Ask the user to review using `AskUserQuestion`:
   > "The site is ready for review at `<dev server URL>`. Please check it out in your browser. Would you like any changes?"
5. If the user requests changes, apply them and re-verify by browsing via `browser_snapshot`

**Output**: User-approved site ready for deployment

---

## Phase 8: Deployment & Next Steps

**Goal**: Deploy the site and suggest enhancements

> **This phase is MANDATORY. Do NOT end the session without asking about deployment.**

**Actions**:

1. Record skill usage:

   > Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

   Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "CreateSite"`. Note: `.powerpages-site` may not exist for first-time sites — the script exits silently.

2. Use `AskUserQuestion` with options: **Deploy now (Recommended)**, **Skip for now**:
   > "Would you like to deploy your site to Power Pages now?"
3. If the user chooses to deploy, invoke the `/deploy-site` skill.
4. Mark all todos complete
5. Present a final summary:
   - Site name and purpose
   - Framework and project location
   - Components created (X pages, Y components, Z design elements)
   - Key files and their purposes
   - Total file count and git commit count
6. Suggest optional enhancement skills:
   - `/setup-datamodel` — Create Dataverse tables for dynamic content
   - `/add-seo` — Add meta tags, robots.txt, sitemap.xml, favicon
   - `/add-tests` — Add unit tests (Vitest) and E2E tests (Playwright)

**Output**: Deployed (or deployment-ready) site with clear next steps

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **Ask for user confirmation** at key decision points (see list below)
- **Use best judgement** for design details — make confident, creative choices based on the user's aesthetic + mood selection without asking for every specific font, color, or layout decision
- **Apply design from the start** — never build neutral then restyle
- **Verify via Playwright** after every significant change
- **Commit after every page and component** — each gets its own dedicated commit, never batch multiple together
- **No screenshots** — only use `browser_snapshot` (accessibility snapshots) to verify pages; never use `browser_take_screenshot` as it clutters the user's directory. Give the user the dev server URL for visual preview.

### Key Decision Points (Wait for User)

1. After Phase 1: Confirm site purpose, framework, and project location
2. After Phase 4: Approve implementation plan
3. After Phase 7: Accept site or request changes
4. At Phase 8: Deploy or skip

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Discover site requirements | Discovering requirements | Collect site name, framework, purpose, audience, and project location |
| Scaffold and launch dev server | Scaffolding project | Copy template, replace placeholders with defaults, git init, npm install, start dev server, share URL |
| Plan site components | Planning components | Determine pages, components, design direction, and routes while user previews scaffold |
| Approve implementation plan | Getting plan approval | Present implementation plan covering design and pages, get user approval |
| Implement pages and components | Building site | Apply chosen design tokens, create all pages, components, routing, navigation |
| Verify accessibility with axe-core | Verifying accessibility | Run axe-core on every page, fix all critical/serious violations, re-verify until passing |
| Review with user | Reviewing site | Navigate all pages, share URL, get user feedback, apply changes |
| Deploy and wrap up | Deploying site | Ask about deployment, present summary, suggest next steps |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`. This gives the user visibility into progress and keeps the workflow deterministic.

### Quality Standards

Every site must meet these standards before completion:

- Distinctive typography via Google Fonts (no generic Inter/Roboto/Arial)
- Cohesive color palette via CSS variables
- Motion/animations (page transitions, hover states)
- All requested pages and features implemented (not placeholders)
- All routes working and navigation complete
- Accessibility verified via axe-core — zero critical/serious violations on all pages
- Git commits at key milestones
- Verified via Playwright
- User reviewed and approved
- Deployment offered

---

## Example Workflow

### User Request

"Create a partner portal for our consultants"

### Phase 1: Discovery

- Name: Partner Portal
- Framework: React
- Purpose: Company Portal
- Audience: Internal (partners, consultants)
- Location: New folder `partner-portal` in current directory

### Phase 2: Scaffold & Launch

- React template copied, default placeholders replaced
- Git initialized, npm installed, dev server running at `http://localhost:5173`
- Playwright verified scaffold loads
- URL shared with user — they can preview immediately

### Phase 3: Component Planning

- Features: Consultant Directory, Project Tracker, Document Library, Announcements
- Aesthetic: Minimal & Clean
- Mood: Professional & Trustworthy
- Component table presented and approved
- Design choices made: DM Sans + Space Grotesk, `#1e3a5f` primary, blue-gray palette

### Phase 4: Plan Approval

- Plan presented inline with design & pages + review & deployment sections
- User approved via AskUserQuestion

### Phase 5: Implementation

- Todos created for each page, component, routing, navigation, design foundations
- Built in order: design tokens (replace defaults with chosen palette) → shared components → pages → router → nav
- Git commits after each major piece
- Playwright verified each page

### Phase 6: Accessibility Verification

- axe-core injected and run on all 4 pages via `browser_evaluate`
- Found 5 violations: 2 missing alt text, 1 insufficient contrast, 1 missing lang attribute, 1 skipped heading level
- All violations fixed in source code and committed
- Re-run confirmed zero critical/serious violations across all pages

### Phase 7: Review

- Summary table presented
- User reviewed at `http://localhost:5173`, requested minor color adjustment
- Adjustment applied, re-verified

### Phase 8: Deploy

- User chose to deploy → invoked `/deploy-site`
- Final summary presented with next step suggestions

---

**Begin with Phase 1: Discovery**
