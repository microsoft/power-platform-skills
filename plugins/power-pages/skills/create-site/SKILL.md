---
name: create-site
description: >-
  Creates a new Power Pages site. For code sites (SPAs) using React, Angular, Vue, or Astro, guides
  the full process from requirements discovery through scaffolding, component planning, design,
  implementation, validation, and deployment. For Standard or Enhanced data model declarative
  sites, provisions a documented Microsoft template, verifies the selected model, downloads the
  site, validates its identity and Bootstrap assets, and coordinates approved image-rich design.
  Use when the user wants to create, build, or
  scaffold a new Power Pages website or portal.
user-invocable: true
argument-hint: Optional site description
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, WebSearch, AskUserQuestion, Skill, Task, TaskCreate, TaskUpdate, TaskList, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_snapshot, mcp__plugin_power-pages_playwright__browser_click, mcp__plugin_power-pages_playwright__browser_take_screenshot, mcp__plugin_power-pages_playwright__browser_evaluate
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Create Power Pages Site

Route the request to the correct creation workflow before collecting framework- or
template-specific details.

## Core Principles

- **Use best judgement for design details**: Once the user picks an aesthetic direction and mood, make confident decisions about specific fonts, colors, page layouts, and component behavior. Do not ask the user to specify every detail — use the design reference and your own taste to make creative, distinctive choices.
- **Use TaskCreate/TaskUpdate**: Track all progress throughout all phases — create the todo list upfront with all phases before starting any work.
- **Platform-scoped design guidance**: After routing, code sites follow the existing SPA design references and workflow below unchanged. Classic sites use `${PLUGIN_ROOT}/references/site-design-quality.md` and the native adapters for the experience brief, composition, imagery, and accessibility. Carry known classic design decisions through native handoffs; classic exceptions never alter SPA fonts, plan fields, rendering requirements, scores, or completion gates.
- **Classic template role**: Use the selected creation template as data-model/domain and requirements context, not a constraint on visual design, page composition, layout, or branding. Carry the user's modern design intent and explicit preservation preferences into the classic customization workflow; required capabilities and native platform contracts still apply.
- **Image URLs during classic creation**: Add images using approved direct HTTPS URLs, not downloads or new image Web Files. Reuse template images when they fit the approved design; do not upload local images or publish generated illustrations automatically.
- **Classic sites need no dev server or live preview**: Use native Bootstrap-aware authoring and local verification. Provisioning status pages and approval documents are not site previews.

**Initial request:** $ARGUMENTS

---

## Site-Type Routing

Determine the site type before creating the phase task list.

Classify the signals in `$ARGUMENTS`:

- React, Vue, Angular, Astro, SPA, or code site → **Code site**
- Classic, Liquid, EDM, enhanced data model, SDM, standard data model, Program Registration, Event Portal,
  Schedule Meetings, or Power Pages template → **Declarative site**

Infer the route only when exactly one site type is indicated. If both types are indicated, treat the
request as ambiguous and ask the site-type question below.

<!-- gate: create-site:0.site-type | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:0.site-type):** Ambiguous creation request — choose between a
> generated SPA code site and a platform-provisioned declarative site.
>
> **Trigger:** `$ARGUMENTS` does not establish the site type.
> **Why we ask:** The two routes create different artifacts and use different provisioning models.
> **Cancel leaves:** Nothing — no files or cloud resources exist.

