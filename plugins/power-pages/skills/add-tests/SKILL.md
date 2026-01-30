---
name: adding-tests
description: Adds unit tests (Vitest) and E2E tests (Playwright) to Power Pages sites. Use when setting up testing infrastructure, writing tests, or adding test coverage.
user-invocable: true
allowed-tools: ["Read", "Write", "Grep", "Glob", "Bash", "AskUserQuestion"]
model: opus
---

**📋 [Shared Instructions](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Read before starting.

# Add Tests

**References:** [testing](./references/testing-reference.md)

Adds testing infrastructure to an existing Power Pages code site.

## Prerequisites

- Site created with `/create-site`
- Framework identified (React/Vue/Angular/Astro)

## Workflow

1. **Check Context** → Read memory bank, identify framework
2. **Setup Unit Tests** → Install Vitest, configure, write component tests
3. **Setup E2E Tests** → Install Playwright, configure, write page tests
4. **Run Tests** → Verify all tests pass
5. **Update CI (Optional)** → Add test scripts to package.json

---

## Step 1: Check Context

Read `memory-bank.md` and `package.json` to identify:
- Framework (React, Vue, Angular, Astro)
- Build tool (Vite, CRA, Angular CLI)
- Existing test setup (if any)

---

## Step 2: Setup Unit Tests

See [testing-reference.md](./references/testing-reference.md#unit-tests).

### Install Dependencies

```powershell
# React (Vite)
npm install -D vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom

# Vue (Vite)
npm install -D vitest @vue/test-utils @testing-library/vue jsdom
```

### Configure Vitest

Add test config to `vite.config.ts` and create `src/test/setup.ts`.

### Write Tests

Create tests for key components:
- `src/components/Header.test.tsx`
- `src/components/[MainComponent].test.tsx`
- `src/utils/[utility].test.ts`

---

## Step 3: Setup E2E Tests

See [testing-reference.md](./references/testing-reference.md#end-to-end-tests-playwright).

### Install Playwright

```powershell
npm install -D @playwright/test
npx playwright install
```

### Configure Playwright

Create `playwright.config.ts` with correct baseURL for framework.

### Write E2E Tests

Create tests in `e2e/` folder:
- `e2e/home.spec.ts` - Homepage tests
- `e2e/navigation.spec.ts` - Navigation tests
- `e2e/accessibility.spec.ts` - A11y checks

---

## Step 4: Run Tests

```powershell
# Unit tests
npm run test:run

# E2E tests
npm run test:e2e
```

**All tests must pass before completing this skill.**

---

## Step 5: Update Package Scripts

Ensure `package.json` has test scripts:

```json
{
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui"
  }
}
```

Update memory-bank.md with testing status.
