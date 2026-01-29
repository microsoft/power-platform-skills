# Troubleshooting

## Upload Issues

### Upload Fails with JavaScript Error

Enable JavaScript file uploads:

1. Go to Power Platform admin center
2. Navigate to Environments → [Your Environment] → Settings
3. Go to Product → Privacy + Security
4. In "Blocked Attachments", remove `js` from the list
5. Save changes

### Site Shows as Inactive After Upload

This is expected. The upload creates an INACTIVE record. Follow the activation steps in [upload-activation-reference.md](./upload-activation-reference.md).

### Site Not Appearing in Inactive Sites

- Verify the upload completed successfully
- Check you're in the correct environment
- Run `pac pages list --verbose` to confirm the site exists

### Reactivation Fails

Ensure your user has appropriate permissions:
- System Administrator or System Customizer role in the environment
- Power Pages administrator access

---

## Framework Issues

### Next.js or SSR Framework Used

Power Pages code sites **do not support** server-side rendering frameworks:

| Framework | Issue |
|-----------|-------|
| Next.js | Requires Node.js server runtime |
| Nuxt.js | Requires Node.js server runtime |
| Remix | Requires server-side rendering |
| SvelteKit | Server features not supported |

Power Pages serves only **static files** from Azure CDN.

**Solution**: Recreate the project using Vite + React/Vue, or use Angular/Astro with static export.

### Liquid Templates Not Working

Liquid templates are **only supported in classic Power Pages sites**, not in code sites:

- Code sites are pure SPAs with no server-side templating
- **Solution**: Use JavaScript/TypeScript to fetch data dynamically via Dataverse Web API
- For dynamic content, call the Web API and render with your chosen framework

---

## Unit Test Issues

### Tests Failing

Investigate and fix before proceeding:

| Issue | Solution |
|-------|----------|
| Component tests failing | Check that components render correctly and handle props |
| Missing test dependencies | Run `npm install` to ensure all dev dependencies are installed |
| jsdom errors | Ensure `environment: 'jsdom'` is set in Vitest config |
| Import errors | Check that test setup file imports `@testing-library/jest-dom` |

```powershell
# Run tests in watch mode for debugging
npm test

# Run specific test file
npm test -- src/components/Header.test.tsx

# Run with verbose output
npm test -- --reporter=verbose
```

**Do not skip tests or proceed with failing tests** - fix all issues before building.

---

## E2E Test Issues (Playwright)

### Common E2E Failures

| Issue | Solution |
|-------|----------|
| Browser not installed | Run `npx playwright install` |
| Server not starting | Check that `webServer.command` matches your dev script |
| Wrong port | Ensure `baseURL` matches your dev server port |
| Element not found | Use Playwright UI mode to debug selectors |
| Timeout errors | Increase timeout: `await expect().toBeVisible({ timeout: 10000 })` |
| Flaky tests | Add `await page.waitForLoadState('networkidle')` before assertions |

### Debugging Commands

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

## Authentication Issues

### PAC CLI Not Authenticated

```powershell
# Check current auth
pac auth list

# Create new auth profile
pac auth create
```

### Azure CLI Not Authenticated

```powershell
# Check current auth
az account show

# Login
az login
```

### Wrong Environment

```powershell
# Check current environment
pac org who

# Switch environment
pac org select
```

---

## Build Issues

### Build Fails

| Issue | Solution |
|-------|----------|
| TypeScript errors | Fix type errors before building |
| Missing dependencies | Run `npm install` |
| Out of memory | Increase Node memory: `NODE_OPTIONS=--max_old_space_size=4096 npm run build` |
| Path issues | Use absolute paths or verify relative paths are correct |

### Build Output Missing

- Check `powerpages.config.json` has the correct `compiledPath`
- Verify the build command completed successfully
- Check the build/dist folder exists and contains files

---

## Reference Documentation

- [Create Code Sites in Power Pages](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [Reactivate a Website](https://learn.microsoft.com/en-us/power-pages/admin/reactivate-website)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages)
- [Playwright Documentation](https://playwright.dev/docs/intro)
- [Vitest Documentation](https://vitest.dev/guide/)
