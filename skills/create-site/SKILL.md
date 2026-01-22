---
description: Create a Power Pages code site (SPA) using modern frontend frameworks like React, Angular, Vue, or Astro. Guides through design, build, upload, and activation.
user-invocable: true
allowed-tools: Bash(pac:*), Bash(az:*)
model: opus
---

# Create Power Pages Code Site

This skill guides makers through creating a complete Power Pages code site (Single Page Application) from scratch, deploying it to Power Pages, and activating it for public access.

## Memory Bank

This skill uses a **memory bank** (`memory-bank.md`) to persist context across sessions.

**Follow the instructions in `${CLAUDE_PLUGIN_ROOT}/shared/memory-bank.md`** for:
- Checking and reading the memory bank before starting
- Skipping completed steps and resuming progress
- Updating the memory bank after each major step

## Workflow Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: Gather Requirements                                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Frontend framework selection (React, Angular, Vue, Astro)                │
│  • Site features and functionality                                          │
│  • Design preferences and style                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: Create the Site                                                    │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Use frontend-design skill to build production-grade UI                   │
│  • Generate complete SPA with chosen framework                              │
│  • Add SEO assets (meta tags, robots.txt, sitemap.xml, favicon)             │
│  • Write unit tests for components and utilities                            │
│  • Write end-to-end tests with Playwright                                   │
│  • Build the project for production                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: Check Prerequisites                                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Verify PAC CLI is installed (install if missing)                         │
│  • Verify Azure CLI is installed (install if missing)                       │
│  • Ensure authentication is configured                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: Upload to Power Pages (Inactive)                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Use PAC CLI: pac pages upload-code-site                                  │
│  • Site uploaded in INACTIVE mode                                           │
│  • Get websiteRecordId for activation                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 5: Preview Locally                                                    │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Run the app locally to verify it works                                   │
│  • Test all features before activation                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 6: Activate Website                                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  • Ask user for subdomain preference                                        │
│  • Call Power Platform CreateWebsite API via az rest                        │
│  • Monitor operation status until complete                                  │
│  • Fallback: Manual activation via Power Pages portal                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## STEP 1: Gather Requirements

**IMPORTANT**: Before creating anything, you MUST ask the maker the following questions using the AskUserQuestion tool.

### Question 1: What do you want to build?

If the user has not already specified what they want to build, ask them to describe their site:

- What is the purpose of the site? (e.g., company portal, customer self-service, employee directory, event registration)
- What key functionality do they need?
- Who is the target audience?

This helps inform framework selection and feature recommendations.

### Question 2: Frontend Framework

Based on what they want to build, ask the maker which frontend framework they want to use:

| Option | Description |
|--------|-------------|
| **React (Recommended)** | Most popular choice with excellent ecosystem. Best for complex interactive UIs. |
| **Angular** | Full-featured framework by Google. Great for enterprise applications with built-in state management. |
| **Vue** | Progressive framework, easy to learn. Good balance of simplicity and power. |
| **Astro** | Modern static site generator with partial hydration. Best for content-focused sites with minimal JS. |

> **⚠️ IMPORTANT: Unsupported Technologies**
>
> Power Pages code sites are **static SPAs** served from Azure CDN. The following technologies are **NOT supported**:
>
> - **Next.js** - Requires Node.js server runtime (SSR/ISR not available)
> - **Nuxt.js** - Requires Node.js server runtime
> - **Remix** - Requires server-side rendering
> - **SvelteKit** - Server features not supported
> - **Liquid templates** - Power Pages code sites don't use Liquid (only classic Power Pages sites do)
> - **Server-side APIs** - No Node.js/Express backend; use Dataverse Web API instead
> - **Server components** - React Server Components not supported
>
> **Only use frameworks that can build to static HTML/CSS/JS files.**

### Question 3: Site Features

Ask what features the maker wants in their site. Common options:

- Landing page / Hero section
- Navigation menu
- Contact form
- About page
- Services/Products showcase
- Image gallery
- Blog/News section
- User authentication (Microsoft Entra ID)
- Data display from Dataverse (Web API)

