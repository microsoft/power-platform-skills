---
name: create-power-pages-site
description: This skill should be used when the user asks to "create a power pages site", "build a code site", "scaffold a website", "create a portal", "make a new site", or wants to create a new Power Pages code site (SPA) using React, Angular, Vue, or Astro.
user-invocable: true
allowed-tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "AskUserQuestion", "Task", "EnterPlanMode", "ExitPlanMode", "mcp__plugin_power-pages_playwright__browser_navigate", "mcp__plugin_power-pages_playwright__browser_snapshot", "mcp__plugin_power-pages_playwright__browser_click", "mcp__plugin_power-pages_playwright__browser_close"]
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/validate-site.js\""
          timeout: 15
        - type: prompt
          prompt: "If a Power Pages code site was being created in this session (via /power-pages:create-site), verify before allowing stop: 1) All user-requested features and pages were implemented — not just the scaffold, 2) The user was given the dev server URL and asked to review the site, 3) No build errors remain unresolved, 4) Git commits were made at key milestones (initial scaffold, after each major feature), 5) The user was asked about deploying via /power-pages:deploy-site. If any of these are incomplete, return { \"ok\": false, \"reason\": \"<specific issues>\" }. If no site creation happened or everything is complete, return { \"ok\": true }."
          timeout: 30
---

# Create Power Pages Code Site

## Workflow

> **CRITICAL: Steps MUST be executed in strict sequential order.** The dev server MUST be running and verified via Playwright BEFORE any customization begins (Step 5). Do NOT batch all code generation together — the workflow is designed so that each change in Step 5 gets a live preview. Skipping or reordering steps defeats the purpose of the live feedback loop.
>
> **Do NOT take screenshots.** Use `browser_snapshot` (accessibility snapshot) to verify pages yourself, and give the user the dev server URL so they can preview in their own browser.

1. **Gather Requirements** → Site purpose, framework, features, design
2. **Choose Project Location** → Ask where to create the site
3. **Plan** → Enter plan mode, create implementation plan, get approval
4. **Scaffold & Launch** → Copy template, replace placeholders, **git init, npm install, start dev server, verify via Playwright snapshot** — ALL before Step 5
5. **Customize** → Add pages, components, styling — **verify each change via Playwright snapshot** (dev server must already be running)
6. **Review & Deploy** → Share dev server URL with user for review, **then ask about deployment** (mandatory before ending session)

---

## Step 1: Gather Requirements

Use `AskUserQuestion` to collect (batch into 1-2 calls):

**Call 1:**

| Question | Header | Options |
|----------|--------|---------|
| What should the site be called? (e.g., "Contoso Portal", "HR Dashboard") | Site Name | *(free text — no predefined options)* |
| Which frontend framework? | Framework | React (Recommended), Vue, Angular, Astro |
| What is the site's purpose? | Purpose | Company Portal, Blog/Content, Dashboard, Landing Page |
| Who is the target audience? | Audience | Internal (employees, partners), External (public-facing customers) |

> **Note:** The site name question should use `AskUserQuestion` with only a single generic option so the user is prompted to type a custom name via the "Other" free-text input. From the user's answer, derive `__SITE_NAME__` (kebab-case, e.g., `contoso-portal`), `__SITE_TITLE__` (display title, e.g., `Contoso Portal`), and `__SITE_DESCRIPTION__` (one-line description based on name + purpose).

**Call 2:**

