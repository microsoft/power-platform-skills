#!/usr/bin/env node

// Captures a design review in one call: every route at desktop (1440x900) and
// mobile (390x844), with screenshots plus the font, overflow, and page-error checks from
// references/design-critique.md. One call replaces the dozens of single-step browser tool
// calls (navigate, resize, scroll, screenshot, evaluate) that would otherwise each re-send
// the whole conversation.
//
// Usage:
//   node capture-design-review.js --url http://localhost:5173 --routes /,/about [--checks-only] [--axe]
//   node capture-design-review.js --url https://contoso.powerappsportals.com --discover 6
//   node capture-design-review.js --input - [--axe]   (request as JSON on stdin; see REQUEST_FIELDS)
//   node capture-design-review.js --cleanup <outputDir>   (or {"cleanup": "<outputDir>"} on stdin)
//
// --axe also runs the axe-core accessibility audit (axe-audit.js) on every captured route that
// did not redirect to sign-in, so routes discovered on an untrusted page reach the audit
// without the agent copying them into another shell command.
//
// Playwright is the one inside the plugin's pinned @playwright/mcp package, from npm's cache
// (lib/load-playwright.js); nothing is installed into, or loaded from, the project.
// Output: JSON on stdout. Exit 0 when the capture ran - findings are data, not failures;
// exit 1 on usage errors or when no browser can be launched.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { detectBrowser } = require('./lib/detect-browser');
const { loadPlaywright } = require('./lib/load-playwright');
const { auditRoutes, loadAxeSource } = require('./axe-audit');
const {
  gotoSettled, isBoolean, isString, isStringList, normalizeSiteUrl, parseRequest, parseRouteList, redactUrl, redactUrlsInText,
} = require('./lib/review-navigation');
const { createPrivateTempDir, isOwnTempDir, removeDir, sweepStaleTempDirs } = require('./lib/private-temp-dir');

// Screenshots go to a private temp directory so they never land in the user's project.
const OUTPUT_DIR_PREFIX = 'power-pages-design-review-';
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};
// A whole mobile page is long and narrow; viewed as one image it is downscaled to an
// unreadable sliver. A sheet cuts it into columns two mobile screens tall, side by side,
// so the page stays legible. Six columns keep a sheet readable; a longer page continues on
// further sheets so its closing sections are never dropped. Past SHEET_MAX_SHEETS (about
// 30,000 px - an endless feed rather than a page) the rest is reported as truncated.
const SHEET_SEGMENT_HEIGHT = VIEWPORTS.mobile.height * 2;
const SHEET_MAX_COLUMNS = 6;
const SHEET_MAX_SHEETS = 3;
// The deepest any capture looks, about 30,000 px. Scrolling and the desktop full-page image
// stop here, so an endless feed - which grows each time the bottom comes into view - cannot
// keep the capture running forever.
const MAX_CAPTURE_HEIGHT = SHEET_MAX_SHEETS * SHEET_MAX_COLUMNS * SHEET_SEGMENT_HEIGHT;
const SCROLL_BUDGET_MS = 15000;
// How many same-origin links discovery collects, so it can report the pages it found but
// did not capture without letting a link-heavy page grow the output without bound.
const DISCOVERY_SCAN_LIMIT = 60;
const SHEET_GAP = 16;
const SETTLE_MS = 1200;

const USAGE = 'Usage: node capture-design-review.js --url <base-url> (--routes <comma-separated> | --discover <max-pages>) [--checks-only] [--axe]\n'
  + '       node capture-design-review.js --input - [--axe]   (JSON request on stdin: url, routes | discover, checksOnly, axe, or cleanup)\n'
  + '       node capture-design-review.js --cleanup <outputDir>';

// Fields a `--input -` request may carry (see parseRequest in lib/review-navigation.js).
const REQUEST_FIELDS = {
  url: isString,
  routes: isStringList,
  discover: Number.isInteger,
  checksOnly: isBoolean,
  axe: isBoolean,
  cleanup: isString,
};

