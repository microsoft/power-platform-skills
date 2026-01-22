# SEO Reference

This document describes how to add SEO assets to your Power Pages code site.

## Meta Tags Template

Ensure the `index.html` file includes comprehensive meta tags for SEO and social sharing:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <!-- Character encoding and viewport -->
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <!-- Primary Meta Tags -->
  <title>[SITE_NAME] - [Brief Description]</title>
  <meta name="title" content="[SITE_NAME] - [Brief Description]" />
  <meta name="description" content="[150-160 character description of the site's purpose and value proposition]" />
  <meta name="keywords" content="[keyword1], [keyword2], [keyword3], [relevant keywords]" />
  <meta name="author" content="[Company/Author Name]" />
  <meta name="robots" content="index, follow" />

  <!-- Canonical URL -->
  <link rel="canonical" href="https://[subdomain].powerappsportals.com/" />

  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://[subdomain].powerappsportals.com/" />
  <meta property="og:title" content="[SITE_NAME] - [Brief Description]" />
  <meta property="og:description" content="[Description for social sharing]" />
  <meta property="og:image" content="https://[subdomain].powerappsportals.com/og-image.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:site_name" content="[SITE_NAME]" />
  <meta property="og:locale" content="en_US" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:url" content="https://[subdomain].powerappsportals.com/" />
  <meta name="twitter:title" content="[SITE_NAME] - [Brief Description]" />
  <meta name="twitter:description" content="[Description for Twitter sharing]" />
  <meta name="twitter:image" content="https://[subdomain].powerappsportals.com/og-image.png" />

  <!-- Favicon -->
  <link rel="icon" type="image/x-icon" href="/favicon.ico" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />

  <!-- Theme Color (for mobile browsers) -->
  <meta name="theme-color" content="#[PRIMARY_COLOR_HEX]" />
  <meta name="msapplication-TileColor" content="#[PRIMARY_COLOR_HEX]" />

  <!-- Additional SEO -->
  <meta name="format-detection" content="telephone=no" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
</head>
```

## Framework-Specific Locations

| Framework | index.html Location |
|-----------|---------------------|
| React (Vite) | Project root `index.html` |
| React (CRA) | `public/index.html` |
| Vue | Project root `index.html` |
| Angular | `src/index.html` |
| Astro | `src/layouts/Layout.astro` or use `<head>` slot |

## Required SEO Assets

Place these assets in the `public/` folder:

| Asset | Size/Format | Purpose |
|-------|-------------|---------|
| `og-image.png` | 1200×630px | Social media sharing preview |
| `favicon.ico` | 48×48px | Browser tab icon |
| `favicon-32x32.png` | 32×32px | Modern browsers |
| `favicon-16x16.png` | 16×16px | Small displays |
| `apple-touch-icon.png` | 180×180px | iOS home screen |
| `robots.txt` | Text file | Search engine crawl directives |
| `sitemap.xml` | XML file | Site structure for search engines |

---

## robots.txt

Create `robots.txt` in the `public/` folder:

```txt
# robots.txt for [SITE_NAME]
# https://[subdomain].powerappsportals.com/robots.txt

User-agent: *
Allow: /

# Sitemap location
Sitemap: https://[subdomain].powerappsportals.com/sitemap.xml

# Disallow admin or private paths (if any)
# Disallow: /admin/
# Disallow: /private/
```

### robots.txt Directives

| Directive | Purpose |
|-----------|---------|
| `User-agent: *` | Applies rules to all search engine bots |
| `Allow: /` | Permits crawling of all pages |
| `Disallow: /path/` | Blocks crawling of specific paths |
| `Sitemap:` | Points crawlers to your sitemap |

### Framework-Specific Location (robots.txt)

| Framework | robots.txt Location |
|-----------|---------------------|
| React (Vite) | `public/robots.txt` |
| React (CRA) | `public/robots.txt` |
| Vue | `public/robots.txt` |
| Angular | `src/robots.txt` (add to `angular.json` assets) |
| Astro | `public/robots.txt` |

---

## sitemap.xml

Create `sitemap.xml` in the `public/` folder:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <!-- Homepage -->
  <url>
    <loc>https://[subdomain].powerappsportals.com/</loc>
    <lastmod>[YYYY-MM-DD]</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>

  <!-- About Page -->
  <url>
    <loc>https://[subdomain].powerappsportals.com/about</loc>
    <lastmod>[YYYY-MM-DD]</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>

  <!-- Contact Page -->
  <url>
    <loc>https://[subdomain].powerappsportals.com/contact</loc>
    <lastmod>[YYYY-MM-DD]</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>

  <!-- Services/Products Page -->
  <url>
    <loc>https://[subdomain].powerappsportals.com/services</loc>
    <lastmod>[YYYY-MM-DD]</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>

  <!-- Add all public pages in your SPA -->
</urlset>
```

### Sitemap Elements

| Element | Required | Description |
|---------|----------|-------------|
| `<loc>` | Yes | Full URL of the page (must be absolute URL) |
| `<lastmod>` | Recommended | Last modification date in YYYY-MM-DD format |
| `<changefreq>` | Optional | How often the page changes: `always`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`, `never` |
| `<priority>` | Optional | Priority relative to other pages: `0.0` to `1.0` (default: `0.5`) |

### Priority Guidelines

| Page Type | Recommended Priority |
|-----------|---------------------|
| Homepage | `1.0` |
| Main sections (About, Services, Products) | `0.8` |
| Secondary pages (Contact, FAQ) | `0.7` |
| Blog posts, articles | `0.6` |
| Legal pages (Privacy, Terms) | `0.3` |

### SPA Routing Considerations

For Single Page Applications with client-side routing:

1. **List all accessible routes** - Include every URL path that users can navigate to
2. **Use hash routing carefully** - If using hash routing (`/#/about`), search engines may not index these properly. Prefer history mode routing (`/about`)
3. **Ensure server redirects** - Configure your hosting to redirect all routes to `index.html` for proper SPA routing

### Framework-Specific Location (sitemap.xml)

| Framework | sitemap.xml Location |
|-----------|----------------------|
| React (Vite) | `public/sitemap.xml` |
| React (CRA) | `public/sitemap.xml` |
| Vue | `public/sitemap.xml` |
| Angular | `src/sitemap.xml` (add to `angular.json` assets) |
| Astro | `public/sitemap.xml` |

### Verify After Deployment

After the site is active, verify the sitemap is accessible:

```
https://[subdomain].powerappsportals.com/sitemap.xml
```

Update the sitemap whenever you add new pages to your site.