### Question 4: Design Preferences

Ask about design preferences:

- **Style**: Modern/Minimalist, Corporate/Professional, Creative/Bold, Elegant/Luxury
- **Color scheme**: Let them specify or suggest based on their brand
- **Special requirements**: Accessibility, mobile-first, specific branding guidelines

---

## STEP 2: Create the Site

After gathering requirements, use the **frontend-design skill** to create the site.

### Instructions for Site Creation

1. **Invoke the frontend-design skill** with the gathered requirements
2. The skill will create a production-grade, distinctive UI
3. Ensure the project structure follows Power Pages code site requirements

> **⚠️ CRITICAL**: When invoking the frontend-design skill, explicitly specify:
> - Use **Vite** as the build tool for React/Vue projects
> - Use **Create React App** only if Vite is not preferred
> - **DO NOT use Next.js, Nuxt.js, Remix, or any SSR framework**
> - **DO NOT use Liquid templates** - they are not supported in code sites
> - The output must be **purely static files** (HTML, CSS, JS) that can be served from a CDN

### Required Project Structure

```text
/site-project
├── src/                      # Source code
├── public/                   # Static assets
├── build/ or dist/           # Compiled output (after build)
├── package.json              # Dependencies
├── powerpages.config.json    # Power Pages configuration (create this)
└── README.md
```

### Create powerpages.config.json

After the site is created, add this configuration file:

```json
{
  "siteName": "<SITE_NAME>",
  "defaultLandingPage": "index.html",
  "compiledPath": "./build"
}
```

For Vue/Astro projects, change `compiledPath` to `"./dist"`.

### Add SEO Meta Tags

**IMPORTANT**: Ensure the `index.html` file includes comprehensive meta tags for SEO and social sharing. Update the `<head>` section with the following:

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

#### SEO Checklist

Ensure the following assets are created and placed in the `public/` folder:

| Asset | Size/Format | Purpose |
|-------|-------------|---------|
| `og-image.png` | 1200×630px | Social media sharing preview |
| `favicon.ico` | 48×48px | Browser tab icon |
| `favicon-32x32.png` | 32×32px | Modern browsers |
| `favicon-16x16.png` | 16×16px | Small displays |
| `apple-touch-icon.png` | 180×180px | iOS home screen |
| `robots.txt` | Text file | Search engine crawl directives |
| `sitemap.xml` | XML file | Site structure for search engines |

#### Framework-Specific Notes

**React (Vite)**: Edit `index.html` in the project root.

**React (CRA)**: Edit `public/index.html`.

**Vue**: Edit `index.html` in the project root.

**Angular**: Edit `src/index.html` and update `angular.json` for favicon assets.

**Astro**: Add meta tags in `src/layouts/Layout.astro` or use `<head>` slot.

> **Note**: Replace all placeholder values (`[SITE_NAME]`, `[subdomain]`, etc.) with actual values based on user requirements gathered in Step 1.

### Add robots.txt

Create a `robots.txt` file in the `public/` folder to control search engine crawling:

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

#### robots.txt Best Practices

| Directive | Purpose |
|-----------|---------|
| `User-agent: *` | Applies rules to all search engine bots |
| `Allow: /` | Permits crawling of all pages |
| `Disallow: /path/` | Blocks crawling of specific paths |
| `Sitemap:` | Points crawlers to your sitemap |

#### Framework-Specific Location (robots.txt)

| Framework | robots.txt Location |
|-----------|---------------------|
| React (Vite) | `public/robots.txt` |
| React (CRA) | `public/robots.txt` |
| Vue | `public/robots.txt` |
| Angular | `src/robots.txt` (add to `angular.json` assets) |
| Astro | `public/robots.txt` |

### Add sitemap.xml

**IMPORTANT**: Create a `sitemap.xml` file to help search engines discover and crawl all pages on your site. This is essential for SEO.

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

#### Sitemap Elements Reference

