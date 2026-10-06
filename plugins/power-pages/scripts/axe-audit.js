#!/usr/bin/env node

// Runs an axe-core accessibility audit (WCAG 2.2 AA) on each route of a Power Pages site -
// a local dev server or a deployed site - and reports the violations.
//
// Usage:
//   node axe-audit.js --url http://localhost:5173 --routes /,/about,/contact [--project-root <path>]
//
// Playwright comes from the project's dev dependency when --project-root has one, and
// otherwise from the plugin's pinned @playwright/mcp package, so nothing is installed.
// Output: JSON array of per-route results on stdout.
// Exit code: 1 when a critical or serious violation is found, a route could not be audited, or
// the audit cannot run at all; 0 only when every route was audited and passed.

const { detectBrowser } = require('./lib/detect-browser');
const { loadPlaywright } = require('./lib/load-playwright');
const { gotoSettled, parseRouteList } = require('./lib/review-navigation');

const AXE_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.3/axe.min.js';
// WCAG 2.2 AA is cumulative, so the 2.0 and 2.1 A/AA tags are listed too.
// See: https://github.com/dequelabs/axe-core/blob/develop/doc/API.md#axe-core-tags
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SETTLE_MS = 2000;
const BLOCKING_IMPACTS = new Set(['critical', 'serious']);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) parsed.url = argv[++i].replace(/\/+$/, '');
    else if (argv[i] === '--routes' && argv[i + 1]) parsed.routes = parseRouteList(argv[++i]);
    else if (argv[i] === '--project-root' && argv[i + 1]) parsed.projectRoot = argv[++i];
  }
  if (!parsed.url || !parsed.routes || parsed.routes.length === 0) {
    return { error: 'Usage: node axe-audit.js --url <base-url> --routes <comma-separated> [--project-root <path>]' };
  }
  return parsed;
}

// Runs in the page after axe-core is injected.
async function runAxe(tags) {
  const res = await window.axe.run(document, { runOnly: { type: 'tag', values: tags } });
  return {
    violations: res.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({ html: n.html, target: n.target, failureSummary: n.failureSummary })),
    })),
    passes: res.passes.length,
    incomplete: res.incomplete.length,
  };
}

async function auditRoutes({ playwright, channel, url, routes }) {
  const browser = await playwright.chromium.launch({ channel, headless: true });
  const results = [];
  try {
    // A deployed site can send a Content-Security-Policy that forbids scripts from the axe
    // CDN, which would block the injected <script>. Bypassing CSP for this audit-only
    // browser lets the same command audit a dev server and a live site alike.
    const context = await browser.newContext({ bypassCSP: true });
    const page = await context.newPage();
    for (const route of routes) {
      const pageUrl = `${url}${route}`;
      try {
        await gotoSettled(page, pageUrl, { settleMs: SETTLE_MS });
        await page.addScriptTag({ url: AXE_CDN_URL });
        await page.waitForFunction(() => typeof window.axe !== 'undefined', null, { timeout: 10000 });
        results.push({ route, url: pageUrl, ...(await page.evaluate(runAxe, WCAG_TAGS)) });
      } catch (error) {
        results.push({ route, url: pageUrl, error: error.message, violations: [], passes: 0, incomplete: 0 });
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

// A route that failed to load or to inject axe has an empty `violations` list, which would
// otherwise read as a pass; an unaudited route blocks just like a serious violation.
function hasBlockingResult(results) {
  return results.some((r) => Boolean(r.error) || r.violations.some((v) => BLOCKING_IMPACTS.has(v.impact)));
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
  const playwright = loadPlaywrightFn(args.projectRoot);
  if (!playwright) {
    writeError('Playwright could not be loaded from the project or from the pinned @playwright/mcp package. Check that npm can reach its registry.\n');
    return 1;
  }
  try {
    const results = await auditRoutes({ playwright, channel: channel(), url: args.url, routes: args.routes });
    write(`${JSON.stringify(results, null, 2)}\n`);
    return hasBlockingResult(results) ? 1 : 0;
  } catch (error) {
    writeError(`${error.message}\n`);
    return 1;
  }
}

module.exports = { AXE_CDN_URL, WCAG_TAGS, auditRoutes, hasBlockingResult, main, parseArgs, runAxe };

if (require.main === module) {
  main().then((code) => process.exit(code));
}
