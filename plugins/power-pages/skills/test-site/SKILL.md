---
name: test-site
description: >-
  Tests a deployed, activated Power Pages site at runtime using browser-based navigation,
  page crawling, and API request verification via Playwright. Use when the user wants to
  test, verify, or smoke-test their deployed site.
user-invocable: true
argument-hint: "<site-url>"
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_snapshot, mcp__plugin_power-pages_playwright__browser_click, mcp__plugin_power-pages_playwright__browser_close, mcp__plugin_power-pages_playwright__browser_network_requests, mcp__plugin_power-pages_playwright__browser_console_messages, mcp__plugin_power-pages_playwright__browser_wait_for, mcp__plugin_power-pages_playwright__browser_take_screenshot, mcp__plugin_power-pages_playwright__browser_resize, mcp__plugin_power-pages_playwright__browser_evaluate
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Test Power Pages Site

Test a deployed, activated Power Pages site at runtime. Navigate the site in a browser, crawl all discoverable links, verify pages load correctly, capture network traffic to test API requests, and generate a comprehensive test report.

> **Prerequisite:** This skill expects a deployed and activated Power Pages site. Run `/deploy-site` and `/activate-site` first if the site is not yet live.

## Core Principles

- **Non-destructive**: This skill is read-only — it does not create, modify, or delete any files or data. It only observes the site via the browser.
- **API-first testing**: The primary goal beyond page loads is verifying that all `/_api/` (Web API / OData) requests return successful responses.
- **User-controlled authentication**: Never attempt to log in automatically. Always ask the user to log in via the browser window when authentication is required.
- **Bounded crawling**: Cap page crawling at 25 pages to prevent infinite loops on sites with dynamic or paginated URLs.

**Initial request:** $ARGUMENTS

---

## Phase 1: Resolve Site URL

**Goal:** Determine the live URL of the Power Pages site to test.

### Actions

#### 1.1 Create Task List