| Element | Required | Description |
|---------|----------|-------------|
| `<loc>` | Yes | Full URL of the page (must be absolute URL) |
| `<lastmod>` | Recommended | Last modification date in YYYY-MM-DD format |
| `<changefreq>` | Optional | How often the page changes: `always`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`, `never` |
| `<priority>` | Optional | Priority relative to other pages: `0.0` to `1.0` (default: `0.5`) |

#### Priority Guidelines

| Page Type | Recommended Priority |
|-----------|---------------------|
| Homepage | `1.0` |
| Main sections (About, Services, Products) | `0.8` |
| Secondary pages (Contact, FAQ) | `0.7` |
| Blog posts, articles | `0.6` |
| Legal pages (Privacy, Terms) | `0.3` |

#### SPA Routing Considerations

For Single Page Applications with client-side routing:

1. **List all accessible routes** - Include every URL path that users can navigate to
2. **Use hash routing carefully** - If using hash routing (`/#/about`), search engines may not index these properly. Prefer history mode routing (`/about`)
3. **Ensure server redirects** - Configure your hosting to redirect all routes to `index.html` for proper SPA routing

#### Framework-Specific Location (sitemap.xml)

| Framework | sitemap.xml Location |
|-----------|----------------------|
| React (Vite) | `public/sitemap.xml` |
| React (CRA) | `public/sitemap.xml` |
| Vue | `public/sitemap.xml` |
| Angular | `src/sitemap.xml` (add to `angular.json` assets) |
| Astro | `public/sitemap.xml` |

#### Verify Sitemap After Deployment

After the site is active, verify the sitemap is accessible:

```
https://[subdomain].powerappsportals.com/sitemap.xml
```

> **Note**: Update the sitemap whenever you add new pages to your site. Replace `[subdomain]` with your actual subdomain and `[YYYY-MM-DD]` with the current date.

### Write Unit Tests

**IMPORTANT**: Before building for production, write unit tests for the generated site to ensure code quality and prevent regressions.

#### Set Up Testing Framework

Install the appropriate testing dependencies based on the chosen framework:

```powershell
# React (Vite) - Vitest + React Testing Library
npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom

# React (Create React App) - Already includes Jest + RTL
# No additional installation needed

# Angular - Already includes Jasmine + Karma
# No additional installation needed

# Vue (Vite) - Vitest + Vue Test Utils
npm install -D vitest @vue/test-utils @testing-library/vue jsdom

# Astro - Vitest
npm install -D vitest
```

#### Configure Testing (Vite Projects)

For Vite-based projects, add test configuration to `vite.config.ts`:

```typescript
/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react' // or vue()

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
})
```

Create `src/test/setup.ts`:

```typescript
import '@testing-library/jest-dom'
```

Add test scripts to `package.json`:

```json
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage"
  }
}
```

#### What to Test

Write tests for the following:

1. **Components** - Test rendering, user interactions, and props
2. **Utility functions** - Test data transformations, validators, formatters
3. **Custom hooks** (React/Vue) - Test state management and side effects
4. **Form validation** - Test validation rules and error messages
5. **API service functions** - Test Dataverse Web API wrapper functions (mock the API)

#### Example Test Structure

```text
/src
├── components/
│   ├── Header.tsx
│   └── Header.test.tsx       # Component test
├── utils/
│   ├── formatters.ts
│   └── formatters.test.ts    # Utility test
├── hooks/
│   ├── useDataverse.ts
│   └── useDataverse.test.ts  # Hook test
└── test/
    └── setup.ts              # Test setup file
```

#### Example Component Test (React)

```typescript
// src/components/Header.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Header } from './Header'

describe('Header', () => {
  it('renders the site title', () => {
    render(<Header title="My Site" />)
    expect(screen.getByRole('banner')).toHaveTextContent('My Site')
  })

  it('toggles mobile menu on button click', async () => {
    const user = userEvent.setup()
    render(<Header title="My Site" />)

    const menuButton = screen.getByRole('button', { name: /menu/i })
    await user.click(menuButton)

    expect(screen.getByRole('navigation')).toBeVisible()
  })
})
```

