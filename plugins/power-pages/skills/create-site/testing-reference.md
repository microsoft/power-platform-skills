# Testing Reference

This document describes how to set up and write unit tests and end-to-end tests for your Power Pages code site.

## Unit Tests

### Install Testing Dependencies

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

### Configure Vitest (Vite Projects)

Add test configuration to `vite.config.ts`:

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

### What to Test

| Category | What to Test |
|----------|--------------|
| Components | Rendering, user interactions, props |
| Utility functions | Data transformations, validators, formatters |
| Custom hooks | State management, side effects |
| Form validation | Validation rules, error messages |
| API services | Dataverse Web API wrapper functions (mock the API) |

### Test File Structure

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

### Example Component Test (React)

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

### Example Utility Test

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

### Run Unit Tests

```powershell
# Run all tests
npm test

# Run tests once (CI mode)
npm run test:run

# Run with coverage report
npm run test:coverage
```

**All unit tests must pass before proceeding to E2E tests.**

---

## End-to-End Tests (Playwright)

### Install Playwright

```powershell
# Install Playwright
npm install -D @playwright/test

# Install browsers (Chromium, Firefox, WebKit)
npx playwright install
```

### Configure Playwright

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
    baseURL: 'http://localhost:5173', // Adjust for your framework
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

### Framework-Specific URLs

| Framework | baseURL / webServer.url |
|-----------|-------------------------|
| Vite (React/Vue) | `http://localhost:5173` |
| Create React App | `http://localhost:3000` |
| Angular | `http://localhost:4200` |
| Astro | `http://localhost:4321` |

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

### E2E Test Structure

```text
/e2e
├── home.spec.ts              # Home page tests
├── navigation.spec.ts        # Navigation tests
├── contact-form.spec.ts      # Form submission tests
├── responsive.spec.ts        # Mobile responsiveness tests
└── fixtures/
    └── test-data.ts          # Shared test data
```

### What to Test with E2E

| Category | What to Test |
|----------|--------------|
| Page Navigation | All links work, routes load correctly |
| Form Submissions | Contact forms, search, filters work end-to-end |
| Responsive Design | Site works on mobile, tablet, and desktop |
| Interactive Elements | Modals, dropdowns, accordions function properly |
| Accessibility | Keyboard navigation, focus states |
| Error States | Error pages and validation messages |

### Example: Home Page Test

```typescript
// e2e/home.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Home Page', () => {
  test('should display hero section with correct content', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('banner')).toBeVisible()

    const ctaButton = page.getByRole('link', { name: /get started/i })
    await expect(ctaButton).toBeVisible()
  })

  test('should have valid meta tags', async ({ page }) => {
    await page.goto('/')

    await expect(page).toHaveTitle(/My Site/)

    const metaDescription = page.locator('meta[name="description"]')
    await expect(metaDescription).toHaveAttribute('content', /.+/)
  })
})
```

### Example: Navigation Test

```typescript
// e2e/navigation.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Navigation', () => {
  test('should navigate to all main pages', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('link', { name: /about/i }).click()
    await expect(page).toHaveURL(/.*about/)
    await expect(page.getByRole('heading', { name: /about/i })).toBeVisible()

    await page.getByRole('link', { name: /contact/i }).click()
    await expect(page).toHaveURL(/.*contact/)
    await expect(page.getByRole('heading', { name: /contact/i })).toBeVisible()

    await page.getByRole('link', { name: /home/i }).click()
    await expect(page).toHaveURL('/')
  })

  test('should toggle mobile menu on small screens', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/')

    const nav = page.getByRole('navigation')
    await expect(nav).not.toBeVisible()

    await page.getByRole('button', { name: /menu/i }).click()
    await expect(nav).toBeVisible()
  })
})
```

### Example: Contact Form Test

```typescript
// e2e/contact-form.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Contact Form', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/contact')
  })

  test('should display validation errors for empty form', async ({ page }) => {
    await page.getByRole('button', { name: /submit/i }).click()

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

    await expect(page.getByText(/thank you|success/i)).toBeVisible()
  })
})
```

### Example: Accessibility Test

```typescript
// e2e/accessibility.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Accessibility', () => {
  test('should be navigable with keyboard', async ({ page }) => {
    await page.goto('/')

    await page.keyboard.press('Tab')
    const firstFocusable = page.locator(':focus')
    await expect(firstFocusable).toBeVisible()

    const skipLink = page.getByRole('link', { name: /skip to/i })
    if (await skipLink.isVisible()) {
      await expect(skipLink).toBeFocused()
    }
  })

  test('should have proper heading hierarchy', async ({ page }) => {
    await page.goto('/')

    const h1 = page.getByRole('heading', { level: 1 })
    await expect(h1).toHaveCount(1)

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

### Run E2E Tests

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
