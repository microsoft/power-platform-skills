---
name: adding-seo
description: Adds SEO assets to Power Pages sites including meta tags, robots.txt, sitemap.xml, and favicon. Use when adding search engine optimization, social sharing images, or meta tags.
user-invocable: true
allowed-tools: ["Read", "Write", "Grep", "Glob", "Bash", "AskUserQuestion"]
model: haiku
---

**📋 [Shared Instructions](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Read before starting.

# Add SEO Assets

**References:** [seo](./references/seo-reference.md)

Adds search engine optimization assets to an existing Power Pages code site.

## Prerequisites

- Site created with `/create-site`
- `index.html` exists in project root

## Workflow

1. **Gather Info** → Ask site name, description, subdomain, primary color
2. **Update Meta Tags** → Add SEO and Open Graph meta tags to `index.html`
3. **Create robots.txt** → Search engine crawl directives
4. **Create sitemap.xml** → Site structure for search engines
5. **Add Favicon** → Placeholder favicon files (user replaces with actual assets)
6. **Build and Upload** → Deploy changes

---

## Step 1: Gather Info

Use `AskUserQuestion` to collect:
1. Site name (for title and og:site_name)
2. Site description (150-160 chars for meta description)
3. Expected subdomain (for canonical URLs)
4. Primary brand color (hex, for theme-color)

---

## Step 2: Update Meta Tags

See [seo-reference.md](./references/seo-reference.md#meta-tags-template).

Update `index.html` with:
- Primary meta tags (title, description, keywords, author, robots)
- Canonical URL
- Open Graph tags (og:title, og:description, og:image, etc.)
- Twitter card tags
- Favicon links
- Theme color

---

## Step 3: Create robots.txt

Create `public/robots.txt`:

```txt
User-agent: *
Allow: /
Sitemap: https://[subdomain].powerappsportals.com/sitemap.xml
```

---

## Step 4: Create sitemap.xml

Create `public/sitemap.xml` with entries for each page. See [seo-reference.md](./references/seo-reference.md#sitemapxml) for format.

Priority guidelines: Homepage=1.0, Main sections=0.8, Secondary=0.7, Blog=0.6, Legal=0.3

---

## Step 5: Add Favicon Placeholders

Create placeholder files in `public/`:
- `favicon.ico` (48x48)
- `favicon-32x32.png` (32x32)
- `favicon-16x16.png` (16x16)
- `apple-touch-icon.png` (180x180)
- `og-image.png` (1200x630) - social sharing image

Tell user to replace these with actual brand assets.

---

## Step 6: Build and Upload

```powershell
npm run build
pac pages upload-code-site --rootPath "<PROJECT_ROOT>"
```

Update memory-bank.md with SEO status.