#### Example Utility Test

```typescript
// src/utils/formatters.test.ts
import { formatDate, formatCurrency } from './formatters'

describe('formatDate', () => {
  it('formats ISO date to readable string', () => {
    expect(formatDate('2024-01-15')).toBe('January 15, 2024')
  })

  it('returns empty string for invalid date', () => {
    expect(formatDate('invalid')).toBe('')
  })
})

describe('formatCurrency', () => {
  it('formats number as USD currency', () => {
    expect(formatCurrency(1234.56)).toBe('$1,234.56')
  })
})
```

#### Run Tests

Execute tests before building:

```powershell
# Run all tests
npm test

# Run tests once (CI mode)
npm run test:run

# Run with coverage report
npm run test:coverage
```

**All unit tests must pass before proceeding to E2E tests.**

### Write End-to-End Tests (Playwright)

**IMPORTANT**: After unit tests pass, write end-to-end tests using Playwright to verify the complete user experience.

#### Install Playwright

```powershell
# Install Playwright
npm install -D @playwright/test

# Install browsers (Chromium, Firefox, WebKit)
npx playwright install
```

#### Configure Playwright

Create `playwright.config.ts` in the project root:

```typescript
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173', // Vite default, change for CRA (3000) or Angular (4200)
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
})
```

> **Note**: Adjust `baseURL` and `webServer.url` based on your framework:
> - **Vite (React/Vue)**: `http://localhost:5173`
> - **Create React App**: `http://localhost:3000`
> - **Angular**: `http://localhost:4200`
> - **Astro**: `http://localhost:4321`

Add E2E test scripts to `package.json`:

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:headed": "playwright test --headed",
    "test:e2e:report": "playwright show-report"
  }
}
```

#### E2E Test Structure

```text
/e2e
├── home.spec.ts              # Home page tests
├── navigation.spec.ts        # Navigation tests
├── contact-form.spec.ts      # Form submission tests
├── responsive.spec.ts        # Mobile responsiveness tests
└── fixtures/
    └── test-data.ts          # Shared test data
