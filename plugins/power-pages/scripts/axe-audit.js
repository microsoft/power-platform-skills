#!/usr/bin/env node

// Runs an axe-core accessibility audit (WCAG 2.2 AA) on each route of a Power Pages site -
// a local dev server or a deployed site - and reports the violations.
//
// Usage:
//   node axe-audit.js --url http://localhost:5173 --routes /,/about,/contact [--project-root <path>]
//   node axe-audit.js --input - <<'REQUEST'
//   {"url": "http://localhost:5173", "routes": ["/", "/about"], "projectRoot": "<path>"}
//   REQUEST
// Use the stdin form whenever a value comes from a user, a dev server's output, or a page, so
// the shell never interprets it.
//
// Playwright comes from the project's dev dependency when --project-root has one, and
// otherwise from the plugin's pinned @playwright/mcp package in npm's cache, so nothing is
// installed into the project. axe-core itself is downloaded once per run and injected only
// when its bytes match the hash pinned below.
// Output: JSON array of per-route results on stdout.
// Exit code: 1 when a critical or serious violation is found, a route could not be audited, or
// the audit cannot run at all; 0 only when every route was audited and passed.

const { detectBrowser } = require('./lib/detect-browser');
const { loadPlaywright } = require('./lib/load-playwright');
const { downloadPinned } = require('./lib/pinned-download');
const fs = require('node:fs');
const {
  gotoSettled, isString, isStringList, normalizeSiteUrl, parseRequest, parseRouteList, redactUrl, redactUrlsInText,
} = require('./lib/review-navigation');

// axe-core 4.10.3 (MPL-2.0). The integrity value is the hash cdnjs publishes for this file,
// and it matches axe.min.js in the axe-core@4.10.3 npm package byte for byte. To upgrade,
// change the version in the URL and take the new hash from both of those sources.
const AXE_SCRIPT = {
  url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.3/axe.min.js',
  integrity: 'sha512-Y6Vva0IT8gxKyqgZjlEfG76U48eXakSZ8UqY6vMQMe6xES2So8WuItGYcHi3tH1OAlMKjTWjSeN/5x2aysOXIQ==',
  maxBytes: 2 * 1024 * 1024,
};
// WCAG 2.2 AA is cumulative, so the 2.0 and 2.1 A/AA tags are listed too.
// See: https://github.com/dequelabs/axe-core/blob/develop/doc/API.md#axe-core-tags
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SETTLE_MS = 2000;
const BLOCKING_IMPACTS = new Set(['critical', 'serious']);

const REQUEST_FIELDS = { url: isString, routes: isStringList, projectRoot: isString };
const USAGE = 'Usage: node axe-audit.js --url <base-url> --routes <comma-separated> [--project-root <path>]\n'
  + '       node axe-audit.js --input -   (JSON request on stdin: url, routes, projectRoot)';

function parseArgs(argv, { readStdin = () => fs.readFileSync(0, 'utf8') } = {}) {
  let parsed = {};
  let fromStdin = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) parsed.url = argv[++i];
    else if (argv[i] === '--routes' && argv[i + 1]) parsed.routes = parseRouteList(argv[++i]);
    else if (argv[i] === '--project-root' && argv[i + 1]) parsed.projectRoot = argv[++i];
    else if (argv[i] === '--input' && argv[i + 1] === '-') { fromStdin = true; i++; }
  }
  if (fromStdin) {
    const { request, error } = parseRequest(readStdin(), REQUEST_FIELDS);
    if (error) return { error };
    parsed = { ...parsed, ...request };
    if (request.routes) parsed.routes = parseRouteList(request.routes);
  }
  if (!parsed.url || !parsed.routes || parsed.routes.length === 0) {
    return { error: USAGE };
  }
  const site = normalizeSiteUrl(parsed.url);
  if (site.error) return { error: site.error };
  return { ...parsed, url: site.url };
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

// axe reports each failing element as a markup snippet and a CSS selector, e.g.
//   <img src="https://contoso.blob.core.windows.net/a.jpg?sv=2024&amp;sig=..." class="hero">
//   a[href="/files/report.pdf?token=..."]
// Query strings and fragments in URL attributes can carry tokens, and this output is read
// into the agent's conversation, so they are dropped; the element stays identifiable by its
// tag, path, and other attributes. srcset holds several comma-separated URLs, each cleaned.
const URL_ATTRIBUTE = /\b(src|href|srcset|action|formaction|poster|data-src|data-href)(\s*=\s*)("[^"]*"|'[^']*')/gi;

function stripUrlQueries(text) {
  return String(text).replace(URL_ATTRIBUTE, (_, name, equals, quoted) => `${name}${equals}${quoted.replace(/[?#][^\s,"']*/g, '')}`);
}

function redactAxeResult(result) {
  return {
    ...result,
    violations: result.violations.map((v) => ({
      ...v,
      nodes: v.nodes.map((n) => ({ ...n, html: stripUrlQueries(n.html), target: (n.target || []).map(stripUrlQueries) })),
    })),
  };
}

// Downloads axe-core and returns its source only when it matches the pinned hash.
async function loadAxeSource({ download = downloadPinned } = {}) {
  return (await download(AXE_SCRIPT)).toString('utf8');
}

async function auditRoutes({ playwright, channel, url, routes, axeSource }) {
  const browser = await playwright.chromium.launch({ channel, headless: true });
  const results = [];
  try {
    // axe is injected as an inline <script> holding the verified source. A deployed site's
    // Content-Security-Policy usually forbids inline scripts, so this audit-only browser
    // bypasses CSP; the script it runs is the hash-checked axe-core and nothing else.
    const context = await browser.newContext({ bypassCSP: true });
    const page = await context.newPage();
    for (const route of routes) {
      const pageUrl = `${url}${route}`;
      try {
        await gotoSettled(page, pageUrl, { settleMs: SETTLE_MS });
        await page.addScriptTag({ content: axeSource });
        await page.waitForFunction(() => typeof window.axe !== 'undefined', null, { timeout: 10000 });
        results.push({ route, url: redactUrl(pageUrl), ...redactAxeResult(await page.evaluate(runAxe, WCAG_TAGS)) });
      } catch (error) {
        results.push({ route, url: redactUrl(pageUrl), error: redactUrlsInText(error.message), violations: [], passes: 0, incomplete: 0 });
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
  loadAxeSourceFn = loadAxeSource,
  channel = detectBrowser,
  readStdin,
} = {}) {
  const args = parseArgs(argv, { readStdin });
  if (args.error) {
    writeError(`${args.error}\n`);
    return 1;
  }
  let axeSource;
  try {
    axeSource = await loadAxeSourceFn();
  } catch (error) {
    writeError(`axe-core could not be loaded: ${redactUrlsInText(error.message)}\n`);
    return 1;
  }
  const playwright = loadPlaywrightFn(args.projectRoot);
  if (!playwright) {
    writeError('Playwright could not be loaded from the project or from the pinned @playwright/mcp package. Check that npm can reach its registry.\n');
    return 1;
  }
  try {
    const results = await auditRoutes({ playwright, channel: channel(), url: args.url, routes: args.routes, axeSource });
    write(`${JSON.stringify(results, null, 2)}\n`);
    return hasBlockingResult(results) ? 1 : 0;
  } catch (error) {
    writeError(`${redactUrlsInText(error.message)}\n`);
    return 1;
  }
}

module.exports = { AXE_SCRIPT, WCAG_TAGS, auditRoutes, hasBlockingResult, loadAxeSource, main, parseArgs, runAxe, stripUrlQueries };

if (require.main === module) {
  main().then((code) => process.exit(code));
}
