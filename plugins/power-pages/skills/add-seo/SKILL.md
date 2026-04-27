---
name: add-seo
description: >-
  Adds SEO essentials to a Power Pages code site, including robots.txt, sitemap.xml,
  meta tags, Open Graph tags, and favicon configuration. Use when the user wants to
  improve search engine optimization or make their site more searchable.
user-invocable: true
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_snapshot, mcp__plugin_power-pages_playwright__browser_click, mcp__plugin_power-pages_playwright__browser_close
model: sonnet
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Add SEO

Add essential SEO assets to a Power Pages code site: `robots.txt`, `sitemap.xml`, and meta tags.

> **Prerequisite:** This skill expects an existing Power Pages code site created via `/create-site`. Run that skill first if the site does not exist yet.

## Core Principles

- **Crawlability first:** Every public page must be discoverable by search engines via a valid `robots.txt` and `sitemap.xml` before any other SEO work matters.
- **Accurate metadata:** Meta tags (title, description, Open Graph) must truthfully represent page content — misleading metadata harms rankings.
- **Framework-aware placement:** SEO assets must be placed in the correct location for the detected framework (public directory, layout component, etc.).

**Initial request:** $ARGUMENTS

## Workflow

1. **Phase 1: Verify Site Exists** → Locate the Power Pages project
2. **Phase 2: Gather SEO Configuration** → Site URL, pages, preferences
3. **Phase 3: Plan & Approve** → Present SEO additions inline, get user approval
4. **Phase 4: Add robots.txt** → Create robots.txt in public directory
5. **Phase 5: Add sitemap.xml** → Generate sitemap.xml from site routes
6. **Phase 6: Add Meta Tags** → Add title, description, viewport, Open Graph, and favicon to index.html
7. **Phase 7: Verify & Commit** → Verify via Playwright, commit changes

---

## Phase 1: Verify Site Exists

**Goal:** Confirm a Power Pages code site exists and understand its structure.

### Actions

#### 1.1 Locate Project

Look for `powerpages.config.json` in the current directory or immediate subdirectories to find the project root.

```powershell
# Check current directory and subdirectories
Get-ChildItem -Path . -Filter "powerpages.config.json" -Recurse -Depth 1
```

**If not found**: Tell the user to create a site first with `/create-site`.

#### 1.2 Read Existing Config

Read `powerpages.config.json` to get the site name and config:

```powershell
Get-Content "<PROJECT_ROOT>/powerpages.config.json" | ConvertFrom-Json
```

#### 1.3 Detect Framework & Discover Routes

Read `package.json` to determine the framework and locate key files. See `${CLAUDE_PLUGIN_ROOT}/references/framework-conventions.md` for the full framework → public directory → index HTML mapping and route discovery patterns.

Build a list of all routes (e.g., `/`, `/about`, `/contact`, `/blog`).

### Output

- Project root path identified
- Framework detected (React, Vue, Angular, or Astro)
- Full list of discoverable routes

---

## Phase 2: Gather SEO Configuration

**Goal:** Collect all SEO preferences from the user before making any changes.

### Actions

Use `AskUserQuestion` to collect SEO preferences:

#### Call 1

