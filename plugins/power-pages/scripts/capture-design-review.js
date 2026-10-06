#!/usr/bin/env node

// Captures a design review in one call: every route at desktop (1440x900) and
// mobile (390x844), with screenshots plus the font, overflow, and page-error checks from
// references/design-critique.md. One call replaces the dozens of single-step browser tool
// calls (navigate, resize, scroll, screenshot, evaluate) that would otherwise each re-send
// the whole conversation.
//
// Usage:
//   node capture-design-review.js --url http://localhost:5173 --routes /,/about [--project-root <path>] [--checks-only]
//   node capture-design-review.js --url https://contoso.powerappsportals.com --discover 6
//   node capture-design-review.js --cleanup <outputDir>
//
// Playwright comes from the project's dev dependency when --project-root has one, and
// otherwise from the plugin's pinned @playwright/mcp package, so nothing is installed.
// Output: JSON on stdout. Exit 0 when the capture ran - findings are data, not failures;
// exit 1 on usage errors or when no browser can be launched.

const fs = require('node:fs');
const path = require('node:path');
const { detectBrowser } = require('./lib/detect-browser');
const { loadPlaywright } = require('./lib/load-playwright');
const { createPrivateTempDir, isOwnTempDir, removeDir, sweepStaleTempDirs } = require('./lib/private-temp-dir');

// Screenshots go to a private temp directory so they never land in the user's project.
const OUTPUT_DIR_PREFIX = 'power-pages-design-review-';
const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};
// A whole mobile page is long and narrow; viewed as one image it is downscaled to an
// unreadable sliver. The sheet cuts it into columns two mobile screens tall, side by side,
// so the full page stays legible in one image. The first column starts at the fold line.
const SHEET_SEGMENT_HEIGHT = VIEWPORTS.mobile.height * 2;
const SHEET_MAX_COLUMNS = 6;
const SHEET_GAP = 16;
const SETTLE_MS = 1200;
const NAVIGATION_TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const parsed = { checksOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url' && argv[i + 1]) parsed.url = argv[++i].replace(/\/+$/, '');
    else if (arg === '--routes' && argv[i + 1]) parsed.routes = argv[++i].split(',').map((r) => r.trim()).filter(Boolean);
    else if (arg === '--project-root' && argv[i + 1]) parsed.projectRoot = argv[++i];
    else if (arg === '--checks-only') parsed.checksOnly = true;
    else if (arg === '--discover' && argv[i + 1]) parsed.discover = Number.parseInt(argv[++i], 10);
    else if (arg === '--cleanup' && argv[i + 1]) parsed.cleanup = argv[++i];
  }
  if (parsed.cleanup) {
    return parsed;
  }
  const hasRoutes = Boolean(parsed.routes && parsed.routes.length > 0);
  const hasDiscover = Number.isInteger(parsed.discover) && parsed.discover > 0;
  if (!parsed.url || hasRoutes === hasDiscover) {
    return { error: 'Usage: node capture-design-review.js --url <base-url> (--routes <comma-separated> | --discover <max-pages>) [--project-root <path>] [--checks-only]\n       node capture-design-review.js --cleanup <outputDir>' };
  }
  return parsed;
}

function slugForRoute(route) {
  const slug = route.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
  return slug || 'home';
}

function buildMobileSheet(base64Png, pageHeight) {
  const columnWidth = VIEWPORTS.mobile.width;
  const needed = Math.max(1, Math.ceil(pageHeight / SHEET_SEGMENT_HEIGHT));
  const columns = Math.min(needed, SHEET_MAX_COLUMNS);
  const height = Math.min(SHEET_SEGMENT_HEIGHT, pageHeight);
  const width = columns * columnWidth + (columns - 1) * SHEET_GAP;
  const cells = [];
  for (let i = 0; i < columns; i++) {
    cells.push(`<div class="col" style="left:${i * (columnWidth + SHEET_GAP)}px;background-position:0 -${i * SHEET_SEGMENT_HEIGHT}px"></div>`);
  }
  const html = `<!doctype html><html><head><style>
html,body{margin:0;background:#8a8a8a}
.col{position:absolute;top:0;width:${columnWidth}px;height:${height}px;background-image:url(data:image/png;base64,${base64Png});background-repeat:no-repeat}
.fold{position:absolute;left:0;top:${VIEWPORTS.mobile.height}px;width:${columnWidth}px;border-top:2px dashed #ff00aa}
</style></head><body>${cells.join('')}<div class="fold"></div></body></html>`;
  return { html, width, height, columns, truncated: needed > SHEET_MAX_COLUMNS };
}

