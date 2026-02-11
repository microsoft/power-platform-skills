---
name: creating-power-pages-site
description: This skill should be used when the user asks to "create a power pages site", "build a code site", "scaffold a website", "create a portal", "make a new site", or wants to create a new Power Pages code site (SPA) using React, Angular, Vue, or Astro.
user-invocable: true
allowed-tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "AskUserQuestion", "Task", "EnterPlanMode", "ExitPlanMode", "mcp__plugin_power-pages_playwright__browser_navigate", "mcp__plugin_power-pages_playwright__browser_snapshot", "mcp__plugin_power-pages_playwright__browser_take_screenshot", "mcp__plugin_power-pages_playwright__browser_click", "mcp__plugin_power-pages_playwright__browser_close"]
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/validate-site.js\""
          timeout: 15
        - type: prompt
          prompt: "If a Power Pages code site was being created in this session (via /power-pages:create-site), verify before allowing stop: 1) All user-requested features and pages were implemented — not just the scaffold, 2) The user reviewed the site via Playwright screenshots and approved it, 3) No build errors remain unresolved, 4) Git commits were made at key milestones (initial scaffold, after each major feature), 5) The user was asked about deploying via /power-pages:deploy-site. If any of these are incomplete, return 'block' with specific issues. If no site creation happened or everything is complete, return 'approve'."
          timeout: 30
---

# Create Power Pages Code Site

## Workflow

1. **Gather Requirements** → Site purpose, framework, features, design
2. **Choose Project Location** → Ask where to create the site
3. **Plan** → Enter plan mode, create implementation plan, get approval
4. **Scaffold & Launch** → Copy template, replace placeholders, install deps, start dev server
5. **Customize** → Add pages, components, styling — preview live via Playwright
6. **Review** → Final review with user via Playwright screenshot
7. **Deploy** → Suggest deploying to Power Pages via `/power-pages:deploy-site`

---

## Step 1: Gather Requirements

Use `AskUserQuestion` to collect (batch into 1-2 calls):

**Call 1:**

| Question | Header | Options |
|----------|--------|---------|
| Which frontend framework? | Framework | React (Recommended), Vue, Angular, Astro |
| What is the site's purpose? | Purpose | Company Portal, Blog/Content, Dashboard, Landing Page |
| Who is the target audience? | Audience | Internal (employees, partners), External (public-facing customers) |

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

| Framework | Build Tool | Router | Build Output |
|-----------|-----------|--------|--------------|
| React | Vite | react-router-dom | `dist` |
| Vue | Vite | vue-router | `dist` |
| Angular | Angular CLI | @angular/router | `dist/__SITE_NAME__/browser` |
| Astro | Astro | File-based + View Transitions | `dist` |

**Constraint**: Only static SPA frameworks. NOT supported: Next.js, Nuxt.js, Remix, SvelteKit, Liquid.

---

## Step 2: Choose Project Location

Before generating anything, ask where the site should be created using `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Where should the project be created? | Location | New folder in current directory (Recommended), Choose a different directory |

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

Start the dev server as early as possible so changes are visible in real-time:

```powershell
cd "<PROJECT_ROOT>"
npm install
npm run dev
```

Run `npm run dev` in the background using `Bash` with `run_in_background: true`. Note the local URL (typically `http://localhost:5173` for Vite or `http://localhost:4200` for Angular or `http://localhost:4321` for Astro).

### 4.6 Open in Playwright

Immediately after the dev server starts, open the site in Playwright to visually verify the scaffold:

1. Use `mcp__plugin_power-pages_playwright__browser_navigate` to open the dev server URL
2. Use `mcp__plugin_power-pages_playwright__browser_take_screenshot` to capture the initial state
3. Show the screenshot to the user as a progress checkpoint

---

## Step 5: Customize

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

### Live Preview During Customization

After each significant change (new page, component, or styling update):

1. Use `mcp__plugin_power-pages_playwright__browser_navigate` to reload or navigate to the updated page
2. Use `mcp__plugin_power-pages_playwright__browser_take_screenshot` to capture the current state
3. Verify the changes look correct before proceeding to the next change

This provides a tight feedback loop — write code, see result, iterate.

---

## Step 6: Review

Once all customization is complete:

1. Use Playwright to navigate through each page of the site
2. Take a screenshot of each page
3. Present the screenshots to the user
4. Ask the user to review using `AskUserQuestion`:
   > "Here's the completed site. Would you like any changes?"
5. If the user requests changes, apply them and take new screenshots
6. Close the Playwright browser with `mcp__plugin_power-pages_playwright__browser_close` when done

---

## Step 7: Deploy

Once the user is satisfied with the site, suggest deploying it to Power Pages:

> "Your site is ready! Would you like to deploy it to Power Pages now?"

Use `AskUserQuestion` with options: **Deploy now (Recommended)**, **Skip for now**.

If the user chooses to deploy, invoke the `/power-pages:deploy-site` skill to upload and activate the site on Power Pages.

Also suggest optional enhancement skills the user may want to run before or after deployment:
- `/power-pages:setup-dataverse` — Create Dataverse tables for dynamic content
- `/power-pages:add-seo` — Add meta tags, robots.txt, sitemap.xml, favicon
- `/power-pages:add-tests` — Add unit tests (Vitest) and E2E tests (Playwright)