Create the full task list with all 6 phases before starting any work (see [Progress Tracking](#progress-tracking) table).

#### 1.2 Check User Input

If the user provided a URL in `$ARGUMENTS`:

1. Validate it starts with `https://`.
2. Store it as `SITE_URL` and skip to Phase 2.

#### 1.3 Auto-Detect from Activation Status

If no URL was provided, attempt auto-detection:

1. Locate the project root by searching for `powerpages.config.json`:

   ```
   **/powerpages.config.json
   ```

2. Run the activation status check script:

   ```powershell
   node "${CLAUDE_PLUGIN_ROOT}/scripts/check-activation-status.js" --projectRoot "<PROJECT_ROOT>"
   ```

3. Evaluate the JSON result:
   - **If `activated` is `true` and `websiteUrl` is present**: Use `websiteUrl` as `SITE_URL`. Inform the user: "Detected your site URL: **<websiteUrl>**"
   - **If `activated` is `false`**: Inform the user: "Your site is not yet activated. Please run `/activate-site` first, then re-run this skill."  Stop the skill.
   - **If `error` is present**: Fall through to step 1.4.

#### 1.4 Ask the User

If auto-detection failed or was inconclusive, use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| What is the URL of the deployed Power Pages site you want to test? (e.g., <https://contoso.powerappsportals.com>) | Site URL | I'll paste the URL (description: Select "Other" below and paste your site URL), I don't know my URL (description: Run `/activate-site` to get your site URL, or check the Power Platform admin center) |

Store the user-provided URL as `SITE_URL`.

### Output

- `SITE_URL` resolved and ready for testing

---

## Phase 2: Launch Browser & Initial Load

**Goal:** Open the site in a browser, verify the homepage loads, and capture baseline errors.

### Actions

#### 2.1 Resize Browser

Set the browser to a standard desktop viewport:

- Use `browser_resize` with **width: 1280, height: 720**.

#### 2.2 Navigate to Site

- Use `browser_navigate` to open `SITE_URL`.

#### 2.3 Wait for Page Load

- Use `browser_wait_for` with **time: 5** seconds to allow the page to fully render (SPAs may need time for client-side routing and API calls).

#### 2.4 Verify Homepage

- Use `browser_snapshot` to take an accessibility snapshot.
- Check the snapshot for signs of a working page:
  - Page has meaningful content (not blank, not a generic error page).
  - Look for common error indicators: "404", "Page not found", "500", "Internal Server Error", "This site can't be reached".
- If the page shows an error, report it to the user and ask whether to continue or stop.

#### 2.5 Capture Console Errors

- Use `browser_console_messages` with **level: "error"** to check for JavaScript errors on initial load.
- Record any errors found — these will be included in the final report.

#### 2.6 Capture Initial Network Requests

- Use `browser_network_requests` with **includeStatic: false** to capture the initial page load API calls.
- Record any `/_api/` or OData requests and their status codes for Phase 5 analysis.

### Output

- Browser launched at correct viewport size
- Homepage loaded and verified via snapshot
- Initial console errors and network requests recorded
- If the homepage shows a login screen, noted for Phase 3

---

## Phase 3: Authentication Check

**Goal:** Detect if the site requires authentication and handle login if needed. Power Pages sites can have **two layers** of authentication:

1. **Private site gate** — The entire site is private. Navigating to the site redirects to an identity provider (Azure AD B2C, etc.) before any site content is visible. The browser URL will typically change to a different domain (e.g., `login.microsoftonline.com`, `*.b2clogin.com`).
2. **Site-level authentication** — The site is publicly accessible (homepage loads), but certain pages or features require a logged-in user with a specific web role. Indicated by "Sign in" / "Log in" links in the navigation, or pages that show restricted-access messages.

### Actions

#### 3.1 Analyze Homepage Snapshot for Private Site Gate

Review the browser snapshot from Phase 2.4 and the current browser URL for signs of a **private site redirect**:

- The page content shows an identity provider login form (Azure AD B2C, Azure AD, etc.)
- The browser URL has changed to a different domain than `SITE_URL` (e.g., `login.microsoftonline.com`, `*.b2clogin.com`, or a custom identity provider domain)
- A 401/403 response was returned before any site content loaded
- The page is blank or shows "Access denied" / "You do not have access" with no site navigation visible

#### 3.2 Handle Private Site Gate

If a private site gate is detected, use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| This site is **private** — it redirected to an identity provider login page before any content could load. A browser window should be open showing the login page. Please log in there using credentials that have access to this site. Once you have successfully logged in and can see the site homepage, select "I have logged in" below. | Private Site Login | I have logged in (Recommended) — I've completed the login and can see the site, Cancel testing — Stop the test |

**If "I have logged in"**:

1. Use `browser_snapshot` to verify the user is now on the actual site (site content visible, navigation present, URL is back on the `SITE_URL` domain).
2. If still on the identity provider login page:
   - Use `AskUserQuestion` again: "It looks like the login hasn't completed yet. The browser should still be open — please complete the login and try again."
   - Repeat until login is confirmed or user cancels.
3. Once confirmed, re-run Phase 2.5 and 2.6 (capture console errors and network requests on the now-loaded homepage).
4. Continue to step 3.3 to check for site-level authentication.

**If "Cancel testing"**:

- Stop the skill and inform the user they can re-run it after resolving access.

#### 3.3 Analyze for Site-Level Authentication

After the homepage is loaded (either directly for public sites, or after passing the private site gate), review the snapshot for signs of **site-level authentication**:

- "Sign in" / "Log in" / "Register" links or buttons in the site navigation
- Pages that show "You must be signed in to view this page" or similar messages
- Content that indicates some areas are restricted to authenticated users

#### 3.4 Handle Public Site (No Authentication Needed)

If neither a private site gate nor site-level authentication indicators are found:

- Inform the user: "Site is publicly accessible. Proceeding with page and API testing."
- Skip to Phase 4.

#### 3.5 Handle Site-Level Authentication

If site-level authentication indicators are detected (login links in navigation, etc.), use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| The site has a **Sign in** option, which means some pages or API calls may require authentication. A browser window should be open — you can click "Sign in" and log in with a user account that has the appropriate web role. Once you have successfully logged in, select "I have logged in" below. | Site Authentication | I have logged in (Recommended) — I've signed in through the site's login flow, Skip authenticated pages — Only test publicly accessible pages and APIs, Cancel testing — Stop the test |

**If "I have logged in"**:

1. Use `browser_snapshot` to verify the user is now logged in (login link replaced with user name/profile, or authenticated content is visible).
2. If the login form is still showing:
   - Use `AskUserQuestion` again: "It looks like the login hasn't completed yet. The browser should still be open — please complete the login and try again."
   - Repeat until login is confirmed or user cancels.
3. Create an additional task for testing authenticated scenarios using `TaskCreate`:

   | Task subject | activeForm | Description |
   |-------------|------------|-------------|
   | Test authenticated pages and APIs | Testing authenticated scenarios | Re-crawl site as logged-in user, verify auth-gated pages load and authenticated API calls succeed |

**If "Skip authenticated pages"**:

- Note that only public pages will be tested. Some API calls may return 401/403 — these will be flagged but not treated as failures.
- Do **not** create the authenticated testing task.
- Continue to Phase 4.

**If "Cancel testing"**:

- Stop the skill and inform the user they can re-run it after resolving authentication.

### Output

- Authentication status resolved for both layers:
  - Private site gate: passed, not needed, or cancelled
  - Site-level auth: logged in, skipped, or not needed
- If authenticated: additional task created for authenticated testing in Phase 5.6

---

## Phase 4: Crawl & Test Pages

**Goal:** Discover all navigable links on the site and verify each page loads correctly.

### Actions

#### 4.1 Discover Links from Current Page

Use `browser_evaluate` to extract all internal links:

```javascript
() => {
  const links = Array.from(document.querySelectorAll('a[href]'));
  return links
    .map(a => a.href)
    .filter(href => href.startsWith(window.location.origin))
    .filter(href => !href.includes('#') || href.split('#')[0] !== window.location.href.split('#')[0])
    .map(href => href.split('#')[0])
    .filter((href, i, arr) => arr.indexOf(href) === i);
}
```

Present the discovered links to the user:
> "Found **X** internal links on the homepage. Testing each page..."

#### 4.2 Test Each Page

For each discovered URL, in sequence:

1. **Navigate**: Use `browser_navigate` to go to the URL.
2. **Wait**: Use `browser_wait_for` with **time: 3** seconds for the page to render.
3. **Snapshot**: Use `browser_snapshot` to verify the page rendered content.
4. **Check for errors**: Look for error indicators in the snapshot (404, 500, blank page, error messages).
5. **Console errors**: Use `browser_console_messages` with **level: "error"** to check for JavaScript errors.
6. **Discover new links**: Use `browser_evaluate` (same script as 4.1) to find any new internal links not already in the queue.
7. **Record result**: URL, status (Pass/Fail), error count, notes.

#### 4.3 Crawl Newly Discovered Links

- Add any newly discovered links from step 4.2.6 to the test queue.
- Continue testing until all links are visited or the **25-page cap** is reached.
- If the cap is hit, inform the user: "Reached the 25-page testing limit. **Y** additional links were discovered but not tested."

#### 4.4 Record Page Test Results

Build a results list tracking:

- URL tested
- Load status (Pass / Fail)
- Number of console errors
- Notes (error messages, blank page, redirect, etc.)

### Output

- All discoverable pages crawled (up to 25)
- Pass/fail status recorded for each page
- New links discovered during crawl added to results

---

## Phase 5: Test API Requests

**Goal:** Capture and analyze all API requests made by the site to verify they are working.

### Actions

#### 5.1 Revisit Data-Driven Pages

Navigate back to pages that are likely to make API calls — pages with dynamic content such as data tables, lists, forms, or dashboards. Prioritize pages where `/_api/` requests were observed in Phase 2.6 or Phase 4.

For each data-driven page:

1. Use `browser_navigate` to go to the page.
2. Use `browser_wait_for` with **time: 5** seconds to allow API calls to complete.

#### 5.2 Capture Network Requests

- Use `browser_network_requests` with **includeStatic: false** to get all network requests.
- Filter for API requests matching these patterns:
  - `/_api/` — Power Pages Web API / OData endpoints
  - `/api/` — Custom API endpoints
  - URLs containing `odata` or `$filter`, `$select`, `$expand` query parameters

#### 5.3 Analyze API Responses

For each captured API request, evaluate:

| Status Code | Category | Action |
|-------------|----------|--------|
| 200, 201, 204 | **Pass** | Valid successful response |
| 304 | **Warning** | Cached response — acceptable but note it |
| 401 | **Fail** | Unauthorized — missing or expired auth token |
| 403 | **Fail** | Forbidden — table permissions or site settings issue |
| 404 | **Fail** | Not found — incorrect entity set name or endpoint |
| 500 | **Fail** | Server error — internal Dataverse or plugin error |
| Other 4xx/5xx | **Fail** | Unexpected error |

#### 5.4 Provide Actionable Guidance for Failures

For each failed API request, provide specific remediation:

- **401 Unauthorized**: "This endpoint requires authentication. If you skipped login in Phase 3, try re-running with authentication. Otherwise, check that the auth token is being passed correctly."
- **403 Forbidden on `/_api/` calls**: "Check the following:\n  1. **Table permissions** — Ensure a table permission exists for this table with the correct scope and privileges (Read, Write, etc.) assigned to the appropriate web role.\n  2. **Site settings** — Verify `Webapi/<tablename>/enabled` is set to `true` and `Webapi/<tablename>/fields` lists the required columns (exact Dataverse LogicalNames, all lowercase, comma-separated). If the failing request uses aggregate OData (`$apply`, `aggregate`, grouped totals), set `Webapi/<tablename>/fields` to `*`.\n  3. **Web role assignment** — Confirm the authenticated user has the correct web role assigned."
- **404 Not Found**: "Verify the entity set name (should be the plural form of the table logical name). Check that the table exists in Dataverse and is published."
- **500 Internal Server Error**: "Enable the `Webapi/error/innererror` site setting (set to `true`) to get detailed error messages. Redeploy and retest to see the inner error details."

#### 5.5 Test Form Submissions (Optional)

If forms are detected on any page (via `browser_snapshot` showing form elements), ask the user before interacting:

| Question | Header | Options |
|----------|--------|---------|
| I found forms on the site that may trigger API calls when submitted. Should I attempt to interact with these forms to test the POST/PATCH API endpoints? Note: this may create or modify data in your Dataverse environment. | Form Testing | Yes, test form submissions — I understand this may create test data, Skip form testing (Recommended) — Only test read-only API calls |

**If "Yes"**:

1. Use `browser_click` to interact with form submit buttons.
2. Use `browser_wait_for` to wait for the form response.
3. Use `browser_network_requests` to capture the resulting POST/PATCH requests.
4. Analyze responses using the same criteria as 5.3.

**If "Skip"**: Continue to Phase 5.6 (or Phase 6 if no authenticated testing task was created).

### Output

- All API endpoints discovered and tested
- Pass/fail status with HTTP status codes recorded
- Actionable remediation guidance provided for each failure

---

### 5.6 Test Authenticated Scenarios (Only If User Logged In)

> Skip this step entirely if the user chose "Skip authenticated pages" in Phase 3.5, or if no site-level authentication was detected in Phase 3.3.

**Goal:** Re-crawl the site as an authenticated user to discover and test pages and API calls that are only available after login.

Mark the "Test authenticated pages and APIs" task as `in_progress`.

#### 5.6.1 Discover Authenticated Pages

After login, the site navigation may show additional links that were hidden or restricted for anonymous users (e.g., profile pages, dashboards, admin panels, account management).

1. Navigate back to `SITE_URL` (homepage).
2. Use `browser_snapshot` to capture the authenticated navigation.
3. Use `browser_evaluate` (same link extraction script as Phase 4.1) to discover internal links.
4. Compare against the links already tested in Phase 4. Identify any **new links** that were not visible before authentication.

If new links are found, inform the user:
> "Found **X** additional pages visible after login that were not accessible anonymously. Testing each page..."

#### 5.6.2 Test Authenticated Pages

For each newly discovered link, follow the same test procedure as Phase 4.2:

1. Navigate, wait, snapshot, check for errors, capture console errors.
2. Record results separately as **authenticated page tests**.
3. Respect the same 25-page cap (counting pages already tested in Phase 4).

#### 5.6.3 Test Authenticated API Calls

For each authenticated page that makes `/_api/` requests:

1. Use `browser_network_requests` with **includeStatic: false** to capture API calls.
2. Compare against API calls captured in Phase 5 — identify any **new endpoints** or endpoints that previously returned 401/403 and now succeed.
3. Analyze responses using the same criteria as Phase 5.3.

#### 5.6.4 Record Results

Record authenticated test results separately so Phase 6 can report them in a distinct section:

- Authenticated pages discovered and tested (count, pass/fail)
- Authenticated API calls (count, pass/fail, any endpoints that changed from fail to pass after login)

Mark the "Test authenticated pages and APIs" task as `completed`.

### Output

- Authenticated pages crawled and tested
- Authenticated API endpoints captured and analyzed
- Results recorded separately for the test report

---

## Phase 6: Generate Test Report

**Goal:** Present a comprehensive summary of all test results and suggest next steps.

### Actions

#### 6.1 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "TestSite"`.

#### 6.2 Present Page Test Results

Present results in a clear table:

```
## Page Test Results

| # | URL | Status | Console Errors | Notes |
|---|-----|--------|----------------|-------|
| 1 | /                | Pass | 0 | Homepage loaded successfully |
| 2 | /about           | Pass | 0 | |
| 3 | /products        | Pass | 2 | Minor JS warnings |
| 4 | /admin           | Fail | 1 | 403 Forbidden |

Pages tested: 4/4 | Passed: 3 | Failed: 1
```

#### 6.3 Present API Test Results

```
## API Test Results

| # | Endpoint | Method | Status | Notes |
|---|----------|--------|--------|-------|
| 1 | /_api/cr4fc_products       | GET | 200 OK      | 12 records returned |
| 2 | /_api/cr4fc_categories     | GET | 200 OK      | 3 records returned  |
| 3 | /_api/cr4fc_orders         | GET | 403 Forbidden | Missing table permissions |

API endpoints tested: 3 | Passed: 2 | Failed: 1
```

If no API requests were captured, note: "No API requests (`/_api/` or OData) were detected during testing. This site may not use the Web API, or API calls may require specific user interactions to trigger."

#### 6.4 Present Authenticated Test Results (If Applicable)

If Phase 5.6 was executed, present results in separate tables:

```
## Authenticated Page Test Results

| # | URL | Status | Console Errors | Notes |
|---|-----|--------|----------------|-------|
| 1 | /profile         | Pass | 0 | User profile loaded |
| 2 | /dashboard       | Pass | 1 | Minor JS warning |
| 3 | /admin/settings  | Fail | 0 | 403 Forbidden — insufficient web role |

Authenticated pages tested: 3 | Passed: 2 | Failed: 1
```

```
## Authenticated API Test Results

| # | Endpoint | Method | Status | Notes |
|---|----------|--------|--------|-------|
| 1 | /_api/cr4fc_orders         | GET | 200 OK      | Previously 403 — now accessible after login |
| 2 | /_api/cr4fc_userprofiles   | GET | 200 OK      | Only visible after auth |

Authenticated API endpoints tested: 2 | Passed: 2 | Failed: 0
```

If no additional pages or APIs were discovered after login, note: "No additional pages or API endpoints were found after authentication. The authenticated user sees the same content as an anonymous visitor."

#### 6.5 Present Overall Summary

```
## Overall Test Summary

| Category                 | Tested | Passed | Failed | Warnings |
|--------------------------|--------|--------|--------|----------|
| Pages (public)           | 4      | 3      | 1      | 0        |
| Pages (authenticated)    | 3      | 2      | 1      | 0        |
| API Endpoints (public)   | 3      | 2      | 1      | 0        |
| API Endpoints (auth)     | 2      | 2      | 0      | 0        |
| Console Errors           | —      | —      | —      | 2        |

Overall: X/Y checks passed
```

If authenticated testing was skipped, omit the authenticated rows from the table.

#### 6.6 Present Recommendations

For each failure, reiterate the specific remediation guidance from Phase 5.4. Group recommendations by category:

- **Table permissions issues** → `/create-webroles` or manually configure table permissions
- **Site settings issues** → Check `Webapi/<table>/enabled` and `Webapi/<table>/fields` settings
- **Authentication issues** → `/setup-auth`
- **Missing endpoints** → Verify table exists in Dataverse via `/setup-datamodel`
- **Server errors** → Enable `Webapi/error/innererror` site setting for diagnostics

#### 6.7 Close Browser

- Use `browser_close` to clean up the browser session.

#### 6.8 Suggest Next Steps

Based on the test results, suggest relevant skills:

- If API failures were found: `/integrate-webapi` — Fix Web API site settings and table permissions
- If authentication issues: `/setup-auth` — Configure authentication providers
- If pages had errors: Review the site code and redeploy with `/deploy-site`
- If all tests passed: Site is working correctly! Consider `/add-seo` for search engine optimization

### Output

- Comprehensive test report presented with pass/fail for pages and APIs
- Actionable recommendations for each failure
- Browser session closed
- Next steps suggested

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **This skill is read-only** — it does not modify any files or data
- **Never attempt to log in** on behalf of the user — always ask them to log in via the browser window
- **Present errors clearly** — when a page or API fails, include the specific URL and error details

### Key Decision Points

1. **Phase 1.3**: If the site is not activated, stop and redirect to `/activate-site`
2. **Phase 1.4**: If no URL can be auto-detected, must ask the user
3. **Phase 3.2**: If the site is private (redirects to identity provider), must ask the user to log in — cannot bypass
4. **Phase 3.5**: If site-level authentication is available, must ask the user whether to log in or skip — cannot auto-login
5. **Phase 4.3**: Stop crawling at 25 pages to prevent infinite loops
6. **Phase 5.5**: Before interacting with forms (which may create/modify data), must get explicit user permission

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Resolve site URL | Resolving site URL | Get URL from user input, activation status check, or context |
| Launch browser and verify initial load | Loading site in browser | Navigate to site, verify homepage loads, capture baseline errors |
| Check authentication requirements | Checking authentication | Detect if site requires auth, handle login if needed |
| Crawl and test all pages | Crawling site pages | Discover links, navigate each page, verify loads, check console errors |
| Test API requests | Testing API endpoints | Capture network requests, verify API responses, analyze errors |
| Generate test report | Generating test report | Present summary of all pages and APIs tested, suggest next steps |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`.

---

**Begin with Phase 1: Resolve Site URL**
