# SEO Reference

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

**Priority guidelines**: Homepage=1.0, Main sections=0.8, Secondary pages=0.7, Blog=0.6, Legal=0.3

**SPA note**: Use history mode routing (`/about`) not hash routing (`/#/about`) for proper indexing.

## Framework-Specific Paths

| Framework | index.html | public/ folder |
|-----------|------------|----------------|
| React (Vite) | Project root | `public/` |
| React (CRA) | `public/` | `public/` |
| Vue | Project root | `public/` |
| Angular | `src/` | `src/` (add to `angular.json` assets) |
| Astro | Layout component | `public/` |