If the request is ambiguous, use `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Which type of Power Pages site should I create? | Site type | Declarative site from a Microsoft template, Code site using React/Vue/Angular/Astro |

After the route is known:

- **Declarative site:** Read and follow
  `${PLUGIN_ROOT}/skills/create-site/workflows/declarative-site.md`. Do not continue into the code-site
  phases below.
- **Code site:** Continue with the existing workflow below.

### Declarative Approval Gates

The declarative workflow file contains the detailed call sites. These markers keep every
load-bearing declarative question paired with the repository gate catalog.

<!-- gate: create-site:declarative-1-select-model | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:declarative-1-select-model):** Select Standard or Enhanced when
> the request did not already specify the declarative model.

<!-- gate: create-site:declarative-1-confirm-environment | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · create-site:declarative-1-confirm-environment):** Confirm the exact target
> environment before any declarative planning or provisioning.

<!-- gate: create-site:declarative-1-confirm-capability | category=progress | cancel-leaves=nothing -->

> 🚦 **Gate (progress · create-site:declarative-1-confirm-capability):** Require administrator
> confirmation that the environment EDM toggle is enabled for Enhanced or disabled for Standard.

<!-- gate: create-site:declarative-2-select-template | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:declarative-2-select-template):** Select one exact identifier from
> the supported declarative template allowlist.

<!-- gate: create-site:declarative-4-provision | category=final | cancel-leaves=nothing -->

> 🚦 **Gate (final · create-site:declarative-4-provision):** Final consent immediately before the
> Create Website API call.

<!-- gate: create-site:declarative-8-customize | category=plan | cancel-leaves=declarative-baseline -->

> 🚦 **Gate (plan · create-site:declarative-8-customize):** Choose whether to customize the
> verified downloaded template through `/customize-declarative-site`.

---

## Code-Site Workflow

The following server, preview, SPA asset, and scaffold instructions apply **only to code sites**.
Only static SPA frameworks are supported here (React, Vue, Angular, Astro), not Next.js, Nuxt.js,
Remix, SvelteKit, or Liquid. Classic Liquid sites use the declarative route above.

- **Scaffold early, design with intention**: Get the dev server running immediately after discovery, then plan the design and features while the scaffold is live.
- **Live preview feedback loop**: The dev server MUST be running before any customization begins. Browse the site via Playwright (`browser_navigate` + `browser_snapshot`) to verify the structure of every significant change. Visual design review captures every page with one script call and opens the screenshots in one turn (see [5.7](#57-design-critique-pass)); use Playwright MCP screenshots only for brand extraction in Phase 3.
- **Keep the scaffold loader in sync**: Update `public/scaffold-status.json` before every `AskUserQuestion` and each Phase 5 implementation step. See [Live Preview Status Protocol](#live-preview-status-protocol).
- **Use purposeful visuals**: Every image explains, orients, demonstrates, or reinforces identity. Prefer the site's own UI composed as a product moment, then bespoke inline SVG, then specific Unsplash photography with one art direction (see [5.3](#53-source-purposeful-visuals)). Never leave image placeholders or broken `<img>` tags pointing to nonexistent files.
- **Git checkpoints**: Commit after each page and component so coherent changes can be reverted.

Guide the user through creating a complete, production-quality Power Pages code site from initial
concept to deployed site. Discover requirements, scaffold and launch immediately, plan components
and design, implement with design applied, validate, review, and deploy.

## Live Preview Status Protocol

<!-- not-a-gate: prose-only section — mentions of `AskUserQuestion` here describe the live-status protocol that wraps every real prompt in Phases 3/4/8; the actual gates are catalogued in §6.13 of references/approval-gates.md and marked at their call sites below -->

While the scaffold loading screen is visible (from Phase 2.6 until the Home page itself is replaced in Phase 5), the loader polls `GET /scaffold-status.json` every 1.5 seconds. The `message` you write into `<PROJECT_ROOT>/public/scaffold-status.json` appears as the label under the progress bar, and `awaitingInput` controls the "waiting for your input" banner. The decorative spinner above the progress bar continues its built-in phrase cycle; keep the progress-bar label current so the loader still reflects what is actually happening.

**Why this matters**: When the browser with the loader takes over the user's screen, a prompt in the terminal can sit unanswered for a long time because the user doesn't realize anything is waiting. The banner makes it obvious.

**File shape** (all fields optional — omit any field you don't want to change):

```json
{
  "message": "Creating Contact page",
  "awaitingInput": false,
  "inputPrompt": "Please check your terminal to respond."
}
```

- `message` — one short present-participle phrase shown as the status line under the progress bar in the loader (replacing the default "Getting started…" / "Setting up infrastructure…" cycle). Include the grouping context inline when it helps (e.g., `"Creating Footer component (shared components)"`).
- `awaitingInput` — when `true`, a prominent pulsing banner appears at the top of the loader and stays visible until this field is cleared. Set this **before** every `AskUserQuestion` call and clear it (`false`) **immediately after** the user answers.
- `inputPrompt` — short context for the banner (e.g., `"Choose a framework"`). Optional.

**When to update the file**:

1. **After scaffold launches (end of Phase 2)**: write an initial status like `{ "message": "Planning your site", "awaitingInput": false }`.
2. **Before any `AskUserQuestion` that runs while the scaffold is visible** (Phases 3, 4, and any in-scaffold prompt in Phase 5): set `awaitingInput: true` with a short `inputPrompt`. After the user answers, write again with `awaitingInput: false`.
3. **Before each implementation step in Phase 5** — applying design tokens, creating each shared component, creating each page, updating the router, updating navigation — update `message` to the specific action. Examples: `"Applying design tokens"`, `"Creating Navbar component"`, `"Creating Contact page"`.
4. **At the end of Phase 5, after the Home page has been replaced**: delete `public/scaffold-status.json` so it isn't deployed with the site.

Write the file with the `Write` tool (atomic overwrite). You do not need to read it first.

---

## Phase 1: Discovery

**Goal**: Understand what site needs to be built and what problem it solves

**Actions**:

<!-- gate: create-site:1.purpose | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:1.purpose):** Multi-question prompt collecting site name, framework, purpose, audience, and target directory. Determines what gets scaffolded. Fires only on the "site purpose unclear" branch (step 3 below).
>
> **Trigger:** Phase 1 when site purpose was not provided in `$ARGUMENTS`.
> **Why we ask:** Wrong framework picked → wrong template copied into the wrong directory; cleanup is annoying.
> **Cancel leaves:** Nothing — no scaffolding has started yet.

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

> See `${PLUGIN_ROOT}/references/framework-conventions.md` for the full framework → build tool → router → output path mapping.

**Actions**:

### 2.1 Copy Template

> `${PLUGIN_ROOT}` is already resolved to the plugin's absolute path at runtime. Use it directly in Glob/Read paths — do NOT search for the plugin directory.

Read and copy all files from the matching asset template to the project directory:

| Framework | Asset Directory |
|-----------|----------------|
| React | `${PLUGIN_ROOT}/skills/create-site/assets/react/` |
| Vue | `${PLUGIN_ROOT}/skills/create-site/assets/vue/` |
| Angular | `${PLUGIN_ROOT}/skills/create-site/assets/angular/` |
| Astro | `${PLUGIN_ROOT}/skills/create-site/assets/astro/` |

Use `Glob` to discover all files in the asset directory, `Read` each file, then `Write` to the project directory preserving the relative path structure.

**Also copy the shared loader icon** that the scaffold references from its CSS (`url('/power-pages-icon.png')`):

`Read` the binary file `${PLUGIN_ROOT}/skills/create-site/assets/shared/power-pages-icon.png` and `Write` it to `<PROJECT_ROOT>/public/power-pages-icon.png`. (All four supported frameworks serve `public/` at the web root, so the same `/power-pages-icon.png` URL works for every framework.)

**Seed the live status file** so the loader shows a real message the moment it mounts. `Write` `<PROJECT_ROOT>/public/scaffold-status.json`:

```json
{ "message": "Planning your site", "awaitingInput": false }
```

See [Live Preview Status Protocol](#live-preview-status-protocol) for the full contract — from here on, update this file before every `AskUserQuestion` and before each Phase 5 implementation step.

### 2.2 Replace Placeholders

After copying, replace all `__PLACEHOLDER__` tokens in every file. Use `Edit` with `replace_all: true` on each file.

- **Name/slug/description placeholders**: Use the actual values from Phase 1 (`__SITE_NAME__`, `__SITE_SLUG__`, `__SITE_DESCRIPTION__`).

> **Note:** The scaffold loading screen uses hardcoded Power Pages branding colors — there are no color placeholders (`__PRIMARY_COLOR__`, etc.) to replace. The user's chosen color palette is applied fresh during Phase 5 when the scaffold is completely replaced.

### 2.3 Rename gitignore

Rename `gitignore` → `.gitignore` in the project root (stored without dot prefix to avoid git interference in the plugin repo).

### 2.4 Install Dependencies

Run `npm install` **before** initializing git so that `package-lock.json` is included in the initial commit:

```bash
cd "<PROJECT_ROOT>"
npm install
```

> **Astro requires Node 22.12 or newer.**
> Astro 7 exits with `Node.js vX is not supported by Astro!` on anything older, so when the chosen framework is Astro, run `node --version` first and ask the user to upgrade before continuing.

### 2.5 Initialize Git Repository

Initialize a git repo and make the first commit. This captures all template files AND `package-lock.json` in one clean baseline:

```bash
cd "<PROJECT_ROOT>"
git init
git add -A
git commit -m "Initial scaffold: __SITE_NAME__ (__FRAMEWORK__)"
```

From this point, **commit after every significant milestone** so any breaking change can be reverted.

### 2.6 Start Dev Server

**This MUST happen now — before any planning or customization begins.** The dev server gives the user a live preview while features and design are being planned:

```bash
cd "<PROJECT_ROOT>"
npm run dev
```

Run `npm run dev` in the background using `Bash` with `run_in_background: true`. Note the local URL (typically `http://localhost:5173` for Vite or `http://localhost:4200` for Angular or `http://localhost:4321` for Astro).

