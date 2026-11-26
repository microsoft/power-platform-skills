#!/usr/bin/env node

// Collects design evidence for /design-eval: every route at desktop (1440x900) and mobile (390x844),
// with screenshots, measurements, an axe-core audit, and focus, hover, reduced-motion and layout-shift
// probes. One call per evaluation run.
//
// Usage (values only ever arrive as JSON on stdin, inside a quoted heredoc):
//   node collect.js --input - <<'REQUEST'
//   {"url": "http://localhost:5173", "routes": ["/", "/about"], "project": "<PROJECT_ROOT>"}
//   REQUEST
//
// Writes <project>/docs/design-eval/<run>/{evidence.json, shots/*.jpg}. Playwright comes only from the
// plugin's pinned package and axe-core only when it matches the committed hash; nothing is loaded from
// the project. Output: JSON on stdout. Exit 0 when collection ran (gaps are data), 1 on usage or launch errors.

const fs = require('node:fs');
const path = require('node:path');
const { detectBrowser } = require('../../../scripts/lib/detect-browser');
const { loadPlaywright } = require('../../../scripts/lib/load-playwright');
const { loadAxeSource } = require('../../../scripts/axe-audit');
const {
  gotoSettled, isString, isStringList, normalizeSiteUrl, parseRequest, parseRouteList, redactUrl, redactUrlsInMarkup,
} = require('../../../scripts/lib/review-navigation');
const { measureLoadedPage, emptyRecord } = require('../../../scripts/lib/design-grade/collect-page');
const { CLS_INIT_SCRIPT, waitForStableLayout, reducedMotionProbe } = require('../../../scripts/lib/design-grade/interactions');

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const MAX_ROUTES = 10;
const SETTLE_MS = 800;
const REQUEST_FIELDS = { url: isString, routes: isStringList, project: isString };
const USAGE = 'Usage: node collect.js --input -   (JSON request on stdin: url, routes, project)';

function parseArgs(argv, { readStdin = () => fs.readFileSync(0, 'utf8') } = {}) {
  if (!(argv[0] === '--input' && argv[1] === '-')) return { error: USAGE };
  const { request, error } = parseRequest(readStdin(), REQUEST_FIELDS);
  if (error) return { error };
  if (!request.url || !request.project) return { error: USAGE };
  const site = normalizeSiteUrl(request.url);
  if (site.error) return { error: site.error };
  const routes = parseRouteList(request.routes && request.routes.length ? request.routes : ['/']);
  if (routes.length > MAX_ROUTES) return { error: `Evaluate at most ${MAX_ROUTES} routes per run.` };
  let stat = null;
  try { stat = fs.statSync(request.project); } catch { /* reported below */ }
  if (!stat || !stat.isDirectory() || !fs.existsSync(path.join(request.project, 'powerpages.config.json'))) {
    return { error: 'project must be a Power Pages code site folder (it contains powerpages.config.json).' };
  }
  return { url: site.url, routes, project: path.resolve(request.project) };
}

// Each run gets its own folder, so earlier reports stay available for comparison.
function createRunDir(project, now = new Date()) {
  const root = path.join(project, 'docs', 'design-eval');
  fs.mkdirSync(root, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const dir = path.join(root, stamp);
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  return dir;
}

// Facts that depend on a URL's query are read before redaction drops it.
function resolveBeforeRedaction(evidence) {
  for (const page of evidence.pages) {
    for (const v of Object.values(page.viewports)) {
      if (!v || !v.fonts) continue;
      v.fonts.googleFontLinks = (v.fonts.googleFontLinks || []).map((href) => ({ href, hasDisplay: /[?&]display=(swap|optional|fallback)\b/.test(href) }));
      v.links = (v.links || []).map((l) => ({ ...l, dead: l.href !== null && (l.href.trim() === '' || l.href.trim() === '#' || /^javascript:/i.test(l.href.trim())) }));
    }
  }
  return evidence;
}

// Every string in the evidence has URLs cut to origin and path before it is written.
function sanitizeDeep(value) {
  if (typeof value === 'string') return redactUrlsInMarkup(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeDeep(v)]));
  return value;
}