| Question | Header | Options |
|----------|--------|---------|
| What is the production URL for your site? (e.g., <https://contoso.powerappsportals.com>) | Site URL | *(free text — use single generic option so user types via "Other")* |
| Which pages should be excluded from search engine indexing? | Exclusions | None — index all pages (Recommended), Admin/auth pages only, Let me specify |

#### Call 2

| Question | Header | Options |
|----------|--------|---------|
| What meta description should appear in search results? | Description | *(free text — use single generic option so user types via "Other")* |
| Add Open Graph tags for social media sharing? | OG Tags | Yes — add Open Graph and Twitter Card tags (Recommended), No — skip social tags |

### Output

- Production URL confirmed
- Exclusion list finalized
- Meta description text
- Open Graph tag preference (yes/no)

---

## Phase 3: Plan & Approve

**Goal:** Present the full SEO plan to the user and get explicit approval before making changes.

### Actions

Present the SEO additions that will be made as a clear, inline summary:

1. **robots.txt content** — which paths will be allowed/disallowed
2. **sitemap.xml content** — all discovered routes with the production URL and priority assignments
3. **Meta tags to add to index.html** — title, description, viewport, charset, Open Graph, Twitter Card
4. **Favicon** — link tag and placeholder SVG

After presenting the plan, use `AskUserQuestion` to get approval:

| Question | Header | Options |
|----------|--------|---------|
| Here is the SEO plan. How would you like to proceed? | SEO Plan Approval | Approve and proceed (Recommended), I'd like to make changes |

If the user chooses "I'd like to make changes", ask what they want to change, update the plan accordingly, and present the revised plan for approval again.

### Output

- User-approved SEO plan ready for implementation

---

## Phase 4: Add robots.txt

**Goal:** Create a valid `robots.txt` that tells search engines which pages to crawl.

### Actions

Create `robots.txt` in the public directory (`<PROJECT_ROOT>/public/robots.txt`):

```text
User-agent: *
Allow: /

Sitemap: <PRODUCTION_URL>/sitemap.xml
```

If the user specified pages to exclude, add `Disallow` directives:

```text
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /auth/

Sitemap: <PRODUCTION_URL>/sitemap.xml
```

### Output

- `public/robots.txt` created with correct directives

---

## Phase 5: Add sitemap.xml

**Goal:** Generate a complete `sitemap.xml` listing all discoverable routes with proper priorities.

### Actions

Create `sitemap.xml` in the public directory (`<PROJECT_ROOT>/public/sitemap.xml`).

Generate entries for each discovered route using the production URL:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc><PRODUCTION_URL>/</loc>
    <lastmod><TODAY_DATE></lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc><PRODUCTION_URL>/about</loc>
    <lastmod><TODAY_DATE></lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <!-- Additional routes... -->
</urlset>
```

**Priority rules:**

- Home page (`/`): `1.0`
- Top-level pages: `0.8`
- Sub-pages: `0.6`

**Exclusions:** Do not include routes the user chose to exclude (e.g., `/admin/*`, `/auth/*`).

### Output

- `public/sitemap.xml` created with all routes, correct URLs, and no placeholders

---

## Phase 6: Add Meta Tags

**Goal:** Add comprehensive meta tags, Open Graph tags, and a favicon to the site's HTML.

### Actions

#### 6.1 Essential Meta Tags

Add or update meta tags in the site's `index.html` (location depends on framework — see Phase 1.3):

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title><SITE_TITLE></title>
  <meta name="description" content="<META_DESCRIPTION>" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="<PRODUCTION_URL>/" />
  <link rel="sitemap" type="application/xml" href="/sitemap.xml" />
</head>
```

#### 6.2 Open Graph Tags (if user opted in)

Add Open Graph and Twitter Card meta tags inside `<head>`:

```html
<!-- Open Graph -->
<meta property="og:type" content="website" />
<meta property="og:title" content="<SITE_TITLE>" />
<meta property="og:description" content="<META_DESCRIPTION>" />
<meta property="og:url" content="<PRODUCTION_URL>/" />
<meta property="og:site_name" content="<SITE_TITLE>" />

<!-- Twitter Card -->
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="<SITE_TITLE>" />
<meta name="twitter:description" content="<META_DESCRIPTION>" />
```

#### 6.3 Favicon

Check if a favicon already exists in the public directory. If not, add a simple SVG favicon link:

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
```

Create a minimal placeholder `public/favicon.svg` using the site's primary color:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="20" fill="<PRIMARY_COLOR>"/>
  <text x="50" y="70" font-size="50" text-anchor="middle" fill="white" font-family="system-ui, sans-serif" font-weight="bold"><FIRST_LETTER></text>
</svg>
```

Where `<FIRST_LETTER>` is the first letter of the site name and `<PRIMARY_COLOR>` is the primary theme color from the site's configuration.

#### 6.4 Astro-Specific Handling

For Astro sites, meta tags should be added to the base layout component (e.g., `src/layouts/Layout.astro`) rather than a root `index.html`. Astro uses component-based `<head>` management.

### Output

- Meta tags added to `index.html` (or Astro layout equivalent)
- Open Graph and Twitter Card tags added (if opted in)
- Favicon SVG created and linked (if not already present)

---

## Phase 7: Verify & Commit

**Goal:** Confirm all SEO assets are in place, verify via Playwright, and commit changes.

### Actions

#### 7.1 Verify Files Exist

Confirm the following files were created/updated:

- `public/robots.txt`
- `public/sitemap.xml`
- `public/favicon.svg` (if created)
- `index.html` or equivalent (meta tags added)

#### 7.2 Verify via Playwright

If a dev server is running (or start one):

1. Navigate to the site root and use `browser_snapshot` to verify meta tags are present in the page source
2. Navigate to `/robots.txt` and verify it loads
3. Navigate to `/sitemap.xml` and verify it loads

#### 7.3 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "AddSeo"`.

#### 7.4 Git Commit

> **CRITICAL — This step is MANDATORY. You MUST commit the SEO changes before finishing. Do NOT skip this step.**

Stage the specific SEO files and commit:

```powershell
git add public/robots.txt public/sitemap.xml public/favicon.svg index.html
git commit -m "Add SEO: robots.txt, sitemap.xml, meta tags, favicon"
```

Adjust the file paths based on what was actually created (e.g., include `src/layouts/Layout.astro` instead of `index.html` for Astro sites, omit `favicon.svg` if it was not created). Only stage files that were created or modified by this skill.

#### 7.5 Present Summary

Present a summary of what was added:

| Asset | Status | Details |
|-------|--------|---------|
| `robots.txt` | Created | Allows all crawlers, references sitemap |
| `sitemap.xml` | Created | X URLs mapped with priorities |
| Meta tags | Added | title, description, viewport, canonical, robots |
| Open Graph | Added/Skipped | og:title, og:description, og:url, Twitter Card |
| Favicon | Created/Skipped | SVG favicon with site initial |

#### 7.6 Suggest Next Steps

After the summary, suggest:

- **Deploy the site** to make SEO changes live: `/deploy-site`
- If data model is needed: `/setup-datamodel`
- For more advanced SEO: consider structured data (JSON-LD), performance optimization, and accessibility audit

### Output

- All files verified on disk
- Playwright verification passed
- Git commit created with all SEO changes

---

## Important Notes

### Progress Tracking

Use `TaskCreate` at the start to track each phase:

| Task | Description |
|------|-------------|
| Phase 1 | Verify site exists and detect framework |
| Phase 2 | Gather SEO configuration from user |
| Phase 3 | Present plan and get user approval |
| Phase 4 | Create robots.txt |
| Phase 5 | Generate sitemap.xml |
| Phase 6 | Add meta tags, Open Graph, and favicon |
| Phase 7 | Verify via Playwright and commit |

Update each task with `TaskUpdate` as it is completed.

### Key Decision Points

- **Phase 1:** If `powerpages.config.json` is not found, stop and redirect the user to `/create-site`.
- **Phase 2:** If the user specifies custom exclusions, confirm the exact paths before proceeding.
- **Phase 3:** Do not proceed to implementation until the user explicitly approves the plan.
- **Phase 6.4:** If the framework is Astro, meta tags go into the layout component, not `index.html`.
- **Phase 7.2:** If Playwright verification fails (e.g., robots.txt does not load), diagnose and fix before committing.

**Begin with Phase 1: Verify Site Exists**
