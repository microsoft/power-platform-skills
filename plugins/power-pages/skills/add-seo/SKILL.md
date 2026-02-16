---
name: add-seo
description: >
  This skill should be used when the user asks to "add SEO", "add meta tags",
  "add robots.txt", "add sitemap", "improve SEO", "search engine optimization",
  "add open graph tags", "add favicon", "make site searchable",
  or wants to add SEO essentials (robots.txt, sitemap.xml, meta tags) to their
  Power Pages code site after creating it with /power-pages:create-site.
user-invocable: true
allowed-tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "AskUserQuestion", "Task", "EnterPlanMode", "ExitPlanMode", "mcp__plugin_power-pages_playwright__browser_navigate", "mcp__plugin_power-pages_playwright__browser_snapshot", "mcp__plugin_power-pages_playwright__browser_click", "mcp__plugin_power-pages_playwright__browser_close"]
model: opus
hooks:
  Stop:
    - hooks:
        - type: command
          command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/validate-seo.js\""
          timeout: 15
        - type: prompt
          prompt: "If SEO assets were being added in this session (via /power-pages:add-seo), verify before allowing stop: 1) robots.txt was created in the public directory, 2) sitemap.xml was created in the public directory with correct site URLs, 3) Meta tags (title, description, viewport, Open Graph) were added to index.html, 4) The user reviewed and approved the SEO additions, 5) A git commit was made with the SEO changes. If any of these are incomplete, return { \"ok\": false, \"reason\": \"<specific issues>\" }. If no SEO work happened or everything is complete, return { \"ok\": true }."
          timeout: 30
---

# Add SEO

Add essential SEO assets to a Power Pages code site: `robots.txt`, `sitemap.xml`, and meta tags.

> **Prerequisite:** This skill expects an existing Power Pages code site created via `/power-pages:create-site`. Run that skill first if the site does not exist yet.

## Workflow

1. **Verify Site Exists** → Locate the Power Pages project
2. **Gather SEO Configuration** → Site URL, pages, preferences
3. **Plan** → Enter plan mode, present SEO additions, get approval
4. **Add robots.txt** → Create robots.txt in public directory
5. **Add sitemap.xml** → Generate sitemap.xml from site routes
6. **Add Meta Tags** → Add title, description, viewport, Open Graph, and favicon to index.html
7. **Verify & Commit** → Verify via Playwright, commit changes

---

## Step 1: Verify Site Exists

### 1.1 Locate Project

Look for `powerpages.config.json` in the current directory or immediate subdirectories to find the project root.

```powershell
# Check current directory and subdirectories
Get-ChildItem -Path . -Filter "powerpages.config.json" -Recurse -Depth 1
```

**If not found**: Tell the user to create a site first with `/power-pages:create-site`.

### 1.2 Read Existing Config

Read `powerpages.config.json` to get the site name and config:

```powershell
Get-Content "<PROJECT_ROOT>/powerpages.config.json" | ConvertFrom-Json
```

### 1.3 Detect Framework & Discover Routes

Read `package.json` to determine the framework and locate key files. See `${CLAUDE_PLUGIN_ROOT}/references/framework-conventions.md` for the full framework → public directory → index HTML mapping and route discovery patterns.

Build a list of all routes (e.g., `/`, `/about`, `/contact`, `/blog`).

---

## Step 2: Gather SEO Configuration

Use `AskUserQuestion` to collect SEO preferences:

### Call 1:

| Question | Header | Options |
|----------|--------|---------|
| What is the production URL for your site? (e.g., https://contoso.powerappsportals.com) | Site URL | *(free text — use single generic option so user types via "Other")* |
| Which pages should be excluded from search engine indexing? | Exclusions | None — index all pages (Recommended), Admin/auth pages only, Let me specify |

### Call 2:

| Question | Header | Options |
|----------|--------|---------|
| What meta description should appear in search results? | Description | *(free text — use single generic option so user types via "Other")* |
| Add Open Graph tags for social media sharing? | OG Tags | Yes — add Open Graph and Twitter Card tags (Recommended), No — skip social tags |

---

## Step 3: Plan

1. Enter plan mode with `EnterPlanMode`
2. Present the SEO additions that will be made:
   - `robots.txt` content (which paths allowed/disallowed)
   - `sitemap.xml` content (all discovered routes with the production URL)
   - Meta tags to add to `index.html` (title, description, viewport, charset, Open Graph, Twitter Card)
   - Favicon link tag
3. Use `ExitPlanMode` to get user approval

---

## Step 4: Add robots.txt

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

---

## Step 5: Add sitemap.xml

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

---

## Step 6: Add Meta Tags

### 6.1 Essential Meta Tags

Add or update meta tags in the site's `index.html` (location depends on framework — see Step 1.3):

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

### 6.2 Open Graph Tags (if user opted in)

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

### 6.3 Favicon

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

### 6.4 Astro-Specific Handling

For Astro sites, meta tags should be added to the base layout component (e.g., `src/layouts/Layout.astro`) rather than a root `index.html`. Astro uses component-based `<head>` management.

---

## Step 7: Verify & Commit

### 7.1 Verify Files Exist

Confirm the following files were created/updated:
- `public/robots.txt`
- `public/sitemap.xml`
- `public/favicon.svg` (if created)
- `index.html` or equivalent (meta tags added)

### 7.2 Verify via Playwright

If a dev server is running (or start one):

1. Navigate to the site root and use `browser_snapshot` to verify meta tags are present in the page source
2. Navigate to `/robots.txt` and verify it loads
3. Navigate to `/sitemap.xml` and verify it loads

### 7.3 Git Commit

Stage and commit all SEO changes:

```powershell
git add -A
git commit -m "Add SEO: robots.txt, sitemap.xml, meta tags, favicon"
```

### 7.4 Present Summary

Present a summary of what was added:

| Asset | Status | Details |
|-------|--------|---------|
| `robots.txt` | Created | Allows all crawlers, references sitemap |
| `sitemap.xml` | Created | X URLs mapped with priorities |
| Meta tags | Added | title, description, viewport, canonical, robots |
| Open Graph | Added/Skipped | og:title, og:description, og:url, Twitter Card |
| Favicon | Created/Skipped | SVG favicon with site initial |

### 7.5 Suggest Next Steps

After the summary, suggest:
- **Deploy the site** to make SEO changes live: `/power-pages:deploy-site`
- If data model is needed: `/power-pages:setup-datamodel`
- For more advanced SEO: consider structured data (JSON-LD), performance optimization, and accessibility audit