function parseArgs(argv, { readStdin = () => fs.readFileSync(0, 'utf8') } = {}) {
  let parsed = { checksOnly: false };
  let fromStdin = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url' && argv[i + 1]) parsed.url = argv[++i];
    else if (arg === '--routes' && argv[i + 1]) parsed.routes = parseRouteList(argv[++i]);
    else if (arg === '--checks-only') parsed.checksOnly = true;
    else if (arg === '--axe') parsed.axe = true;
    else if (arg === '--discover' && argv[i + 1]) parsed.discover = Number.parseInt(argv[++i], 10);
    else if (arg === '--cleanup' && argv[i + 1]) parsed.cleanup = argv[++i];
    else if (arg === '--input' && argv[i + 1] === '-') { fromStdin = true; i++; }
  }
  if (fromStdin) {
    const { request, error } = parseRequest(readStdin(), REQUEST_FIELDS);
    if (error) return { error };
    parsed = { ...parsed, ...request };
    if (request.routes) parsed.routes = parseRouteList(request.routes);
  }
  if (parsed.cleanup) {
    return { cleanup: parsed.cleanup };
  }
  const hasRoutes = Boolean(parsed.routes && parsed.routes.length > 0);
  const hasDiscover = Number.isInteger(parsed.discover) && parsed.discover > 0;
  if (!parsed.url || hasRoutes === hasDiscover) {
    return { error: USAGE };
  }
  const site = normalizeSiteUrl(parsed.url);
  if (site.error) return { error: site.error };
  parsed.url = site.url;
  return parsed;
}

function slugForRoute(route) {
  const slug = route.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
  return slug || 'home';
}

// Screenshot names come from the route, but different routes can share a slug -
// /help/Moving-Home/ and /help-moving-home both become "help-moving-home" - and the later
// capture would overwrite the earlier one's files. The first route keeps the readable slug;
// a later one gets a suffix derived from its exact route text, so names stay stable.
function uniqueSlugs(routes) {
  const used = new Set();
  return routes.map((route) => {
    const base = slugForRoute(route);
    let slug = base;
    if (used.has(slug)) {
      slug = `${base}-${crypto.createHash('sha256').update(route).digest('hex').slice(0, 8)}`;
      for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    }
    used.add(slug);
    return slug;
  });
}

// Splits a mobile page of `pageHeight` px into sheets of column clips, each column one
// SHEET_SEGMENT_HEIGHT slice of the page. `truncated` says the page ran past the last sheet.
function planMobileSheets(pageHeight) {
  const needed = Math.max(1, Math.ceil(pageHeight / SHEET_SEGMENT_HEIGHT));
  const kept = Math.min(needed, SHEET_MAX_SHEETS * SHEET_MAX_COLUMNS);
  const sheets = [];
  for (let i = 0; i < kept; i++) {
    if (i % SHEET_MAX_COLUMNS === 0) sheets.push([]);
    const y = i * SHEET_SEGMENT_HEIGHT;
    sheets[sheets.length - 1].push({ x: 0, y, width: VIEWPORTS.mobile.width, height: Math.min(SHEET_SEGMENT_HEIGHT, pageHeight - y) });
  }
  return { sheets, truncated: needed > kept };
}

// Lays column screenshots (base64 PNGs, top to bottom) side by side. Each column is its own
// clipped capture rather than one slice of a single full-page image: Chrome renders a very
// tall image (about 16,000 px and up) wrongly, repeating the top of the page where its end
// should be. Only the sheet that starts at the top of the page gets the dashed fold line.
function buildMobileSheet(columns, { fold = true } = {}) {
  const columnWidth = VIEWPORTS.mobile.width;
  const height = Math.min(SHEET_SEGMENT_HEIGHT, Math.max(...columns.map((c) => c.height)));
  const width = columns.length * columnWidth + (columns.length - 1) * SHEET_GAP;
  const cells = columns.map((column, i) => `<img class="col" style="left:${i * (columnWidth + SHEET_GAP)}px;height:${column.height}px" src="data:image/png;base64,${column.base64}">`);
  const html = `<!doctype html><html><head><style>
html,body{margin:0;background:#8a8a8a}
.col{position:absolute;top:0;width:${columnWidth}px;display:block}
.fold{position:absolute;left:0;top:${VIEWPORTS.mobile.height}px;width:${columnWidth}px;border-top:2px dashed #ff00aa}
</style></head><body>${cells.join('')}${fold ? '<div class="fold"></div>' : ''}</body></html>`;
  return { html, width, height };
}