### 2.7 Verify in Playwright & Share URL

Immediately after the dev server starts, verify the scaffold is working:

1. Use `mcp__plugin_power-pages_playwright__browser_navigate` to open the dev server URL
2. Use `mcp__plugin_power-pages_playwright__browser_snapshot` to verify the page loaded correctly (accessibility snapshots only - screenshots are reserved for the Phase 5 design checks)
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

<!-- gate: create-site:3.requirements | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:3.requirements):** Four sub-prompts (features multi-select, aesthetic, mood, brand) plus a brand follow-up when the user has brand inputs - shape the Phase 4 plan and the Phase 5 implementation. Fires at step 2 of the action list below.
>
> **Trigger:** Phase 3 entry; scaffold loader is up.
> **Why we ask:** Wrong feature set / aesthetic / brand gets baked into the rendered plan - the Phase 4.7 gate would still catch most errors, but it's wasteful to defer the catch.
> **Cancel leaves:** Nothing — scaffold loader files are throwaway artifacts replaced wholesale in Phase 5.

**Actions**:

1. **Raise the "awaiting input" banner** so the user notices the terminal prompt even while the browser loader is full-screen. `Write` `<PROJECT_ROOT>/public/scaffold-status.json`:

   ```json
   { "message": "Planning your site", "awaitingInput": true, "inputPrompt": "Features, aesthetic, mood, and brand - please answer in the terminal." }
   ```

   Immediately after the user answers (including any brand follow-up), `Write` the same file again with `"awaitingInput": false` so the banner disappears.

2. Use `AskUserQuestion` to collect feature and design requirements:

   | Question | Header | Options |
   |----------|--------|---------|
   | Which features? (multi-select) | Features | *(generate 3-4 context-aware options based on the site name, purpose, and audience from Phase 1)* |
   | What aesthetic direction do you want? | Aesthetic | Minimal & Clean (Recommended), Bold & Vibrant, Dark & Moody, Warm & Organic |
   | What's the overall mood? | Mood | Professional & Trustworthy (Recommended), Creative & Playful, Technical & Precise, Elegant & Premium |
   | Is there an existing brand the site should match? | Brand | No, create a fresh identity (Recommended), Match my existing website, Use my brand colors or logo |

   **Brand follow-up.** Record the answer as `BRAND_SOURCE` (`fresh`, `website`, or `assets`). For **Match my existing website**, use `AskUserQuestion` to ask for the URL (free text - use a single generic option so the user types it via "Other"); accept only an `http://` or `https://` URL and ask again otherwise. For **Use my brand colors or logo**, ask the same way for the hex colors and/or the absolute path of a logo file.

   > **Feature options are NOT hardcoded.** Infer relevant features from Phase 1 answers. For example:
   > - "HR Dashboard" + Internal → Employee Directory, Leave Requests, Announcements, Org Chart
   > - "Contoso Portal" + External → Contact Form, Service Catalog, Knowledge Base, FAQ
   > - "Partner Hub" + Internal → Document Library, Partner Directory, Deal Tracker, Notifications
   >
   > Always generate options that make sense for the specific site — never reuse a fixed list.
   >
   > **If you include an Authentication feature option**, describe it generically as "Login/signup for tracking application status" or similar. Do NOT mention a specific identity provider (e.g., "Entra ID", "SAML", "Google") in the feature description — the `/power-pages:setup-auth` skill will ask the user which provider they want.

3. **AI Component Planning** — Based on Phase 1 answers (site name, purpose, audience) and the feature selection above, propose which of the Power Pages generative-AI summarization APIs the site might use. The site itself does not depend on them — the page ships with reserved slots and runs without AI; `/add-ai-webapi` populates the slots later when the user is ready. Use `AskUserQuestion` with multi-select to let the user opt in:

   | Question | Header | Options |
   |----------|--------|---------|
   | Which AI summarization features should the site have? (multi-select — each can be added later with `/add-ai-webapi`) | AI Summaries | *(generate 2-4 context-aware options plus "None for now")* |

   > **Options are NOT hardcoded.** Infer relevant AI summary features from Phase 1 and the features picked above. Examples:
   > - "HR Dashboard" + Leave Requests feature → "Data summarization for leave requests", "Search summary on the knowledge base"
   > - "Contoso Portal" + Knowledge Base → "Search summary on site-wide search", "Data summarization for articles"
   > - "Customer Self-Service" + Support Cases / Incidents → "Data summarization for support cases (Microsoft-shipped recipe)", "Data summarization for attached knowledge articles"
   >
   > Treat the standard `incident` table like any other Dataverse table — propose Data
   > Summarization for it when the site handles support cases, but don't force the Microsoft-shipped
   > recipe (`$select=description,title` + the portal-comments expand) unless that genuinely fits
   > the user's UX. A custom case-like table or a different facet of the standard incident is a
   > regular Data Summarization pick. Always include **None for now** so the user can defer. Do
   > NOT integrate the APIs in this skill — only record the user's picks so Phase 4's plan can
   > mention them and Phase 8 can suggest `/add-ai-webapi` as a recommended next step.
   >
   > Capture the selection in memory as `AI_SUMMARY_PICKS` — a list of one or more of: `search-summary`, `data-summarization`.