| Question | Header | Options |
|----------|--------|---------|
| What color theme? | Theme | Blue Professional (#0078d4), Green Nature (#10b981), Purple Creative (#7c3aed), Dark Modern (#1e293b) |
| Which features? (multi-select) | Features | Contact Form, Authentication, Data Tables, Search |

**Audience influences site generation:**
- **Internal**: Prioritize data tables, dashboards, authentication, navigation depth, functional over flashy design
- **External**: Prioritize landing page appeal, SEO-friendly structure, contact forms, clean marketing-oriented layout

**After gathering answers, record these values for placeholder replacement:**

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `__SITE_NAME__` | kebab-case project name | `contoso-portal` |
| `__SITE_TITLE__` | Display title | `Contoso Portal` |
| `__SITE_DESCRIPTION__` | One-line description | `Modern portal for Contoso employees` |
| `__PRIMARY_COLOR__` | Primary hex color | `#0078d4` |
| `__SECONDARY_COLOR__` | Complementary hex color | `#106ebe` |
| `__BG_COLOR__` | Background color (default `#ffffff`) | `#ffffff` |
| `__SURFACE_COLOR__` | Surface/card color (default `#f8fafc`) | `#f8fafc` |
| `__TEXT_COLOR__` | Main text color (default `#1e293b`) | `#1e293b` |
| `__TEXT_MUTED__` | Muted text color (default `#64748b`) | `#64748b` |

### Framework Reference

See `${CLAUDE_PLUGIN_ROOT}/references/framework-conventions.md` for the full framework → build tool → router → output path mapping.

**Constraint**: Only static SPA frameworks. NOT supported: Next.js, Nuxt.js, Remix, SvelteKit, Liquid.

---

## Step 2: Choose Project Location

Before generating anything, ask where the site should be created using `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Where should the project be created? | Location | Current Directory,New folder in current directory (Recommended), Choose a different directory |

**If "New folder in current directory"**: Create a new folder named `__SITE_NAME__` inside the current working directory. The project root becomes `<cwd>/__SITE_NAME__/`.

**If "Choose a different directory"**: Ask the user to provide the full path. Verify the directory exists (or create it). The project root becomes the path they provide.

After resolving the location, confirm with the user:
> "The site will be created at `<resolved path>`. Proceeding."

Store this as `PROJECT_ROOT` for all subsequent steps.

---

## Step 3: Plan

1. Enter plan mode with `EnterPlanMode`
2. Create an implementation plan covering:
   - Pages to create (based on purpose + features)
   - Components needed
   - Routing structure
   - Styling approach
3. Present plan to user
4. Use `ExitPlanMode` only after user approves

---

## Step 4: Scaffold & Launch Dev Server

### 4.1 Copy Template

Read and copy all files from the matching asset template to the project directory:

| Framework | Asset Directory |
|-----------|----------------|
| React | `${CLAUDE_PLUGIN_ROOT}/skills/create-site/assets/react/` |
| Vue | `${CLAUDE_PLUGIN_ROOT}/skills/create-site/assets/vue/` |
| Angular | `${CLAUDE_PLUGIN_ROOT}/skills/create-site/assets/angular/` |
| Astro | `${CLAUDE_PLUGIN_ROOT}/skills/create-site/assets/astro/` |

Use `Glob` to discover all files in the asset directory, `Read` each file, then `Write` to the project directory preserving the relative path structure.

### 4.2 Replace Placeholders

After copying, replace all `__PLACEHOLDER__` tokens in every file with the actual values gathered in Step 1. Use `Edit` with `replace_all: true` on each file.

### 4.3 Rename gitignore

Rename `gitignore` → `.gitignore` in the project root (stored without dot prefix to avoid git interference in the plugin repo).

### 4.4 Initialize Git Repository

Initialize a git repo and make the first commit immediately after scaffolding:

```powershell
cd "<PROJECT_ROOT>"
git init
git add -A
git commit -m "Initial scaffold: __SITE_NAME__ (__FRAMEWORK__)"
```

This establishes a baseline. From this point, **commit after every significant milestone** so any breaking change can be reverted. See the commit checkpoint rules below.

### 4.5 Install & Start Dev Server

**This MUST happen now — before any customization code is written.** The dev server enables the live preview feedback loop that makes Step 5 work:

```powershell
cd "<PROJECT_ROOT>"
npm install
npm run dev
```

Run `npm run dev` in the background using `Bash` with `run_in_background: true`. Note the local URL (typically `http://localhost:5173` for Vite or `http://localhost:4200` for Angular or `http://localhost:4321` for Astro).

### 4.6 Verify in Playwright & Share URL

Immediately after the dev server starts, verify the scaffold is working:

1. Use `mcp__plugin_power-pages_playwright__browser_navigate` to open the dev server URL
2. Use `mcp__plugin_power-pages_playwright__browser_snapshot` to take an accessibility snapshot and verify the page loaded correctly
3. **Share the dev server URL with the user** so they can preview the site in their own browser (e.g., "Your site is running at `http://localhost:5173` — open it in your browser to follow along as I build.")

**Do NOT use `browser_take_screenshot`.** Use `browser_snapshot` for your own verification; the user will review visually in their own browser.

> **GATE: Do NOT proceed to Step 5 until ALL of the following are true:**
> 1. Git repo initialized with initial scaffold commit
> 2. `npm install` completed successfully
> 3. Dev server is running in the background (`npm run dev`)
> 4. Playwright has opened the site and verified it loads via `browser_snapshot`
> 5. The dev server URL has been shared with the user
>
> If any of these are not done, complete them now before moving on.

---

## Step 5: Customize

> **Prerequisite:** The dev server MUST already be running and verified via Playwright before starting this step. If it is not, go back and complete Step 4 first. After each significant change, use `browser_snapshot` to verify the page — do NOT take screenshots.

Based on the user's requirements from Step 1, extend the scaffolded project:

1. **Add pages** — Create route components for each requested page (e.g., Contact, Dashboard, Blog)
2. **Add components** — Build reusable components for requested features (e.g., ContactForm, DataTable, SearchBar)
3. **Update router** — Register all new routes
4. **Update navigation** — Add links to the Layout/Header component
5. **Apply styling** — Add page-specific styles consistent with the theme variables

Invoke the `frontend-design` skill if the user wants high-fidelity, polished UI design. Otherwise, build clean functional pages using the theme system from the template.

**Important**: Build real, functional UI — not placeholder "coming soon" pages.

### Git Commit Checkpoints

Commit after each significant piece of work so breaking changes can be reverted. Follow this pattern:

```powershell
git add -A
git commit -m "<short description of what was added/changed>"
```

**When to commit:**
- After adding each new page or major component
- After updating routing and navigation
- After completing styling for a section
- Before attempting anything risky or experimental

**If something breaks**, revert to the last good commit:

```powershell
git revert HEAD
```

### Live Verification During Customization

After each significant change (new page, component, or styling update):

1. Use `mcp__plugin_power-pages_playwright__browser_navigate` to reload or navigate to the updated page
2. Use `mcp__plugin_power-pages_playwright__browser_snapshot` to verify the page structure and content are correct
3. If something looks wrong in the snapshot, fix it before proceeding

**Do NOT use `browser_take_screenshot`.** The user is previewing in their own browser via the dev server URL shared in Step 4.6.

---

## Step 6: Review & Deploy

> **This step includes both review AND the deployment prompt. Do NOT end the session without asking about deployment.**

Once all customization is complete:

1. Use Playwright to navigate through each page and run `browser_snapshot` to verify all pages load correctly
2. Share the dev server URL with the user and list all available routes
3. Ask the user to review using `AskUserQuestion`:
   > "The site is ready for review at `<dev server URL>`. Please check it out in your browser. Would you like any changes?"
4. If the user requests changes, apply them and re-verify with `browser_snapshot`
5. Close the Playwright browser with `mcp__plugin_power-pages_playwright__browser_close` when done

### Deploy (mandatory prompt)

**You MUST ask the user about deployment before ending the session.** Do not skip this.

Use `AskUserQuestion` with options: **Deploy now (Recommended)**, **Skip for now**:
> "Would you like to deploy your site to Power Pages now?"

If the user chooses to deploy, invoke the `/power-pages:deploy-site` skill.

Also suggest optional enhancement skills:
- `/power-pages:setup-datamodel` — Create Dataverse tables for dynamic content
- `/power-pages:add-seo` — Add meta tags, robots.txt, sitemap.xml, favicon
- `/power-pages:add-tests` — Add unit tests (Vitest) and E2E tests (Playwright)