async function collect({ playwright, channel, url, routes, runDir, axeSource }) {
  const browser = await playwright.chromium.launch({ channel, headless: true });
  const shotsDir = path.join(runDir, 'shots');
  const pages = routes.map((route) => ({ ...emptyRecord(route), url: redactUrl(`${url}${route}`) }));
  const gap = (p, viewport, step, error) => p.collectionErrors.push({ viewport, step, error: String((error && error.message) || error).split('\n')[0].slice(0, 300) });
  try {
    for (const [width, viewport] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'block' });
      await context.addInitScript(CLS_INIT_SCRIPT);
      try {
        for (const p of pages) {
          const page = await context.newPage();
          const sizes = [];
          if (width === 'desktop') {
            page.on('pageerror', (error) => p.errors.push({ type: 'pageerror', message: String(error.message).slice(0, 300) }));
            page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) p.errors.push({ type: 'console', message: m.text().slice(0, 300) }); });
            page.on('requestfailed', (r) => p.failedRequests.push({ url: r.url(), status: 'failed', type: r.resourceType(), reason: (r.failure() || {}).errorText || 'failed' }));
            page.on('response', (r) => {
              if (r.status() >= 400) p.failedRequests.push({ url: r.url(), status: r.status(), type: r.request().resourceType() });
              sizes.push(r.request().sizes().then((s) => ({ type: r.request().resourceType(), bytes: s.responseBodySize + s.responseHeadersSize })).catch(() => ({ type: 'other', bytes: 0 })));
            });
          }
          try {
            await gotoSettled(page, `${url}${p.route}`, { settleMs: SETTLE_MS });
            await measureLoadedPage(page, { record: p, width, viewport, shotsDir, rootDir: runDir, axeSource });
          } catch (error) {
            if (!p.viewports[width]) p.viewports[width] = { error: String(error.message).split('\n')[0] };
            else gap(p, width, 'post-measure', error);
          } finally {
            await page.close();
          }
          if (width === 'desktop') {
            for (const { type, bytes } of await Promise.all(sizes)) p.pageWeightByType[type] = (p.pageWeightByType[type] || 0) + bytes;
          }
        }
      } finally {
        await context.close();
      }
    }
    const reduced = await browser.newContext({ viewport: VIEWPORTS.desktop, deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block' });
    try {
      for (const p of pages) {
        const page = await reduced.newPage();
        try {
          await gotoSettled(page, `${url}${p.route}`, { settleMs: SETTLE_MS });
          await waitForStableLayout(page);
          p.reducedMotion = await reducedMotionProbe(page);
        } catch (error) {
          gap(p, 'desktop', 'reduced-motion', error);
        } finally {
          await page.close();
        }
      }
    } finally {
      await reduced.close();
    }
  } finally {
    await browser.close();
  }
  return sanitizeDeep(resolveBeforeRedaction({ tool: 'design-eval', collectedAt: new Date().toISOString(), baseUrl: redactUrl(url), viewports: VIEWPORTS, pages }));
}

async function main(argv = process.argv.slice(2), {
  write = (s) => process.stdout.write(s),
  writeError = (s) => process.stderr.write(s),
  readStdin,
  loadPlaywrightFn = loadPlaywright,
  channel = detectBrowser,
  loadAxeSourceFn = loadAxeSource,
  now,
} = {}) {
  const args = parseArgs(argv, { readStdin });
  if (args.error) {
    writeError(`${args.error}\n`);
    return 1;
  }
  const playwright = loadPlaywrightFn();
  if (!playwright) {
    writeError('Playwright could not be loaded from the pinned @playwright/mcp package. Check that npm can reach its registry.\n');
    return 1;
  }
  let axeSource = null;
  try { axeSource = await loadAxeSourceFn(); } catch { /* recorded as a coverage gap per page */ }
  const runDir = createRunDir(args.project, now);
  try {
    const evidence = await collect({ playwright, channel: channel(), url: args.url, routes: args.routes, runDir, axeSource });
    fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
    const loaded = evidence.pages.filter((p) => p.viewports.desktop && !p.viewports.desktop.error);
    write(`${JSON.stringify({
      runDir,
      routes: evidence.pages.map((p) => ({ route: p.route, loaded: loaded.includes(p), error: (p.viewports.desktop || {}).error || null })),
      screenshots: evidence.pages.flatMap((p) => Object.values(p.screenshots).flatMap((s) => [s.fold, s.full]).map((f) => path.join(runDir, f))),
      gaps: evidence.pages.flatMap((p) => p.collectionErrors.map((g) => `${p.route} ${g.viewport} ${g.step}: ${g.error}`)),
    }, null, 1)}\n`);
    return 0;
  } catch (error) {
    writeError(`Design evaluation capture failed: ${String(error.message).split('\n')[0]}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = { main, parseArgs, createRunDir, sanitizeDeep, resolveBeforeRedaction, VIEWPORTS, MAX_ROUTES };
