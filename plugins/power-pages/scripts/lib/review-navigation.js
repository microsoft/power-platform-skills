// Shared navigation and route parsing for the browser review scripts (capture-design-review.js
// and axe-audit.js), so both load a page the same way and accept the same --routes input.

const NAVIGATION_TIMEOUT_MS = 20000;
// How long to wait for the network to go quiet after `load` before giving up and judging the
// page as it is. Long enough for an SPA's first data fetches and web fonts on a normal site.
const NETWORK_IDLE_GRACE_MS = 5000;

// Turns a --routes value such as "/, about,/contact/" into ["/", "/about", "/contact/"].
// A route without a leading slash would be glued onto the base URL as
// "http://localhost:5173about", so every entry is anchored to the site root.
function parseRouteList(value) {
  return String(value || '')
    .split(',')
    .map((route) => route.trim())
    .filter(Boolean)
    .map((route) => (route.startsWith('/') ? route : `/${route}`));
}

// Navigates and waits until the page is worth judging. Navigation succeeds at `load`; the
// network-idle wait after it is best effort. Playwright discourages `waitUntil: 'networkidle'`
// as a navigation condition, and a site that keeps a request open (long polling) or fires
// analytics beacons every few hundred milliseconds never reaches it, so the whole navigation
// timed out and the route went unreviewed. A quiet site still gets its late fetches and fonts
// in before the settle delay. See: https://playwright.dev/docs/api/class-page#page-goto
async function gotoSettled(page, url, { settleMs, timeout = NAVIGATION_TIMEOUT_MS, idleGraceMs = NETWORK_IDLE_GRACE_MS } = {}) {
  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForLoadState('networkidle', { timeout: idleGraceMs }).catch(() => {});
  if (settleMs) {
    await page.waitForTimeout(settleMs);
  }
}

module.exports = {
  NAVIGATION_TIMEOUT_MS,
  NETWORK_IDLE_GRACE_MS,
  gotoSettled,
  parseRouteList,
};