```

#### What to Test with E2E

Write E2E tests for critical user journeys:

1. **Page Navigation** - All links work and routes load correctly
2. **Form Submissions** - Contact forms, search, filters work end-to-end
3. **Responsive Design** - Site works on mobile, tablet, and desktop
4. **Interactive Elements** - Modals, dropdowns, accordions function properly
5. **Accessibility** - Basic a11y checks (keyboard navigation, focus states)
6. **Error States** - Error pages and validation messages display correctly

#### Example E2E Tests

**Home Page Test:**

```typescript
// e2e/home.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Home Page', () => {
  test('should display hero section with correct content', async ({ page }) => {
    await page.goto('/')

    // Check hero section
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('banner')).toBeVisible()

    // Check CTA button
    const ctaButton = page.getByRole('link', { name: /get started/i })
    await expect(ctaButton).toBeVisible()
  })

  test('should have valid meta tags', async ({ page }) => {
    await page.goto('/')

    // Check title
    await expect(page).toHaveTitle(/My Site/)

    // Check meta description
    const metaDescription = page.locator('meta[name="description"]')
    await expect(metaDescription).toHaveAttribute('content', /.+/)
  })
})
```

**Navigation Test:**

```typescript
// e2e/navigation.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Navigation', () => {
  test('should navigate to all main pages', async ({ page }) => {
    await page.goto('/')

    // Navigate to About page
    await page.getByRole('link', { name: /about/i }).click()
    await expect(page).toHaveURL(/.*about/)
    await expect(page.getByRole('heading', { name: /about/i })).toBeVisible()

    // Navigate to Contact page
    await page.getByRole('link', { name: /contact/i }).click()
    await expect(page).toHaveURL(/.*contact/)
    await expect(page.getByRole('heading', { name: /contact/i })).toBeVisible()

    // Navigate back to Home
    await page.getByRole('link', { name: /home/i }).click()
    await expect(page).toHaveURL('/')
  })

  test('should toggle mobile menu on small screens', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/')

    // Menu should be hidden initially
    const nav = page.getByRole('navigation')
    await expect(nav).not.toBeVisible()

    // Click hamburger menu
    await page.getByRole('button', { name: /menu/i }).click()

    // Menu should be visible
    await expect(nav).toBeVisible()
  })
})
```

**Contact Form Test:**

```typescript
// e2e/contact-form.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Contact Form', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/contact')
  })

  test('should display validation errors for empty form', async ({ page }) => {
    // Submit empty form
    await page.getByRole('button', { name: /submit/i }).click()

    // Check for validation errors
    await expect(page.getByText(/name is required/i)).toBeVisible()
    await expect(page.getByText(/email is required/i)).toBeVisible()
  })

  test('should show error for invalid email', async ({ page }) => {
    await page.getByLabel(/name/i).fill('John Doe')
    await page.getByLabel(/email/i).fill('invalid-email')
    await page.getByLabel(/message/i).fill('Test message')

    await page.getByRole('button', { name: /submit/i }).click()

    await expect(page.getByText(/valid email/i)).toBeVisible()
  })

  test('should submit form successfully with valid data', async ({ page }) => {
    await page.getByLabel(/name/i).fill('John Doe')
    await page.getByLabel(/email/i).fill('john@example.com')
    await page.getByLabel(/message/i).fill('This is a test message')

    await page.getByRole('button', { name: /submit/i }).click()

    // Check for success message
    await expect(page.getByText(/thank you|success/i)).toBeVisible()
  })
})
```

**Accessibility Test:**

```typescript
// e2e/accessibility.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Accessibility', () => {
  test('should be navigable with keyboard', async ({ page }) => {
    await page.goto('/')

    // Tab through interactive elements
    await page.keyboard.press('Tab')
    const firstFocusable = page.locator(':focus')
    await expect(firstFocusable).toBeVisible()

    // Check skip link (if present)
    const skipLink = page.getByRole('link', { name: /skip to/i })
    if (await skipLink.isVisible()) {
      await expect(skipLink).toBeFocused()
    }
  })

  test('should have proper heading hierarchy', async ({ page }) => {
    await page.goto('/')

    // Check for h1
    const h1 = page.getByRole('heading', { level: 1 })
    await expect(h1).toHaveCount(1)

    // Check headings don't skip levels
    const headings = await page.getByRole('heading').all()
    expect(headings.length).toBeGreaterThan(0)
  })

  test('should have alt text for images', async ({ page }) => {
    await page.goto('/')

    const images = await page.getByRole('img').all()
    for (const img of images) {
      const alt = await img.getAttribute('alt')
      expect(alt).not.toBeNull()
      expect(alt).not.toBe('')
    }
  })
})
```

#### Run E2E Tests

```powershell
# Run all E2E tests
npm run test:e2e

# Run with UI mode (interactive debugging)
npm run test:e2e:ui

# Run in headed mode (see browser)
npm run test:e2e:headed

# Run specific test file
npx playwright test e2e/home.spec.ts

# Run tests in specific browser
npx playwright test --project=chromium

# View HTML report after tests
npm run test:e2e:report
```

**All E2E tests must pass before proceeding to build.**

### Build the Project

Run the appropriate build command:

```powershell
# React (Create React App or Vite)
npm run build

# Angular
ng build --configuration production

# Vue
npm run build

# Astro
npm run build
```

### Initialize Memory Bank

After the site is created, create `memory-bank.md` in the project root:

```markdown
# Power Pages Project Memory Bank

> Last Updated: [CURRENT_TIMESTAMP]

## Project Overview

| Property | Value |
|----------|-------|
| Project Name | [SITE_NAME from powerpages.config.json] |
| Project Path | [FULL_PROJECT_PATH] |
| Framework | [CHOSEN_FRAMEWORK] |
| Created Date | [CURRENT_DATE] |
| Status | Site Created |