4. **Map picks to target pages.** For each entry in `AI_SUMMARY_PICKS`, decide which page will carry the AI surface and store the mapping as `AI_SUMMARY_PLACEMENTS`. This is what Phase 4 shows the user and what Phase 5 reserves slots for. Use the feature selection from step 2 — and treat this mapping as an *input* to the page list Claude proposes in step 7: if a pick has no natural target page, add one to the plan so the summary has a home:

   | Pick | Default target page | If no matching page is planned |
   |------|--------------------|-------------------------------|
   | `search-summary` | A search / search-results page (e.g., `SearchResults`, `Search`) | Add a search page to the plan so the summary has a home |
   | `data-summarization` | The detail page of the table the user called out (e.g., `ProductDetail` for products, `CaseDetail` for support cases) — ask the user if ambiguous | Propose adding a detail page; if rejected, fall back to a list/dashboard page |

   `AI_SUMMARY_PLACEMENTS` shape: one record per placement, e.g.
   `[{ pick: "data-summarization", targetPage: "CaseDetail", marker: "POWERPAGES:AI-SLOT kind=data-summarization" }]`.

   The `marker` string is the comment tag Phase 5 emits into the page source as a reserved anchor that `/add-ai-webapi` later finds. Keep the shape uniform — one marker per placement, always the same tag, so the follow-up skill's explore step can grep for them deterministically.

5. Read the design references: `${PLUGIN_ROOT}/references/design-aesthetics.md` and `${PLUGIN_ROOT}/references/page-blueprints.md`.
6. **Write the experience brief** (design-aesthetics.md section 1) - audience and job, primary and secondary action, principal doubt, proof strategy, design thesis, hero concept, and signature moment. Resolve the brand source first (section 2): for `website`, extract the brand from the URL with the Playwright snippet there; for `assets`, build the palette around the supplied colors; for `fresh`, start from the matching cell of the aesthetic x mood map (section 11). Record the display and body fonts, color direction, geometry, and motion direction.
7. Analyze requirements and determine needed components. Plan each page's content as narrative beats from `page-blueprints.md`, in order, one line per section with its purpose. If `AI_SUMMARY_PLACEMENTS` from step 4 implies a page that wasn't already in the plan (e.g., a `CaseDetail` page for a data-summarization pick on the support-case table), add it to the page list now. Present the component plan to the user as a table:

   ```
   | Component Type      | Count | Details |
   |---------------------|-------|---------|
   | Pages               | 4     | Home, About, Services, Contact |
   | Shared Components   | 3     | Navbar, Footer, ContactForm |
   | Design Elements     | 5     | Schibsted Grotesk + Public Sans, 15 color tokens, product-moment hero, status-timeline signature moment, paper-grain backgrounds |
   | Routes              | 4     | /, /about, /services, /contact |
   ```

8. Choose the final color tokens - every color role in design-aesthetics.md section 3 - from the brief and brand source. Check each text and background pair against WCAG AA now, before the values reach the plan. These are written fresh into a new `theme.css` during Implementation (Phase 5) when the scaffold loading screen is completely replaced.

**Output**: Confirmed list of pages (with narrative beats), components, design elements, and routes to create, plus the experience brief and color tokens

---

## Phase 4: Plan Approval

**Goal**: Render the implementation plan as an HTML document, open it in the user's default browser, and get approval before starting implementation.

> **Why HTML instead of a chat message**: A structured HTML plan (like the ones produced by `/integrate-backend`, `/add-server-logic`, and `/add-cloud-flow`) lets the user skim sections, compare swatches, and preview typography — all impossible in a terminal. The scaffold loader in their browser may also be full-screen, so surfacing the plan in a new tab puts it where they can actually read it.

### 4.1 Read the Design References

Read `${PLUGIN_ROOT}/references/design-aesthetics.md` and `${PLUGIN_ROOT}/references/page-blueprints.md` if they are not already in context. Every field you populate below must trace back to the experience brief from Phase 3.

> **AI Readiness in the plan.** If `AI_SUMMARY_PLACEMENTS` from Phase 3 is non-empty, reflect each placement in the matching `PAGES_DATA` entry's `description` or `content` — e.g., *"Reserved slot for an AI summary card; populated later by `/add-ai-webapi`. The page ships without AI."* This keeps the user's expectation honest: the site does not depend on generative-AI features being enabled on the tenant, and there is no "Run /add-ai-webapi" placeholder visible to end-users. If `AI_SUMMARY_PLACEMENTS` is empty, omit any AI references from the plan.

### 4.2 Build the Plan Data

Assemble a single JSON object with the following keys. The plan template rejects any data that's missing a required key, so include all of them.

