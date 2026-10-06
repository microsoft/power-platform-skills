#!/usr/bin/env node

// Captures a create-site design review in one call: every route at desktop (1440x900) and
// mobile (390x844), with screenshots plus the font, overflow, and page-error checks from
// references/design-critique.md. One call replaces the dozens of single-step browser tool
// calls (navigate, resize, scroll, screenshot, evaluate) that would otherwise each re-send
// the whole conversation.
//
// Usage:
//   node capture-design-review.js --url http://localhost:5173 --routes /,/about --project-root <path> [--checks-only]
//   node capture-design-review.js --cleanup <outputDir>
//
// Prerequisites: npm install --save-dev playwright (in the project directory).
// Output: JSON on stdout. Exit 0 when the capture ran - findings are data, not failures;
// exit 1 on usage errors or when no browser can be launched.

const fs = require('node:fs');
const path = require('node:path');
const { detectBrowser } = require('../../../scripts/lib/detect-browser');
const { loadProjectPlaywright } = require('../../../scripts/lib/load-project-playwright');
const { createPrivateTempDir, isOwnTempDir, removeDir, sweepStaleTempDirs } = require('../../../scripts/lib/private-temp-dir');

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
    else if (arg === '--cleanup' && argv[i + 1]) parsed.cleanup = argv[++i];
  }
  if (parsed.cleanup) {
    return parsed;
  }
  if (!parsed.url || !parsed.routes || parsed.routes.length === 0 || !parsed.projectRoot) {
    return { error: 'Usage: node capture-design-review.js --url <base-url> --routes <comma-separated> --project-root <path> [--checks-only]\n       node capture-design-review.js --cleanup <outputDir>' };
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
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('response', onResponse);
  try {
    await page.goto(`${url}${route}`, { waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    if (!checksOnly) {
      // The first screen is captured before scrolling so it shows what a visitor sees at load.
      result.viewport = path.join(outputDir, `${slug}-${width}.png`);
      await page.screenshot({ path: result.viewport });
    }
    await page.evaluate(scrollThrough);
    result.fonts = await page.evaluate(loadedFonts);
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
  }
  return result;
}

async function captureDesignReview({ playwright, channel, url, routes, outputDir, checksOnly }) {
  const browser = await playwright.chromium.launch({ channel, headless: true });
  const results = routes.map((route) => ({ route }));
  try {
    for (const [width, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      try {
        for (const entry of results) {
          entry[width] = await captureRouteAtWidth({ browser, page, url, route: entry.route, width, outputDir, checksOnly });
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { outputDir: checksOnly ? null : outputDir, routes: results, summary: summarize(results) };
}

function summarize(results) {
  const summary = { fonts: [], overflow: [], pageErrors: [], captureErrors: [], images: [] };
  const fonts = new Set();
  for (const entry of results) {
    for (const width of Object.keys(VIEWPORTS)) {
      const r = entry[width];
      if (!r) continue;
      (r.fonts || []).forEach((f) => fonts.add(f));
      if (r.overflow && r.overflow.overflow) summary.overflow.push(`${entry.route} @ ${width}`);
      if (r.pageErrors && r.pageErrors.length) summary.pageErrors.push(`${entry.route} @ ${width}: ${r.pageErrors.length}`);
      if (r.captureError) summary.captureErrors.push(`${entry.route} @ ${width}: ${r.captureError}`);
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
  loadPlaywright = loadProjectPlaywright,
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
  const playwright = loadPlaywright(args.projectRoot);
  if (!playwright) {
    writeError('playwright not found. Run: npm install --save-dev playwright\n');
    return 1;
  }
  const outputDir = args.checksOnly ? null : createPrivateTempDir(OUTPUT_DIR_PREFIX);
  try {
    const result = await captureDesignReview({ playwright, channel: channel(), url: args.url, routes: args.routes, outputDir, checksOnly: args.checksOnly });
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
  loadedFonts,
  main,
  measureOverflow,
  pageHeight,
  parseArgs,
  scrollThrough,
  slugForRoute,
  summarize,
};
