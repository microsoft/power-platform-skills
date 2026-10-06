// Shared input handling, navigation, and output redaction for the browser review scripts
// (capture-design-review.js and axe-audit.js), so both accept the same request, load a page the
// same way, and keep tokens in URLs out of what they report.

const NAVIGATION_TIMEOUT_MS = 20000;
// How long to wait for the network to go quiet after `load` before giving up and judging the
// page as it is. Long enough for an SPA's first data fetches and web fonts on a normal site.
const NETWORK_IDLE_GRACE_MS = 5000;

// Validates a site URL taken from a user or a page before any browser is pointed at it.
// Only http(s) is a website; file:, data:, and javascript: URLs are rejected. Credentials in
// the URL are rejected too, because the URL is echoed into the JSON the agent reads.
// Returns the URL without trailing slashes, ready to have a route appended.
function normalizeSiteUrl(value) {
  const text = String(value || '').trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { error: `Not a valid URL: ${text}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `Only http and https URLs can be reviewed, not ${parsed.protocol}` };
  }
  if (parsed.username || parsed.password) {
    return { error: 'Remove the user name and password from the URL; the review cannot sign in.' };
  }
  return { url: text.replace(/\/+$/, '') };
}

// Turns a --routes value such as "/, about,/contact/" into ["/", "/about", "/contact/"].
// A route without a leading slash would be glued onto the base URL as
// "http://localhost:5173about", so every entry is anchored to the site root.
function parseRouteList(value) {
  return (Array.isArray(value) ? value.map(String) : String(value || '').split(','))
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

// Reads the request a caller sends on stdin with `--input -`, e.g.
//   {"url": "https://contoso.example/?lang=en&x=1", "discover": 6}
// A site URL, a folder path, or routes from a user, a dev server's output, or a page can hold
// characters a shell would act on (`&`, `;`, `$(...)`, quotes, a `$` in a Windows user name).
// Sent as JSON in a quoted heredoc they stay data: the shell never parses them. `fields` maps
// each allowed key to a type check; any other key, or a value of the wrong type, fails closed.
function parseRequest(text, fields) {
  let request;
  try {
    request = JSON.parse(text);
  } catch (error) {
    return { error: `The stdin request is not valid JSON: ${error.message}` };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { error: 'The stdin request must be a JSON object.' };
  }
  for (const [key, value] of Object.entries(request)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return { error: `Unknown field in the stdin request: ${key}` };
    if (!fields[key](value)) return { error: `Field ${key} in the stdin request has the wrong type.` };
  }
  return { request };
}

const isString = (v) => typeof v === 'string';
const isStringList = (v) => Array.isArray(v) && v.every(isString);
const isBoolean = (v) => typeof v === 'boolean';

// Reported URLs keep their origin and path and drop the rest. Query strings and fragments on
// real sites carry tokens - signed storage URLs (`?sv=...&sig=...`), signed preview links,
// session ids - and this output is read into the agent's conversation.
//   https://contoso.blob.core.windows.net/media/hero.jpg?sv=2024&sig=abc  ->  https://contoso.blob.core.windows.net/media/hero.jpg
//   data:image/png;base64,iVBOR...                                       ->  data:
function redactUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return parsed.protocol;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(value);
  }
}

// Error and console messages quote URLs inside other text, e.g. Playwright's
//   page.goto: net::ERR_ABORTED at https://contoso.example/p?sig=abc
//   Call log:
//     - navigating to "https://contoso.example/p?sig=abc", waiting until "load"
// A URL ends at whitespace, a quote, or a bracket, so those characters bound the match.
function redactUrlsInText(text) {
  return String(text).replace(/\bhttps?:\/\/[^\s'"<>()]+/g, redactUrl);
}

module.exports = {
  NAVIGATION_TIMEOUT_MS,
  NETWORK_IDLE_GRACE_MS,
  gotoSettled,
  isBoolean,
  isString,
  isStringList,
  normalizeSiteUrl,
  parseRequest,
  parseRouteList,
  redactUrl,
  redactUrlsInText,
};