| Key | Type | Content |
|-----|------|---------|
| `SITE_NAME` | string | Title-case site name from Phase 1 |
| `PLAN_TITLE` | string | Always `"Implementation Plan"` |
| `FRAMEWORK` | string | `React` / `Vue` / `Angular` / `Astro` |
| `AESTHETIC` | string | Chosen aesthetic (e.g., `Minimal & Clean`) |
| `MOOD` | string | Chosen mood (e.g., `Professional & Trustworthy`) |
| `SUMMARY` | string | One paragraph describing what the site is and who it serves |
| `DESIGN_DIRECTION_DATA` | object | The experience brief: `{ thesis, brandSource, audience, primaryAction, secondaryAction, principalDoubt, proofStrategy, heroConcept, signatureMoment }` - all strings. `brandSource` says where tokens came from (e.g., `"Fresh identity"`, `"Matched to https://contoso.com"`) |
| `TYPOGRAPHY_DATA` | object | `{ primary: { name, sample, reason }, secondary: { name, sample, reason } }` - `primary` is the body face, `secondary` the display face; `name` must be a family from the verified faces table in design-aesthetics.md (or the brand's own Google Font) |
| `PALETTE_DATA` | array | `[{ var, hex, description }]` - one entry per color token from design-aesthetics.md section 3 |
| `MOTION_DATA` | array | `[{ label, description }]` - first-screen entrance, signature moment, scroll reveals, interaction states, route transitions |
| `BACKGROUNDS_DATA` | array | `[{ label, description }]` - hero atmosphere, section bands, textures, patterns |
| `PAGES_DATA` | array | `[{ name, route, description, content: [...], components: [...] }]` - `content` is the page's narrative beats in order, one line per section with its purpose; `components` is shared component names used |
| `COMPONENTS_DATA` | array | `[{ name, purpose, usedBy: [...] }]` — shared components with the page names that consume them |
| `ROUTES_DATA` | array | `[{ path, page }]` — every route the router will register |
| `REVIEW_DATA` | array of strings | Verification checklist items - include "Design critique: no critical gate fails; after up to three rounds, every category below 3 is recorded with its reason" alongside items like "All pages load without console errors" |
| `DEPLOYMENT_DATA` | array | `[{ title, description, recommended?: boolean }]` — mark exactly one as `recommended: true` |

**Write the data for the user**, not for internal tooling — phrase `description` and `reason` fields in plain language.

### 4.3 Render the HTML Plan

Pick an output path under `<PROJECT_ROOT>/docs/`. Default is `create-site-plan.html`; if that file already exists, pick a descriptive variant like `create-site-plan-v2.html` (the render script refuses to overwrite existing files).

```bash
node "${PLUGIN_ROOT}/scripts/render-createsite-plan.js" --output "<PROJECT_ROOT>/docs/create-site-plan.html" --data - <<'PLAN'
<plan JSON>
PLAN
```

Send the plan JSON on stdin as shown, so no temp file is written and nothing in it - such as the brand URL the user typed - is parsed by the shell; the quoted `'PLAN'` delimiter turns off expansion.

The script prints `{"status":"ok","output":"<path>"}` on success. Capture and use that actual output path for the next step.

### 4.4 Open the Plan in the Default Browser

Open `<OUTPUT_PATH>` in the default browser using the platform-appropriate file opener for the current environment. For example, use `open` on macOS, `xdg-open` on Linux, or the equivalent default-browser opener available on Windows.

### 4.5 Present a Brief Summary in the Terminal

Keep the terminal message short — **the full plan lives in the HTML file now**. Include:

- One sentence confirming the plan was rendered and where (the output path).
- A 3-5 line bullet summary: the design thesis, the signature moment, framework, page and component count.
- A pointer: "See the open browser tab for the design direction, pages, color swatches, typography samples, and deployment options."

Do NOT dump the full plan contents into the terminal — that defeats the purpose of the HTML view.

### 4.6 Raise the "Awaiting Input" Banner

The user may still be looking at the full-screen scaffold loader when you ask for approval. `Write` `<PROJECT_ROOT>/public/scaffold-status.json`:

```json
{ "message": "Ready to build", "awaitingInput": true, "inputPrompt": "Plan approval needed — review the plan in your browser and answer in the terminal." }
```

Immediately after the user answers, `Write` the same file again with `"awaitingInput": false`.

### 4.7 Ask for Approval

<!-- gate: create-site:4.7.plan-approval | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:4.7.plan-approval):** Final sign-off on the rendered HTML plan before Phase 5 starts replacing the scaffold with real pages, components, and design tokens.
>
> **Trigger:** Phase 4.3 rendered `docs/create-site-plan.html`; Phase 4.4 opened it in the browser.
> **Why we ask:** Phase 5 rewrites the entire scaffold (theme.css, Layout, Home page, components, routes) — undoing that touches every commit in the implementation phase.
> **Cancel leaves:** Nothing destructive — the scaffold itself can be deleted with the project directory; no Dataverse / deploy fired.

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Does this plan look good? | Plan | Approve and start building (Recommended), I'd like to make changes |