## User Preferences

### Design Preferences
- Style: [USER'S STYLE CHOICE]
- Color Scheme: [USER'S COLOR CHOICE]
- Special Requirements: [ANY SPECIAL REQUIREMENTS]

### Site Features
[LIST ALL FEATURES USER REQUESTED]

## Completed Steps

### /create-site
- [x] Requirements gathered
- [x] Framework selected: [FRAMEWORK]
- [x] Site created with features: [FEATURE_LIST]
- [x] powerpages.config.json created
- [x] SEO assets added (meta tags, favicon, robots.txt, sitemap.xml)
- [x] Unit tests written and passing
- [x] E2E tests written and passing (Playwright)
- [x] Project built successfully
- [ ] Prerequisites verified (PAC CLI, Azure CLI)
- [ ] Uploaded to Power Pages
- [ ] Site activated

## Current Status

**Last Action**: Site created, all tests passing, and built successfully

**Next Step**: Verify prerequisites (PAC CLI, Azure CLI) then upload to Power Pages

## Notes

- [CURRENT_DATE]: Project initialized with [FRAMEWORK] framework
```

**IMPORTANT**: Update this file after each subsequent step is completed.

---

## STEP 3: Check Prerequisites

**IMPORTANT**: Before uploading, verify that all required CLI tools are installed on the user's machine.

### Check PAC CLI

Run the following command to check if PAC CLI is installed:

```powershell
pac help
```

**If the command fails or PAC CLI is not found**, install it using .NET tool:

```powershell
dotnet tool install --global Microsoft.PowerApps.CLI.Tool
```

If installation fails, guide the user based on the error.

After installation, verify it works:

```powershell
pac help
```

### Check Azure CLI

Run the following command to check if Azure CLI is installed:

```powershell
az --version
```

**If the command fails or Azure CLI is not found**, install it using winget:

```powershell
winget install -e --id Microsoft.AzureCLI
```

After installation, the user may need to restart their terminal. Then verify it works:

```powershell
az --version
```

### Verify Authentication

Once both CLIs are installed, ensure the user is authenticated:

```powershell
# Check PAC CLI authentication
pac auth list

# If not authenticated, prompt user to authenticate
pac auth create

# Check Azure CLI authentication
az account show

# If not authenticated, prompt user to login
az login
```

### Verify Environment Connection

```powershell
pac org who
```

---

## STEP 4: Upload to Power Pages (Inactive)

### Upload Command

```powershell
pac pages upload-code-site `
  --rootPath "<PROJECT_ROOT_PATH>" `
```

**Example:**

```powershell
pac pages upload-code-site `
  --rootPath "C:\repos\my-power-pages-site" `
```

### Get Website Record ID

After upload, list sites to get the websiteRecordId:

```powershell
pac pages list --verbose
```

Note the **Website ID** (GUID) - this is needed for activation.

---

## STEP 5: Preview Locally

Before activating the site, run it locally to verify everything works correctly.

### Run the Development Server

```powershell
# React (Vite)
npm run dev

# React (Create React App)
npm start

# Angular
ng serve

# Vue
npm run dev

# Astro
npm run dev
```

### Verify the Site

1. Open the local URL (usually `http://localhost:5173` or `http://localhost:3000`)
2. Test all pages and navigation
3. Verify forms and interactive elements work
4. Check responsive design on different screen sizes

Once you're satisfied with the local preview, proceed to activate the site.

---

## STEP 6: Activate Website

After uploading, your site appears as **Inactive** in Power Pages. Activate it using the Power Platform API.

### Ask for Subdomain

Before activating, ask the user for their preferred subdomain using the AskUserQuestion tool:

- **Subdomain**: The URL prefix for their site (e.g., `my-site` → `my-site.powerappsportals.com`)
- Subdomain must be unique, lowercase, and contain only letters, numbers, and hyphens

### Get Required IDs

First, retrieve the environment and organization IDs:

```powershell
# Get environment details
pac org who
```

From the output, note:
- **Environment ID** - The GUID of the environment
- **Organization ID** - The Dataverse organization ID (same as environment ID in most cases)

### Activate via API

Call the CreateWebsite API using Azure CLI's `az rest` command:

```powershell
# Set variables (replace with actual values)
$environmentId = "<ENVIRONMENT_ID>"
$organizationId = "<ORGANIZATION_ID>"
$websiteRecordId = "<WEBSITE_RECORD_ID_FROM_UPLOAD>"
$siteName = "<SITE_NAME>"
$subdomain = "<USER_CHOSEN_SUBDOMAIN>"

# Create request body
$body = @{
    dataverseOrganizationId = $organizationId
    name = $siteName
    selectedBaseLanguage = 1033
    subdomain = $subdomain
    templateName = "DefaultPortalTemplate"
    websiteRecordId = $websiteRecordId
} | ConvertTo-Json -Compress

# Call CreateWebsite API
az rest `
    --method POST `
    --url "https://api.powerplatform.com/powerpages/environments/$environmentId/websites?api-version=2022-03-01-preview" `
    --resource "https://api.powerplatform.com" `
    --body $body `
    --headers "Content-Type=application/json" `
    --verbose
```

The `--resource` flag automatically handles authentication using your Azure CLI credentials.

### Monitor Activation Status

The API returns a `202 Accepted` response with an `Operation-Location` header. Poll this URL to check activation status:

```powershell
# Check operation status (URL from Operation-Location header in the response)
$operationUrl = "<OPERATION_LOCATION_URL>"

az rest `
    --method GET `
    --url $operationUrl `
    --resource "https://api.powerplatform.com"
```

Wait until the operation status shows as completed (typically 2-5 minutes).

### Verify Activation

```powershell
pac pages list --verbose
```

Your site should now show as **Active** with a URL.

**API Reference**: [CreateWebsite API - Microsoft Learn](https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites/create-website)

### Fallback: Manual Activation

If the API activation fails (e.g., permissions issues, network errors), activate manually:

1. **Go to Power Pages home page**
   - Navigate to [make.powerpages.microsoft.com](https://make.powerpages.microsoft.com)
   - Select your environment

2. **Find your inactive site**
   - Click on **Inactive sites** in the left navigation
   - Your uploaded site will appear in the list

3. **Reactivate the site**
   - Click the **Reactivate** button next to your site

4. **Configure site details**
   - **Website name**: Enter or confirm the display name
   - **Web address**: Enter the subdomain chosen earlier
   - Click **Done**

5. **Wait for provisioning**
   - The site will take a few minutes to provision
   - Once complete, it will appear in **Active sites**

**Reference**: [Reactivate a website - Microsoft Learn](https://learn.microsoft.com/en-us/power-pages/admin/reactivate-website)

### Update Memory Bank

After activation, update `memory-bank.md`:

1. Mark all `/create-site` steps as complete `[x]`
2. Add the Website ID and Site URL
3. Update status to "Site Activated"
4. Set next step to "Setup Dataverse Tables"

```markdown
### /create-site
- [x] Requirements gathered
- [x] Framework selected: [FRAMEWORK]
- [x] Site created with features: [FEATURE_LIST]
- [x] powerpages.config.json created
- [x] SEO assets added (meta tags, favicon, robots.txt, sitemap.xml)
- [x] Unit tests written and passing
- [x] E2E tests written and passing (Playwright)
- [x] Project built successfully
- [x] Prerequisites verified (PAC CLI, Azure CLI)
- [x] Uploaded to Power Pages (Inactive)
- [x] Site activated
- Website ID: [GUID_FROM_PAC_PAGES_LIST]
- Site URL: [URL_FROM_ACTIVATION]

## Current Status

**Last Action**: Site activated successfully

**Next Step**: Run `/setup-dataverse` to create Dataverse tables for your site
```

---

## Next Steps

After the site is active, suggest the maker proceed with:

### Setup Dataverse Tables

> **Recommended Next Step**: Set up Dataverse tables to store and manage your site's data.
>
> This will allow your site to:
>
> - Store contact form submissions, user feedback, and other data
> - Display dynamic content from Dataverse (products, team members, testimonials)
> - Create, update, and delete records via Web API
>
> Run `/setup-dataverse` or type "Set up Dataverse tables for my site" to continue.

### Additional Enhancements

- **Authentication**: Set up Microsoft Entra ID for user sign-in
- **Custom styling**: Further refine the design
- **Performance optimization**: Enable caching and CDN

---

## Troubleshooting

### Upload Fails with JavaScript Error

Enable JavaScript file uploads:

1. Go to Power Platform admin center
2. Navigate to Environments → [Your Environment] → Settings
3. Go to Product → Privacy + Security
4. In "Blocked Attachments", remove `js` from the list
5. Save changes

### Site Shows as Inactive After Upload

This is expected. The upload creates an INACTIVE record. Follow STEP 6 to manually activate it via the Power Pages home page.

### Site Not Appearing in Inactive Sites

- Verify the upload completed successfully
- Check you're in the correct environment
- Run `pac pages list --verbose` to confirm the site exists

### Reactivation Fails

Ensure your user has appropriate permissions:

- System Administrator or System Customizer role in the environment
- Power Pages administrator access

### Next.js or SSR Framework Used

Power Pages code sites **do not support** server-side rendering frameworks:

- **Next.js**, **Nuxt.js**, **Remix**, **SvelteKit** require a Node.js server runtime
- Power Pages serves only **static files** from Azure CDN
- **Solution**: Recreate the project using Vite + React/Vue, or use Angular/Astro with static export

### Liquid Templates Not Working

Liquid templates are **only supported in classic Power Pages sites**, not in code sites:

- Code sites are pure SPAs with no server-side templating
- **Solution**: Use JavaScript/TypeScript to fetch data dynamically via Dataverse Web API
- For dynamic content, call the Web API and render with your chosen framework

### Unit Tests Failing

If tests fail, investigate and fix before proceeding:

- **Component tests failing**: Check that components render correctly and handle props
- **Missing test dependencies**: Run `npm install` to ensure all dev dependencies are installed
- **jsdom errors**: Ensure `environment: 'jsdom'` is set in Vitest config
- **Import errors**: Check that test setup file imports `@testing-library/jest-dom`

```powershell
# Run tests in watch mode for debugging
npm test

# Run specific test file
npm test -- src/components/Header.test.tsx

# Run with verbose output
npm test -- --reporter=verbose
```

**Do not skip tests or proceed with failing tests** - fix all issues before building.

### E2E Tests Failing (Playwright)

If Playwright tests fail, investigate and fix before proceeding:

- **Browser not installed**: Run `npx playwright install` to install browsers
- **Server not starting**: Check that `webServer.command` in `playwright.config.ts` matches your dev script
- **Wrong port**: Ensure `baseURL` matches your dev server port (5173 for Vite, 3000 for CRA, 4200 for Angular)
- **Element not found**: Use Playwright's UI mode to debug selectors: `npm run test:e2e:ui`
- **Timeout errors**: Increase timeout in config or use `await expect().toBeVisible({ timeout: 10000 })`
- **Flaky tests**: Add `await page.waitForLoadState('networkidle')` before assertions

```powershell
# Debug with UI mode (recommended)
npm run test:e2e:ui

# Debug with headed browser
npm run test:e2e:headed

# Run single test for debugging
npx playwright test e2e/home.spec.ts --headed

# Generate test code by recording actions
npx playwright codegen http://localhost:5173

# View trace for failed tests
npx playwright show-trace trace.zip
```

**Do not skip E2E tests or proceed with failing tests** - fix all issues before building.

---

## Reference Documentation

- [Create Code Sites in Power Pages](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [Reactivate a Website](https://learn.microsoft.com/en-us/power-pages/admin/reactivate-website)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages)
- [Playwright Documentation](https://playwright.dev/docs/intro)
- [Vitest Documentation](https://vitest.dev/guide/)