// --- In-page functions (serialized into the browser by page.evaluate) ---

async function scrollThrough() {
  // Content revealed on scroll and lazy images only take their final layout once seen.
  // Instant jumps matter: under `scroll-behavior: smooth`, a plain scrollTo is still
  // animating when the next measurement or capture starts.
  const root = document.documentElement;
  for (let y = 0; y < root.scrollHeight; y += window.innerHeight / 2) {
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
  for (const el of document.querySelectorAll('h1, h2, h3')) {
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

function pageHeight() {
  return document.documentElement.scrollHeight;
}

// Collects the pages a visitor can reach from the start page: primary navigation first, then
// main content, then the footer, same origin only. Sign-out links are skipped so a review
// never ends a signed-in session, and file links are skipped because they are not pages.
function discoverLinks(limit) {
  const start = location.pathname.replace(/\/+$/, '') || '/';
  const routes = [start];
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

// --- Capture ---

async function captureRouteAtWidth({ browser, page, url, route, width, outputDir, checksOnly }) {
  const slug = slugForRoute(route);
  const result = { pageErrors: [] };
  const onPageError = (error) => result.pageErrors.push(String(error && error.message ? error.message : error));
  // Chrome logs a failed fetch as the bare console text "Failed to load resource: ...
  // status of 404", with no URL. The response listener records the URL instead, so the
  // generic console line is skipped to avoid reporting the same failure twice.
  const onConsole = (message) => {
    if (message.type() === 'error' && !/^Failed to load resource/.test(message.text())) result.pageErrors.push(message.text());
  };
  // A missing favicon is /add-seo's job, not a design defect, so its 404 is not reported.
  const onResponse = (response) => {
    if (response.status() >= 400 && !/\/favicon\.ico(\?|$)/.test(response.url())) {
      result.pageErrors.push(`HTTP ${response.status()} ${response.url()}`);
    }
  };
  // DNS and connection failures produce no response at all, only a failed request. Requests
  // the page itself cancelled (net::ERR_ABORTED, e.g. a lazy image dropped on navigation) are
  // routine, so they are not reported.
  const onRequestFailed = (request) => {
    const errorText = (request.failure() || {}).errorText || 'failed';
    if (!/ERR_ABORTED/.test(errorText) && !/\/favicon\.ico(\?|$)/.test(request.url())) {
      result.pageErrors.push(`FAILED ${request.url()} (${errorText})`);
    }
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  try {
    await page.goto(`${url}${route}`, { waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    // A private site or a signed-in page redirects to an identity provider. The headless
    // browser cannot sign in, so the screenshots show a login page rather than the design.
    const landed = new URL(page.url()).origin;
    if (landed !== new URL(url).origin) result.redirectedTo = landed;
    if (!checksOnly) {
      // The first screen is captured before scrolling so it shows what a visitor sees at load.
      result.viewport = path.join(outputDir, `${slug}-${width}.png`);
      await page.screenshot({ path: result.viewport });
    }
    await page.evaluate(scrollThrough);
    result.fonts = await page.evaluate(loadedFonts);
    result.syntheticWeights = await page.evaluate(findSyntheticWeights);
    result.overflow = await page.evaluate(measureOverflow);
    if (!checksOnly) {
      if (width === 'desktop') {
        result.fullPage = path.join(outputDir, `${slug}-desktop-full.png`);
        await page.screenshot({ path: result.fullPage, fullPage: true });
      } else {
        const full = await page.screenshot({ fullPage: true });
        const sheet = buildMobileSheet(Buffer.from(full).toString('base64'), await page.evaluate(pageHeight));
        const sheetPage = await browser.newPage({ viewport: { width: sheet.width, height: sheet.height } });
        try {
          await sheetPage.setContent(sheet.html, { waitUntil: 'load' });
          result.sheet = path.join(outputDir, `${slug}-mobile-sheet.png`);
          await sheetPage.screenshot({ path: result.sheet });
          if (sheet.truncated) result.sheetTruncated = true;
        } finally {
          await sheetPage.close();
        }
      }
    }
  } catch (error) {
    result.captureError = String(error && error.message ? error.message : error);
  } finally {
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }
  return result;
}

async function captureDesignReview({ playwright, channel, url, routes, discover, outputDir, checksOnly }) {
  const browser = await playwright.chromium.launch({ channel, headless: true });
  let base = url;
  let results = (routes || []).map((route) => ({ route }));
  try {
    if (discover) {
      // Discovered links are absolute paths, so captures use the origin as their base; a
      // start URL with a path (e.g. /en-US/) keeps that path as the first route.
      const start = new URL(url);
      base = start.origin;
      const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS });
        // Links on an identity provider's login page are not the site's pages, so a
        // redirected start page yields only itself; its capture records the redirect.
        results = new URL(page.url()).origin === start.origin
          ? (await page.evaluate(discoverLinks, discover)).map((route) => ({ route }))
          : [{ route: start.pathname.replace(/\/+$/, '') || '/' }];
      } finally {
        await page.close();
      }
    }
    for (const [width, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      try {
        for (const entry of results) {
          entry[width] = await captureRouteAtWidth({ browser, page, url: base, route: entry.route, width, outputDir, checksOnly });
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { outputDir: checksOnly ? null : outputDir, baseUrl: base, routes: results, summary: summarize(results) };
}

function summarize(results) {
  const summary = { fonts: [], syntheticWeights: [], overflow: [], pageErrors: [], captureErrors: [], redirects: [], images: [] };
  const fonts = new Set();
  for (const entry of results) {
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
      for (const key of ['viewport', 'fullPage', 'sheet']) {
        if (r[key]) summary.images.push(r[key]);
      }
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
} = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    writeError(`${args.error}\n`);
    return 1;
  }
  if (args.cleanup) {
    if (!isOwnTempDir(args.cleanup, OUTPUT_DIR_PREFIX)) {
      writeError(`Refusing to remove ${args.cleanup}: not a design-review directory in the OS temp directory.\n`);
      return 1;
    }
    removeDir(args.cleanup);
    write(`${JSON.stringify({ removed: args.cleanup })}\n`);
    return 0;
  }
  sweepStaleTempDirs(OUTPUT_DIR_PREFIX);
  const playwright = loadPlaywrightFn(args.projectRoot);
  if (!playwright) {
    writeError('Playwright could not be loaded from the project or from the pinned @playwright/mcp package. Check that npm can reach its registry.\n');
    return 1;
  }
  const outputDir = args.checksOnly ? null : createPrivateTempDir(OUTPUT_DIR_PREFIX);
  try {
    const result = await captureDesignReview({
      playwright, channel: channel(), url: args.url, routes: args.routes, discover: args.discover, outputDir, checksOnly: args.checksOnly,
    });
    write(`${JSON.stringify(result, null, 1)}\n`);
    return 0;
  } catch (error) {
    removeDir(outputDir);
    writeError(`Design review capture failed: ${error.message}\n`);
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
  buildMobileSheet,
  captureDesignReview,
  findSyntheticWeights,
  discoverLinks,
  loadedFonts,
  main,
  measureOverflow,
  pageHeight,
  parseArgs,
  scrollThrough,
  slugForRoute,
  summarize,
};