- **If "Approve"**: Proceed to Phase 5.
- **If "I'd like to make changes"**: Ask what they want changed, update the JSON, and re-render to a new filename (the render script won't overwrite). Re-open that new file in the browser and repeat 4.5–4.7.

**Output**: Approved implementation plan, with an HTML copy committed alongside the project for the user to reference during and after implementation.

---

## Phase 5: Implementation

**Goal**: Build all pages, components, and design elements with the design thesis applied from the start, then prove the result with a visual design critique

> **Prerequisite:** The dev server MUST already be running and verified via Playwright (completed in Phase 2). If it is not, go back and complete Phase 2.
>
> **Design references:** Build from `${PLUGIN_ROOT}/references/design-aesthetics.md` (the design system) and `${PLUGIN_ROOT}/references/page-blueprints.md` (page narratives, hero patterns, copy). Read them now if they are not already in context. All pages and components carry the chosen typography, color tokens, imagery, motion, and backgrounds from the start - do NOT build with neutral styling first and redesign later.

**Actions**:

### 5.1 Create Todos for All Work

**Before writing any code**, use `TaskCreate` to create a todo for every piece of work. This gives the user full visibility into what will be built:

- **One todo per page** — e.g., "Create Contact page (`/contact`)", "Create Dashboard page (`/dashboard`)"
- **One todo per shared component** — e.g., "Create ContactForm component", "Create DataTable component"
- **One todo for routing** — "Update router with all new routes"
- **One todo for navigation** — "Update Layout/Header with navigation links"
- **One todo for design foundations** - "Apply design tokens (theme tokens, fonts, motion, backgrounds)"
- **One todo for the design critique** - "Run design critique pass (desktop and mobile)"

Each todo should have a clear `subject`, `activeForm`, and `description` that includes the file path and what the page/component does. Then work through the todos in order, marking each `in_progress` → `completed`.

### 5.2 Replace the Scaffold & Build

The scaffold is a temporary loading screen — it must be **completely replaced** during this phase. Do NOT build on top of it or try to modify the loading animation into a real page. Start fresh with the user's chosen design.

> **Narrate progress in the loader**: Before each of the steps below, update `<PROJECT_ROOT>/public/scaffold-status.json` so the user — who may still be watching the Home page loader — sees what's actually happening instead of the hardcoded placeholder cycle. Use a short present-participle `message` (e.g., `"Creating Navbar component"`, `"Creating Contact page"`). Include any useful grouping context inline in the message itself. The loader picks up changes within ~1.5 seconds. Updates become no-ops once step 4 replaces the Home page.

1. **Design foundations** - **Completely rewrite** `theme.css` (or `styles.css` for Angular) from scratch with the full token set from design-aesthetics.md section 3, base element styles, the interaction-state styles from section 8, a `prefers-reduced-motion` block, and the background treatments. Add the chosen Google Fonts to the entry HTML's font `<link>` (`index.html`, or `Layout.astro` for Astro) *alongside* the scaffold's DM Sans + Outfit, which the loader still uses until step 4. The scaffold's loading-screen CSS is discarded entirely. Commit after this step. *Before starting, set the loader status to `{ "message": "Applying design tokens" }`.*
2. **Layout** - **Rewrite** the Layout component (and Header/Footer for Astro) with proper navigation, header, and footer that reflect the chosen design, with a link for every route in the approved plan so the header is final before the first-impression review. The scaffold's passthrough Layout is replaced with a real layout structure. *Set status to `{ "message": "Rewriting Layout" }`.*
3. **Shared components** - Build reusable components (Navbar, Footer, ContactForm, etc.) that pages will use, each with every state in the design-aesthetics.md state table that applies to it. *For each component, set status to `{ "message": "Creating <Component> component" }`.*
4. **Pages** - Create route components for each requested page, **replacing** the scaffold Home page and About placeholder entirely. **Build Home first, and its hero first**, following the hero concept from the brief. As soon as Home is built, run a **first-impression review** of `/` (see "Running a review" in [5.7](#57-design-critique-pass)) and fix the hero until it passes, for at most three rounds - every later page inherits that foundation. Build each page's sections in the order of its planned narrative beats. Each page component must update `document.title` on mount to reflect the current page (e.g., `"Contact — Contoso Portal"`). Use the framework's idiomatic lifecycle hook: `useEffect` (React), `onMounted` (Vue), `ngOnInit` (Angular), or a `<title>` tag in the frontmatter (Astro). Format: `"<Page Name> — <Site Name>"`, with the home page using just `"<Site Name>"`. *For each page, set status to `{ "message": "Creating <Page> page" }` before writing the file. The loader disappears when the Home page itself is replaced - no further status updates are needed after that.*
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

**Important**: Build real, functional UI with the design thesis applied - not placeholder "coming soon" pages, and not generic unstyled markup. Every page and component reflects the thesis from the moment it's created. The scaffold loading screen should be completely gone after this phase - no trace of the Power Pages branded animation should remain.

### 5.3 Source Purposeful Visuals

Follow the visuals order in design-aesthetics.md section 6: the site's own UI composed as a product moment first, bespoke inline SVG second, photography third. Do NOT use placeholder services (e.g., `placeholder.com`, `placehold.co`), broken `<img>` tags, or empty image slots.

**Finding photography:**

1. Use `WebSearch` to search Unsplash for the specific subject the section needs (e.g., `site:unsplash.com city clerk helping resident at counter`) - specific to the audience and the job, never a generic "business meeting".
2. Pick specific photos and use their direct URL with sizing parameters: `https://images.unsplash.com/photo-{id}?w={width}&h={height}&fit=crop` (`w=800` for cards, `w=1600` for heroes and full-bleed bands).
3. Choose photos that share one art direction - similar lighting and color temperature - and apply the same crop ratios and palette-tinted treatment to all of them.
4. Give every `<img>` descriptive `alt` text (or `alt=""` when decorative), explicit `width` and `height`, and `loading="lazy"` below the fold.

### 5.4 Git Commit Checkpoints

Commit after **every individual page and component** so breaking changes can be reverted. Each page and each component gets its own commit — do NOT batch multiple pages or components into a single commit.

```bash
git add -A
git commit -m "<short description of what was added/changed>"
```

Every tool call re-sends the whole conversation, so save calls without merging commits: write a component's files (e.g., `Navbar.tsx` and `Navbar.css`) in one turn, and when several components are written in one turn, make their separate commits in one command (`git add src/components/Navbar.* && git commit -m "Add Navbar component" && git add src/components/Footer.* && git commit -m "Add Footer component"`).

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

### 5.5 Live Verification

After each significant change (new page or component), browse the site via Playwright to confirm structure and content:

1. Use `mcp__plugin_power-pages_playwright__browser_navigate` to reload or navigate to the updated page
2. Use `mcp__plugin_power-pages_playwright__browser_snapshot` to verify the page structure and content are correct
3. If something looks wrong in the snapshot, fix it before proceeding

Visual judgement - screenshots at desktop and mobile widths - happens only in the first-impression review (step 4 of 5.2) and the critique pass (5.7). Screenshots stay in the conversation and are re-sent with every later call, so per-page checks during the build use `browser_snapshot`, not the capture script. The user is previewing in their own browser via the dev server URL shared in Phase 2.7.

### 5.6 Clean Up the Live Status File

Once the scaffold loader is gone, `public/scaffold-status.json` is just dead weight that would ship with the deployed site. Delete the file from `<PROJECT_ROOT>/public/` and commit the removal alongside the final implementation.

### 5.7 Design Critique Pass

Judge the site from screenshots against `${PLUGIN_ROOT}/references/design-critique.md` (read it once, at the first review). Every tool call re-sends the whole conversation, so the review is built to take few calls: one script call captures every route at both widths and runs the automated checks, and one turn opens all the screenshots in parallel. Single-step browser calls (navigate, resize, screenshot, evaluate per page) cost many times more for the same review.

**Running a review** (used for the first-impression review in 5.2 step 4 and for each critique round):

1. Capture by sending the request on stdin, as design-critique.md's Capture section shows - the dev server URL and the routes never go on the command line. Nothing needs installing: the script uses the plugin's pinned Playwright.

   ```bash
   node "${PLUGIN_ROOT}/scripts/capture-design-review.js" --input - <<'REQUEST'
   {"url": "<DEV_SERVER_URL>", "routes": ["/", "/about"]}
   REQUEST
   ```
2. Open every path in `summary.images` in one turn, and read the automated checks from the JSON.
3. Judge as design-critique.md describes and write the compact scorecard and fix list it defines.
4. Apply every fix from the scorecard, highest impact first, and commit. Capture again only at the start of the next round - one capture per round, after all of its fixes - rather than after each individual fix.

**The critique pass**: review every route, then fix and review again, capturing only the routes that changed plus `/`, until one of these holds:

- No critical gate fails and every category scores 3 or more - the pass is complete.
- Three rounds have run and no critical gate fails - the pass is complete, with each category still below 3 recorded in the scorecard with its reason, so the Phase 7 summary shows it to the user.
- Three rounds have run and a critical gate still fails - go to the gate below; a critical gate never passes silently. Keep the final scorecard for the Phase 7 summary, then remove each round's screenshots by sending `{"cleanup": "<outputDir>"}` to the same script the same way.

<!-- gate: create-site:5.7.critique-blocked | category=progress | cancel-leaves=nothing -->

> 🚦 **Gate (progress · create-site:5.7.critique-blocked):** A critical design gate still fails after three critique rounds.
>
> **Trigger:** Phase 5.7 round three ends with at least one critical gate from `design-critique.md` failing.
> **Why we ask:** A critical gate means a broken first screen, mobile layout, accessible flow, or honest-proof problem; moving on silently would carry it into the audit and the deployed site.
> **Cancel leaves:** Nothing - site files and commits stay on disk.

Use `AskUserQuestion`, naming each failing critical gate and its evidence in the question:

| Question | Header | Options |
|----------|--------|---------|
| *(failing gate and evidence)* - how should I proceed? | Design gate | Keep fixing (Recommended), Continue and record it as a known issue, Stop here |

- **Keep fixing**: run up to three more rounds on the failing gate, then return to this gate if it still fails.
- **Continue and record it as a known issue**: add it to the scorecard as a known issue and proceed to 5.7's completion; the Phase 7 summary lists it.
- **Stop here**: stop the skill; the project and its commits remain on disk.

> **GATE: Do NOT proceed to Phase 6 until ALL customization is complete and the 5.7 critique pass is complete.** All requested pages and features exist, the design tokens live in the theme file, the chosen Google Fonts pass the font check, no critical gate fails unless the user chose to continue past it, and the scorecard is recorded.

**Output**: All pages, components, and design elements implemented, critiqued, and verified

---

## Phase 6: Accessibility Verification

**Goal**: Verify the site meets WCAG 2.2 AA standards using axe-core automated testing and fix any violations

> **Prerequisite:** All pages and components must be fully implemented (Phase 5 complete). The dev server MUST be running.

**Actions**:

### 6.1 Prerequisites

The dev server must be running. Nothing needs installing: the audit uses the plugin's pinned Playwright with the system-installed browser (Edge or Chrome), and verifies the axe-core script against a pinned hash before running it.

### 6.2 Run axe-core Audit on Every Page

Run the audit script via `Bash`, sending the dev server URL and every site route as a JSON request on stdin, so neither is parsed by the shell:

```bash
node "${PLUGIN_ROOT}/scripts/axe-audit.js" --input - <<'REQUEST'
{"url": "<DEV_SERVER_URL>", "routes": ["/", "/about", "/services", "/contact"]}
REQUEST
```

Parse the returned JSON array of per-route results. Each result contains `violations` (with `id`, `impact`, `description`, `helpUrl`, and affected `nodes`), `passes` count, and `incomplete` count. A nonzero exit means at least one `critical` or `serious` violation was found, or a route could not be audited - its result has `error` instead of violations, so fix the cause (a broken route, or the dev server down) and audit it again.

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

```bash
git add -A
git commit -m "Fix accessibility: <violation description>"
```

### 6.4 Re-verify After Fixes

After all fixes are applied, re-run the audit script (same command as 6.2) to confirm violations are resolved:

1. If new violations appear (e.g., a fix introduced a regression), repeat 6.3–6.4
2. Continue until the script exits with code 0 (every route audited, zero `critical` and `serious` violations)
3. If a fix changed colors, spacing, or layout, run a review round on the affected routes and confirm the scorecard still holds. A review round can change source too, so when it does, re-run the audit on those routes; Phase 6 is done only when the last audit and the last review round both pass without a further fix

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

<!-- gate: create-site:7.review | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:7.review):** Live-site review — last chance to request changes before the deploy prompt. Cancel branch lets the user keep iterating. Fires at step 4 of the action list below.
>
> **Trigger:** Phase 7 has verified all pages render via Playwright.
> **Why we ask:** User loses the chance to spot UI issues before deploy; broken pages get pushed.
> **Cancel leaves:** Nothing — site files stay as-is on disk.

**Actions**:

1. Confirm every route still loads cleanly with one call - the capture request from 5.7 with every route and `"checksOnly": true` - and fix any route listed under `summary.pageErrors`, `summary.overflow`, or `summary.captureErrors`. The visual review already happened in Phase 5.7
2. Present a summary of what was built, with the design scorecard from Phase 5.7:

   ```
   | Component Type      | Count | Details |
   |---------------------|-------|---------|
   | Pages               | 4     | Home (/), About (/about), Services (/services), Contact (/contact) |
   | Shared Components   | 3     | Navbar, Footer, ContactForm |
   | Design Elements     | 5     | Schibsted Grotesk + Public Sans, 15 color tokens, product-moment hero, status-timeline signature moment, paper-grain backgrounds |
   | Git Commits         | 9     | scaffold + 8 feature and critique commits |
   ```

   Follow it with the design thesis in one sentence and the scorecard (category, score, one-line evidence), including any category recorded below 3 and why. Then list the sample content still in the site - search `src` for `SAMPLE CONTENT` markers and give each marker's file and what it stands in for - so the user can supply real content in this review.

3. Share the dev server URL with the user and list all available routes
4. Ask the user to review using `AskUserQuestion`:
   > "The site is ready for review at `<dev server URL>`. Please check it out in your browser. Would you like any changes?"
5. If the user requests changes, apply them, re-verify by browsing via `browser_snapshot`, and re-run the axe-core audit (6.2) on every affected route - a new control, form field, or restructured section can add violations without any visual change. When a change affects what the page looks like, also run a review round on the affected routes before moving on

**Output**: User-approved site ready for deployment

---

## Phase 8: Deployment & Next Steps

**Goal**: Deploy the site and suggest enhancements

> **This phase is MANDATORY. Do NOT end the session without asking about deployment.**

<!-- gate: create-site:8.deploy | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:8.deploy):** Deploy prompt — invokes `/deploy-site` on Yes. Skipping leaves the site files on disk for the user to deploy later. Fires at step 3 of the action list below.
>
> **Trigger:** Phase 8 entry; Phase 7 review approved.
> **Why we ask:** Auto-deploy picks whatever env PAC CLI happens to be pointing at — wrong-env first deploy is messy to undo.
> **Cancel leaves:** Nothing — site files stay on disk; no deploy fired.

**Actions**:

1. Record skill usage:

   > Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

   Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "CreateSite"`. Note: `.powerpages-site` may not exist for first-time sites — the script exits silently.

2. Search `src` for `SAMPLE CONTENT` markers again. If any remain, list each with its file before asking, say that they are invented placeholders to replace before a public launch, include the count in the question, and make **Skip for now** the recommended option.
3. Use `AskUserQuestion` with options: **Deploy now (Recommended)**, **Skip for now** - or **Deploy now**, **Skip for now (Recommended)** when sample content remains:
   > "Would you like to deploy your site to Power Pages now?" (when sample content remains: "Would you like to deploy your site to Power Pages now? It still contains <N> sample-content placeholders listed above.")
4. If the user chooses to deploy, invoke the `/deploy-site` skill.
5. Mark all todos complete
6. Present a final summary:
   - Site name and purpose
   - Framework and project location
   - Components created (X pages, Y components, Z design elements)
   - Key files and their purposes
   - Total file count and git commit count
   - Sample content to replace before launch - every `SAMPLE CONTENT` marker with its file, or "None"
7. Suggest optional enhancement skills:
   - `/setup-datamodel` — Create Dataverse tables for dynamic content
   - `/add-seo` — Add meta tags, robots.txt, sitemap.xml, favicon
   - `/add-tests` — Add unit tests (Vitest) and E2E tests (Playwright)
   - `/add-ai-webapi` — Add generative-AI summaries (Search Summary and Data Summarization). **Recommend first when `AI_SUMMARY_PLACEMENTS` from Phase 3 is non-empty** — the pages already carry `POWERPAGES:AI-SLOT` comment markers at the intended insertion points, so the follow-up skill's explore step finds them deterministically and the user gets the AI surface they picked during discovery without any page redesign.

**Output**: Deployed (or deployment-ready) site with clear next steps

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **Ask for user confirmation** at key decision points (see list below)
- **Use best judgement** for design details - make confident, creative choices from the experience brief without asking for every specific font, color, or layout decision
- **Apply design from the start** — never build neutral then restyle
- **Verify via Playwright** after every significant change
- **Commit after every page and component** — each gets its own dedicated commit, never batch multiple together
- **Capture screenshots with the review script** - visual review uses `capture-design-review.js` (one call for every route and width) rather than single-step Playwright MCP calls; the only `browser_take_screenshot` call is for Phase 3 brand extraction, with `filename` left unset so output goes to the launcher's temporary directory. Use `browser_snapshot` for everything else. Give the user the dev server URL for their own visual preview.

### Key Decision Points (Wait for User)

1. After Phase 1: Confirm site purpose, framework, and project location
2. After Phase 4: Approve implementation plan
3. During Phase 5.7: Resolve a critical design gate still failing after three critique rounds
4. After Phase 7: Accept site or request changes
5. At Phase 8: Deploy or skip

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Discover site requirements | Discovering requirements | Collect site name, framework, purpose, audience, and project location |
| Scaffold and launch dev server | Scaffolding project | Copy template, replace placeholders with defaults, git init, npm install, start dev server, share URL |
| Plan site components | Planning components | Determine pages, components, design direction, and routes while user previews scaffold |
| Approve implementation plan | Getting plan approval | Present implementation plan covering design and pages, get user approval |
| Implement pages and components | Building site | Apply design tokens, create all pages, components, routing, navigation, then run the design critique pass |
| Verify accessibility with axe-core | Verifying accessibility | Run axe-core on every page, fix all critical/serious violations, re-verify until passing |
| Review with user | Reviewing site | Navigate all pages, share URL, get user feedback, apply changes |
| Deploy and wrap up | Deploying site | Ask about deployment, present summary, suggest next steps |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`. This gives the user visibility into progress and keeps the workflow deterministic.

### Quality Standards

Every site must meet these standards before completion:

- Passes the Phase 5.7 design critique: no critical gate fails, and every rubric category scores 3 or more or, after three rounds, is recorded below 3 with its reason (see `design-critique.md`); a critical gate the user chose to continue past is recorded as a known issue
- Design tokens (color roles, fonts, spacing, radii, shadows, motion) defined once in the theme file and consumed everywhere
- Chosen Google Fonts verified loaded by the font check
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
- Brand: Fresh identity
- Experience brief: primary action "Find a consultant"; principal doubt "Is this directory current?"; proof is a visible "updated today" stamp from live data
- Design thesis: calm, precise, and quietly confident - warm paper surfaces, Schibsted Grotesk headlines over Public Sans, one deep-teal action color, a task-first welcome hero with live project counts
- Signature moment: the directory filters instantly with an animated reflow of consultant cards
- Component table with narrative beats per page presented and approved

### Phase 4: Plan Approval

- Plan data assembled as a single JSON object, including `DESIGN_DIRECTION_DATA`
- Rendered to `docs/create-site-plan.html` via `render-createsite-plan.js`
- Opened in the user's default browser
- Brief summary shown in terminal with a pointer to the browser tab
- User approved via AskUserQuestion

### Phase 5: Implementation

- Todos created for each page, component, routing, navigation, design foundations, and the critique pass
- Built in order: design tokens → layout → shared components → Home (hero first, then a first-impression review) → remaining pages → router → nav
- Design critique round 1 scored Narrative 2 (three identical card sections on Home) and Detail 2 (mixed icon stroke widths); both fixed, round 2 scored every category 3 or more
- Git commits after each major piece and each critique round

### Phase 6: Accessibility Verification

- axe-core injected and run on all 4 pages via `browser_evaluate`
- Found 5 violations: 2 missing alt text, 1 insufficient contrast, 1 missing lang attribute, 1 skipped heading level
- All violations fixed in source code and committed
- Re-run confirmed zero critical/serious violations across all pages

### Phase 7: Review

- Summary table and design scorecard presented
- User reviewed at `http://localhost:5173`, requested minor color adjustment
- Adjustment applied, re-verified

### Phase 8: Deploy

- User chose to deploy → invoked `/deploy-site`
- Final summary presented with next step suggestions

---

**Begin with Phase 1: Discovery**
