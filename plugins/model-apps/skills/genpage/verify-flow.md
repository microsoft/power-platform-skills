# Verify Flow (optional Phase 7)

After Phase 6 deployment, the orchestrator asks the user whether to verify in
the browser via Playwright. **This file is only loaded when the user opts in.**
If they skip, the orchestrator goes straight to Phase 8.

## 7.1 Navigate and Authenticate

Construct the URL from the environment base URL, app-id, and page-id returned by upload:

```
https://<env>.crm.dynamics.com/main.aspx?appid=<app-id>&pagetype=genux&id=<page-id>
```

1. Use `browser_navigate` to open the constructed URL.
2. If you get a "page closed" or "browser closed" error, retry navigation once.
3. Use `browser_snapshot` to capture the page state. Always snapshot before any clicks.
4. If a sign-in page appears, use `browser_click` on the sign-in option, then `browser_wait_for`.
5. Use `browser_wait_for` for the genux page content to render.

## 7.2 Structural Verification (Including Below-the-Fold Content)

Take an initial `browser_snapshot` to capture above-the-fold content.

**Check whether the page extends beyond the viewport:**

```javascript
browser_evaluate(() => ({
  scrollHeight: document.documentElement.scrollHeight,
  clientHeight: document.documentElement.clientHeight
}))
```

**If `scrollHeight > clientHeight`, the page has content below the fold.**
Scroll through to verify all sections render:

1. Scroll to the bottom:
   ```javascript
   browser_evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
   ```
2. Take a fresh `browser_snapshot` to capture below-the-fold content.
3. For very tall pages (long lists, multi-section dashboards), scroll
   incrementally and snapshot each section:
   ```javascript
   browser_evaluate(() => window.scrollBy(0, window.innerHeight))
   ```
4. Use `browser_take_screenshot` at each scroll position to capture visuals.

Verify expected DOM elements are present somewhere on the page (not just
above-the-fold):

| Page Type | Expected Elements |
|-----------|-------------------|
| Data Grid | Table/grid element with column headers and data rows |
| Form / Wizard | Form fields (inputs, dropdowns) and Next/Back buttons |
| CRUD | Data grid + action buttons (Add, Edit, Delete) |
| Dashboard | Multiple sections/panels with headings |
| Card Layout | Card containers with content |
| File Upload | File input or drop zone element |
| Navigation Sidebar | Nav element with menu items |

**Scroll back to the top before interactive testing:**
```javascript
browser_evaluate(() => window.scrollTo(0, 0))
```

## 7.3 Interactive Testing

Test interactions based on the page type. **Always take a fresh
`browser_snapshot` before each click.** Move on after 2 failed attempts per
interaction.

| Page Type | Test Action | Expected Result |
|-----------|-------------|-----------------|
| Data Grid | Click a column header | Sort order changes |
| Form / Wizard | Click Next button | Step advances |
| CRUD | Click Add/New button | Form or dialog appears |
| Dashboard | Click a tab or section toggle | Content area updates |
| Card Layout | Click a card action button | Card responds |
| Navigation Sidebar | Click a menu item | Content area updates |

**Skip these:** Dataverse data mutations, file upload dialogs, complex form
validation, pagination.

## 7.4 Visual Confirmation

Use `browser_take_screenshot` to capture the page in its final verified state.

For pages taller than the viewport, capture multiple screenshots by scrolling:
top (`window.scrollTo(0, 0)`), one or more intermediate positions for long
pages, and bottom
(`window.scrollTo(0, document.documentElement.scrollHeight)`). This gives a
complete visual record for the deployment summary.

## 7.5 Fix and Re-deploy

If issues are found: fix the code, re-deploy using the **update form** from
Phase 6 (`--page-id`, no `--add-to-sitemap`). Per the "`--prompt` semantics"
rule, `--prompt` for this re-deploy describes the fix delta only — e.g.
`"Fix sort handler on Name column; correct accidental DataGrid type prop"` —
not a re-statement of the full page description.

**Common Playwright issues:**
- "Target page, context or browser has been closed" → retry the navigation.
- "Ref not found" → take a fresh `browser_snapshot` before clicking any element.
- Sign-in required → user must sign in manually first.