// --- In-page functions (serialized into the browser by page.evaluate) ---

async function scrollThrough({ maxHeight, budgetMs }) {
  // Content revealed on scroll and lazy images only take their final layout once seen.
  // Instant jumps matter: under `scroll-behavior: smooth`, a plain scrollTo is still
  // animating when the next measurement or capture starts. scrollHeight is read on every
  // step because the page can grow while scrolling; the height and time limits end the loop
  // on a feed that never stops growing.
  const root = document.documentElement;
  const deadline = Date.now() + budgetMs;
  for (let y = 0; y < Math.min(root.scrollHeight, maxHeight) && Date.now() < deadline; y += window.innerHeight / 2) {
    window.scrollTo({ top: y, behavior: 'instant' });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  await new Promise((resolve) => setTimeout(resolve, 600));
}

async function loadedFonts() {
  // document.fonts.check() reports true for a family that never loaded, so list the
  // faces that actually finished loading instead.
  await document.fonts.ready;
  return [...new Set([...document.fonts]
    .filter((face) => face.status === 'loaded')
    .map((face) => face.family.replace(/["']/g, '')))];
}

// Headings set at a weight the loaded family does not ship are drawn in a browser-faked bold.
// The loaded-family list cannot show that, so compare each heading's computed weight with the
// weights its family actually loaded. FontFace.weight is a single value ("400", "bold") for a
// static face or a range ("100 900") for a variable one.
function findSyntheticWeights() {
  const toNumber = (value) => ({ normal: 400, bold: 700 }[value] || Number(value));
  const faces = [...document.fonts].filter((face) => face.status === 'loaded');
  const found = new Set();
  for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const style = getComputedStyle(el);
    const family = style.fontFamily.split(',')[0].trim().replace(/["']/g, '');
    const weight = toNumber(style.fontWeight);
    const familyFaces = faces.filter((face) => face.family.replace(/["']/g, '') === family);
    const covered = familyFaces.some((face) => {
      const [low, high = low] = String(face.weight).split(/\s+/).map(toNumber);
      return weight >= low && weight <= high;
    });
    if (familyFaces.length && !covered) found.add(`${el.tagName.toLowerCase()}: ${family} ${weight}`);
  }
  return [...found];
}

function measureOverflow() {
  const root = document.documentElement;
  if (root.scrollWidth <= root.clientWidth) return { overflow: false };
  // Off-canvas fixed menus and carousels clipped by an ancestor also extend past the
  // edge without causing scroll, so culprits are listed only once the page really scrolls
  // sideways. An empty list means a pseudo-element or a 100vw width is responsible.
  const culprits = [...document.querySelectorAll('body *')]
    .filter((el) => el.getBoundingClientRect().right > root.clientWidth + 1)
    .slice(0, 10)
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...el.classList].map((c) => '.' + c).join('')}`);
  return { overflow: true, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, culprits };
}

// Some layouts scroll inside an element rather than the page - `html, body { height: 100%;
// overflow: hidden }` with a scrolling #root, or an app shell's content pane. The document
// is then exactly one screen tall, so full-page images show only the first screen. Returns a
// selector for the largest such scroller, or null when the page itself scrolls.
function findInnerScroller() {
  const root = document.documentElement;
  if (root.scrollHeight > window.innerHeight + 1) return null;
  let best = null;
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (!/(auto|scroll)/.test(style.overflowY) || el.scrollHeight <= el.clientHeight + 100) continue;
    if (el.clientHeight < window.innerHeight / 2) continue;
    if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth) best = el;
  }
  if (!best) return null;
  return `${best.tagName.toLowerCase()}${best.id ? '#' + best.id : ''}${[...best.classList].slice(0, 3).map((c) => '.' + c).join('')}`;
}

function pageHeight() {
  return document.documentElement.scrollHeight;
}

// Collects the pages a visitor can reach from the start page, in priority order: the start
// page, then primary navigation, then main content, then the footer, same origin only.
// Sign-out links are skipped so a review never ends a signed-in session, and file links are
// skipped because they are not pages. Returns up to `limit` routes; the caller captures the
// first `discover` of them and reports the rest as found but not captured.
function discoverLinks(limit) {
  const start = location.pathname.replace(/\/+$/, '') || '/';
  const routes = [start];
  if (routes.length >= limit) return routes;
  const skip = /(sign-?out|log-?out|log-?off)|\.(pdf|png|jpe?g|gif|svg|webp|zip|docx?|xlsx?|pptx?)$/i;
  for (const selector of ['header a[href], nav a[href]', 'main a[href]', 'footer a[href]']) {
    for (const anchor of document.querySelectorAll(selector)) {
      let url;
      try {
        url = new URL(anchor.getAttribute('href'), location.href);
      } catch {
        continue;
      }
      if (url.origin !== location.origin || skip.test(url.pathname)) continue;
      const route = url.pathname.replace(/\/+$/, '') || '/';
      if (!routes.includes(route)) routes.push(route);
      if (routes.length >= limit) return routes;
    }
  }
  return routes;
}

// Sign-in pages the site serves itself, e.g. /SignIn?returnUrl=... or /Account/Login.
const SIGN_IN_PATH = /(^|\/)(sign-?in|log-?in|account\/login|\.auth\/login)(\/|$)/i;
// Identity providers Power Pages sites commonly send visitors to: Microsoft Entra ID,
// Entra External ID and Azure AD B2C, Microsoft accounts, and common third-party providers.
const IDENTITY_PROVIDER_HOST = /(^|\.)(login\.microsoftonline\.com|login\.microsoft\.com|login\.windows\.net|login\.live\.com|b2clogin\.com|ciamlogin\.com|accounts\.google\.com|okta\.com|auth0\.com)$/i;

function hasPasswordField() {
  return Boolean(document.querySelector('input[type="password"]'));
}

// Decides what a navigation that ended at `landedUrl` shows, for a request to `requestedUrl`:
// - 'sign-in': a login form, which the headless browser cannot get past - the site's own
//   sign-in path, an identity provider's host, or any page with a password field on a host
//   the request did not name.
// - 'same-site': the site, including canonical redirects (http -> https, apex <-> www).
// - 'moved': the site forwards to another host that is not a login, e.g. a vanity domain to
//   the portal's real address; the page shown is still the site, so it is captured as is.
function classifyLanding(requestedUrl, landedUrl, { passwordField = false } = {}) {
  const requested = new URL(requestedUrl);
  const landed = new URL(landedUrl);
  const site = (u) => u.host.toLowerCase().replace(/^www\./, '');
  const signInPath = SIGN_IN_PATH.test(landed.pathname) && !SIGN_IN_PATH.test(requested.pathname);
  if (site(requested) === site(landed)) return signInPath ? 'sign-in' : 'same-site';
  if (signInPath || passwordField || IDENTITY_PROVIDER_HOST.test(landed.hostname)) return 'sign-in';
  return 'moved';
}

// Reads where `page` landed after a navigation to `requestedUrl`, checking for a password field
// only when the page left the requested host.
async function landingOf(page, requestedUrl) {
  const landed = page.url();
  const leftHost = new URL(landed).host.replace(/^www\./i, '') !== new URL(requestedUrl).host.replace(/^www\./i, '');
  const passwordField = leftHost ? await page.evaluate(hasPasswordField) : false;
  return { landed, kind: classifyLanding(requestedUrl, landed, { passwordField }) };
}

// --- Capture ---

async function captureRouteAtWidth({ browser, page, url, route, slug = slugForRoute(route), width, outputDir, checksOnly }) {
  const result = { pageErrors: [] };
  const onPageError = (error) => result.pageErrors.push(redactUrlsInText(error && error.message ? error.message : error));
  // Chrome logs a failed fetch as the bare console text "Failed to load resource: ...
  // status of 404", with no URL. The response listener records the URL instead, so the
  // generic console line is skipped to avoid reporting the same failure twice.
  const onConsole = (message) => {
    if (message.type() === 'error' && !/^Failed to load resource/.test(message.text())) result.pageErrors.push(redactUrlsInText(message.text()));
  };
  // A missing favicon is /add-seo's job, not a design defect, so its 404 is not reported.
  const onResponse = (response) => {
    if (response.status() >= 400 && !/\/favicon\.ico(\?|$)/.test(response.url())) {
      result.pageErrors.push(`HTTP ${response.status()} ${redactUrl(response.url())}`);
    }
  };
  // DNS and connection failures produce no response at all, only a failed request. Requests
  // the page itself cancelled (net::ERR_ABORTED, e.g. a lazy image dropped on navigation) are
  // routine, so they are not reported.
  const onRequestFailed = (request) => {
    const errorText = (request.failure() || {}).errorText || 'failed';
    if (!/ERR_ABORTED/.test(errorText) && !/\/favicon\.ico(\?|$)/.test(request.url())) {
      result.pageErrors.push(`FAILED ${redactUrl(request.url())} (${errorText})`);
    }
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  try {
    await gotoSettled(page, `${url}${route}`, { settleMs: SETTLE_MS });
    // The query is dropped from the reported URL: sign-in redirects carry state, nonce,
    // and return-URL parameters that add noise and say nothing about the design.
    const { landed, kind } = await landingOf(page, `${url}${route}`);
    if (kind === 'sign-in') result.redirectedTo = redactUrl(landed);
    if (!checksOnly) {
      // The first screen is captured before scrolling so it shows what a visitor sees at load.
      result.viewport = path.join(outputDir, `${slug}-${width}.png`);
      await page.screenshot({ path: result.viewport });
    }
    await page.evaluate(scrollThrough, { maxHeight: MAX_CAPTURE_HEIGHT, budgetMs: SCROLL_BUDGET_MS });
    const innerScroller = await page.evaluate(findInnerScroller);
    if (innerScroller) result.innerScroll = innerScroller;
    result.fonts = await page.evaluate(loadedFonts);
    result.syntheticWeights = await page.evaluate(findSyntheticWeights);
    result.overflow = await page.evaluate(measureOverflow);
    if (!checksOnly) {
      if (width === 'desktop') {
        result.fullPage = path.join(outputDir, `${slug}-desktop-full.png`);
        const height = await page.evaluate(pageHeight);
        if (height > MAX_CAPTURE_HEIGHT) {
          result.fullPageTruncated = true;
          await page.screenshot({ path: result.fullPage, fullPage: true, clip: { x: 0, y: 0, width: VIEWPORTS.desktop.width, height: MAX_CAPTURE_HEIGHT } });
        } else {
          await page.screenshot({ path: result.fullPage, fullPage: true });
        }
      } else {
        const plan = planMobileSheets(await page.evaluate(pageHeight));
        result.sheets = [];
        for (const [index, clips] of plan.sheets.entries()) {
          const columns = [];
          for (const clip of clips) {
            // `fullPage` makes `clip` document-relative. Without it Playwright measures the
            // clip from the viewport and throws "Clipped area is either empty or outside the
            // resulting image" for any column below the first screen (checked on 1.62 and 1.63).
            const shot = await page.screenshot({ fullPage: true, clip });
            columns.push({ base64: Buffer.from(shot).toString('base64'), height: clip.height });
          }
          const sheet = buildMobileSheet(columns, { fold: index === 0 });
          const sheetPage = await browser.newPage({ viewport: { width: sheet.width, height: sheet.height } });
          try {
            await sheetPage.setContent(sheet.html, { waitUntil: 'load' });
            const sheetPath = path.join(outputDir, `${slug}-mobile-sheet${index === 0 ? '' : `-${index + 1}`}.png`);
            await sheetPage.screenshot({ path: sheetPath });
            result.sheets.push(sheetPath);
          } finally {
            await sheetPage.close();
          }
        }
        if (plan.truncated) result.sheetTruncated = true;
      }
    }
  } catch (error) {
    result.captureError = redactUrlsInText(error && error.message ? error.message : error);
  } finally {
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }
  return result;
}

async function captureDesignReview({
  playwright, channel, url, routes, discover, outputDir, checksOnly, axe = false,
  auditFn = auditRoutes, loadAxeSourceFn = loadAxeSource,
}) {
  const browser = await playwright.chromium.launch({ channel, headless: true });
  let base = url;
  let results = (routes || []).map((route) => ({ route }));
  let omittedRoutes = [];
  try {
    if (discover) {
      // Discovered links are absolute paths, so captures use the origin as their base; a
      // start URL with a path (e.g. /en-US/) keeps that path as the first route.
      const start = new URL(url);
      base = start.origin;
      const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
      try {
        await gotoSettled(page, url);
        const { landed, kind } = await landingOf(page, url);
        if (kind !== 'sign-in') {
          // A canonical redirect (http -> https, apex <-> www) or a move to the site's real
          // host is still the site, so discovery continues from where the browser landed and
          // later captures use that origin.
          base = new URL(landed).origin;
          const found = await page.evaluate(discoverLinks, DISCOVERY_SCAN_LIMIT);
          results = found.slice(0, discover).map((route) => ({ route }));
          omittedRoutes = found.slice(discover);
        } else {
          // Links on a login page are not the site's pages, so a start page that needs
          // sign-in yields only itself; its capture records the redirect.
          results = [{ route: start.pathname.replace(/\/+$/, '') || '/' }];
        }
      } finally {
        await page.close();
      }
    }
    const slugs = uniqueSlugs(results.map((entry) => entry.route));
    for (const [width, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      try {
        for (const [index, entry] of results.entries()) {
          entry[width] = await captureRouteAtWidth({ browser, page, url: base, route: entry.route, slug: slugs[index], width, outputDir, checksOnly });
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  const summary = summarize(results);
  // Pages discovery found beyond the `discover` limit, so a review can say what it left out.
  summary.omittedRoutes = omittedRoutes;
  const output = { outputDir: checksOnly ? null : outputDir, baseUrl: base, routes: results, summary };
  if (axe) {
    // A route that landed on a sign-in page would only audit the login form.
    const auditable = results.filter((e) => !(e.desktop && e.desktop.redirectedTo)).map((e) => e.route);
    try {
      const axeSource = await loadAxeSourceFn();
      output.accessibility = auditable.length ? await auditFn({ playwright, channel, url: base, routes: auditable, axeSource }) : [];
      summary.accessibility = summarizeAccessibility(output.accessibility);
    } catch (error) {
      output.accessibility = [];
      summary.accessibility = { error: redactUrlsInText(error.message), violations: [], unaudited: auditable };
    }
  }
  return output;
}

// One line per violation, critical and serious first, so the summary stays scannable:
//   "/contact: label (critical, 2 elements)"
function summarizeAccessibility(audit) {
  const rank = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const violations = [];
  const unaudited = [];
  for (const r of audit) {
    if (r.error) unaudited.push(`${r.route}: ${r.error.split('\n')[0]}`);
    for (const v of r.violations) {
      violations.push({ rank: rank[v.impact] ?? 4, text: `${r.route}: ${v.id} (${v.impact}, ${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'})` });
    }
  }
  violations.sort((a, b) => a.rank - b.rank);
  return { violations: violations.map((v) => v.text), unaudited };
}

function summarize(results) {
  const summary = {
    captured: 0, fonts: [], syntheticWeights: [], overflow: [], pageErrors: [], captureErrors: [], redirects: [], truncated: [], innerScroll: [], images: [],
  };
  const fonts = new Set();
  for (const entry of results) {
    // A route counts as captured when it loaded at some width without being sent to sign in.
    if (Object.keys(VIEWPORTS).some((w) => entry[w] && !entry[w].captureError && !entry[w].redirectedTo)) summary.captured += 1;
    for (const width of Object.keys(VIEWPORTS)) {
      const r = entry[width];
      if (!r) continue;
      (r.fonts || []).forEach((f) => fonts.add(f));
      (r.syntheticWeights || []).forEach((w) => {
        if (!summary.syntheticWeights.includes(w)) summary.syntheticWeights.push(w);
      });
      if (r.overflow && r.overflow.overflow) summary.overflow.push(`${entry.route} @ ${width}`);
      if (r.pageErrors && r.pageErrors.length) summary.pageErrors.push(`${entry.route} @ ${width}: ${r.pageErrors.length}`);
      if (r.captureError) summary.captureErrors.push(`${entry.route} @ ${width}: ${r.captureError}`);
      if (r.redirectedTo) summary.redirects.push(`${entry.route} @ ${width} -> ${r.redirectedTo}`);
      if (r.sheetTruncated || r.fullPageTruncated) summary.truncated.push(`${entry.route} @ ${width}`);
      if (r.innerScroll) summary.innerScroll.push(`${entry.route} @ ${width}: ${r.innerScroll}`);
      for (const key of ['viewport', 'fullPage']) {
        if (r[key]) summary.images.push(r[key]);
      }
      summary.images.push(...(r.sheets || []));
    }
  }
  summary.fonts = [...fonts].sort();
  return summary;
}

async function main(argv = process.argv.slice(2), {
  write = (s) => process.stdout.write(s),
  writeError = (s) => process.stderr.write(s),
  loadPlaywrightFn = loadPlaywright,
  channel = detectBrowser,
  removeDirFn = removeDir,
  readStdin,
  auditFn,
  loadAxeSourceFn,
} = {}) {
  const args = parseArgs(argv, { readStdin });
  if (args.error) {
    writeError(`${args.error}\n`);
    return 1;
  }
  if (args.cleanup) {
    if (!isOwnTempDir(args.cleanup, OUTPUT_DIR_PREFIX)) {
      writeError(`Refusing to remove ${args.cleanup}: not a design-review directory in the OS temp directory.\n`);
      return 1;
    }
    // removeDir swallows errors so a failed cleanup never masks a capture result. Here the
    // removal is the whole job, so check the outcome: a locked file (common on Windows while
    // an image viewer holds it) would otherwise leave screenshots behind under a success report.
    removeDirFn(args.cleanup);
    if (fs.existsSync(args.cleanup)) {
      writeError(`Could not remove ${args.cleanup}. Close anything using its files and run --cleanup again, or delete the directory.\n`);
      return 1;
    }
    write(`${JSON.stringify({ removed: args.cleanup })}\n`);
    return 0;
  }
  sweepStaleTempDirs(OUTPUT_DIR_PREFIX);
  const playwright = loadPlaywrightFn();
  if (!playwright) {
    writeError('Playwright could not be loaded from the pinned @playwright/mcp package. Check that npm can reach its registry.\n');
    return 1;
  }
  const outputDir = args.checksOnly ? null : createPrivateTempDir(OUTPUT_DIR_PREFIX);
  try {
    const result = await captureDesignReview({
      playwright, channel: channel(), url: args.url, routes: args.routes, discover: args.discover, outputDir, checksOnly: args.checksOnly,
      axe: Boolean(args.axe), auditFn, loadAxeSourceFn,
    });
    write(`${JSON.stringify(result, null, 1)}\n`);
    return 0;
  } catch (error) {
    removeDir(outputDir);
    writeError(`Design review capture failed: ${redactUrlsInText(error.message)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = {
  OUTPUT_DIR_PREFIX,
  SHEET_SEGMENT_HEIGHT,
  VIEWPORTS,
  SHEET_MAX_COLUMNS,
  SHEET_MAX_SHEETS,
  MAX_CAPTURE_HEIGHT,
  DISCOVERY_SCAN_LIMIT,
  buildMobileSheet,
  planMobileSheets,
  captureDesignReview,
  classifyLanding,
  findInnerScroller,
  hasPasswordField,
  findSyntheticWeights,
  discoverLinks,
  loadedFonts,
  main,
  measureOverflow,
  redactUrl,
  redactUrlsInText,
  summarizeAccessibility,
  pageHeight,
  parseArgs,
  scrollThrough,
  slugForRoute,
  uniqueSlugs,
  summarize,
};
