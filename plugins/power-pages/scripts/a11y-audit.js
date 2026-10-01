#!/usr/bin/env node
'use strict';

// Accessibility audit for Power Pages sites: opens each page in a real browser
// (system Edge/Chrome), runs axe-core plus checks axe cannot do (keyboard walk,
// reflow at 320px, 200% text, reduced motion, page titles), optionally replays
// interaction states, and writes one aggregated JSON report.
//
// Standalone on purpose: it works against a local dev server or a deployed site and
// does not depend on create-site or test-site. create-site's own
// skills/create-site/scripts/axe-audit.js is unchanged and still used by that skill.
//
// Run with --help for options and exit codes (see lib/a11y/args.js).

const fs = require('node:fs');
const path = require('node:path');
const { EXIT, USAGE, UsageError, VIEWPORTS, parseArgs } = require('./lib/a11y/args');
const { CrawlQueue, routeOf } = require('./lib/a11y/crawl');
const { MissingDependencyError, candidateRoots, launchBrowser, loadAxeSource, loadPlaywright } = require('./lib/a11y/deps');
const { ensureHelpers } = require('./lib/a11y/page-helpers');
const { runAxe } = require('./lib/a11y/axe-runner');
const { ReportBuilder, exitCodeFor } = require('./lib/a11y/report');
const { StatesFileError, applyState, loadStatesFile } = require('./lib/a11y/states');
const { runKeyboardCheck } = require('./lib/a11y/checks/keyboard');
const { runReflowCheck } = require('./lib/a11y/checks/reflow');
const { runZoomCheck } = require('./lib/a11y/checks/zoom');
const { runMotionCheck } = require('./lib/a11y/checks/motion');
const { analyzeTitles } = require('./lib/a11y/checks/titles');
const { ariaSnapshot, collectInventory } = require('./lib/a11y/checks/inventory');

const NETWORK_IDLE_MS = 10000;
const SETTLE_MS = 500;

// Power Pages sends anonymous users to its sign-in page on the same origin, e.g.
//   /SignIn?returnUrl=%2Fmy-cases      (code sites)
//   /Account/Login/ExternalLogin?...   (Entra ID handoff)
// so a 200 response alone does not mean the requested page was audited.
const SIGN_IN_PATH = /^\/(signin|account\/login)/i;

// Load a page and decide whether it is auditable. Never return the final URL's query
// string in errors: sign-in redirects carry state and nonce parameters.
async function visit(page, url, { origin, timeoutMs }) {
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  } catch (err) {
    return { error: `Navigation failed: ${err.message.split('\n')[0]}` };
  }
  // SPAs keep fetching after load; wait for quiet but do not fail if it never comes
  // (long-polling, analytics beacons).
  await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);

  const status = response ? response.status() : null;
  const final = new URL(page.url());
  const requested = new URL(url);
  const title = await page.title().catch(() => '');
  if (status !== null && status >= 400) return { status, title, error: `HTTP ${status}` };
  if (final.origin !== origin) {
    return { status, title, error: `Redirected to ${final.origin} — the page likely requires sign-in (use --auth-state)` };
  }
  if (SIGN_IN_PATH.test(final.pathname) && !SIGN_IN_PATH.test(requested.pathname)) {
    return { status, title, error: `Redirected to the sign-in page (${final.pathname}) — use --auth-state to audit signed-in pages` };
  }
  await ensureHelpers(page);
  return { status, title };
}

async function extractLinks(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('a[href]'), (a) => a.href));
}

function slugForRoute(route, index) {
  const slug = route.replace(/[?#].*$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'home';
  return `${String(index + 1).padStart(2, '0')}-${slug.slice(0, 60)}`;
}

async function newContext(browser, viewportName, opts) {
  const v = VIEWPORTS[viewportName];
  const context = await browser.newContext({
    viewport: { width: v.width, height: v.height },
    isMobile: v.isMobile,
    hasTouch: v.hasTouch,
    // Lets the inline axe script run even when the site's Content-Security-Policy
    // forbids inline scripts. Affects only this audit browser, never the site.
    bypassCSP: true,
    storageState: opts.authState || undefined,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeoutMs);
  return { context, page };
}

// Runs one extended check and records (not throws) its failure, so one flaky check
// on one page does not discard everything else audited on that page.
async function runCheck(name, fn, checkErrors) {
  try {
    return await fn();
  } catch (err) {
    checkErrors.push({ check: name, message: err.message.split('\n')[0] });
    return null;
  }
}

async function runDiscover(browser, opts, log) {
  const origin = opts.url.origin;
  const queue = new CrawlQueue({ origin, maxPages: opts.maxPages, exclude: opts.exclude });
  for (const r of opts.routes) queue.addExplicit(new URL(r, opts.url).toString());
  if (opts.snapshotDir) fs.mkdirSync(opts.snapshotDir, { recursive: true });

  const viewport = opts.viewports[0];
  const { context, page } = await newContext(browser, viewport, opts);
  const pages = [];
  try {
    let url;
    while ((url = queue.next())) {
      const route = routeOf(url);
      log(`(${pages.length + 1}) discover ${viewport} ${route}`);
      const nav = await visit(page, url, { origin, timeoutMs: opts.timeoutMs });
      const entry = { url, route, title: nav.title || null, status: nav.status || null, error: nav.error || null };
      if (!nav.error) {
        if (opts.crawl) for (const href of await extractLinks(page)) queue.add(href, page.url());
        Object.assign(entry, await collectInventory(page));
        if (opts.snapshotDir) {
          const snap = await ariaSnapshot(page);
          if (snap) {
            const file = path.join(opts.snapshotDir, `${slugForRoute(route, pages.length)}.aria.yml`);
            fs.writeFileSync(file, snap);
            entry.snapshotFile = file;
          }
        }
      }
      pages.push(entry);
    }
  } finally {
    await context.close();
  }
  const report = { mode: 'discover', baseUrl: opts.url.toString(), viewport, pages, crawl: queue.summary() };
  return { report, code: pages.some((p) => p.error) ? EXIT.LOAD_FAILURE : EXIT.PASS };
}

async function runAudit(browser, opts, { axeSource, states }, log) {
  const origin = opts.url.origin;
  const checks = new Set(opts.checks);
  // Layout-dependent checks that would only repeat themselves per viewport run once,
  // on desktop when it is selected (reflow already simulates the narrowest layout).
  const primary = opts.viewports.includes('desktop') ? 'desktop' : opts.viewports[0];
  const builder = new ReportBuilder({
    baseUrl: opts.url.toString(),
    viewports: opts.viewports,
    checks: opts.checks,
    bestPractice: opts.bestPractice,
    tool: { name: 'power-pages a11y-audit', axeVersion: null },
  });
  const queue = new CrawlQueue({ origin, maxPages: opts.maxPages, exclude: opts.exclude });
  for (const r of opts.routes) queue.addExplicit(new URL(r, opts.url).toString());

  // The first viewport drives discovery; later viewports audit exactly that list so
  // results are comparable across viewports.
  const urls = [];
  const titles = [];
  for (const [vi, viewport] of opts.viewports.entries()) {
    const { context, page } = await newContext(browser, viewport, opts);
    try {
      const list = vi === 0 ? null : [...urls];
      let i = 0;
      for (;;) {
        const url = vi === 0 ? queue.next() : list[i];
        if (!url) break;
        i++;
        if (vi === 0) urls.push(url);
        const route = routeOf(url);
        const total = vi === 0 ? `${i}` : `${i}/${list.length}`;
        log(`(${total}) ${viewport} ${route}`);

        const nav = await visit(page, url, { origin, timeoutMs: opts.timeoutMs });
        const checkErrors = [];
        if (nav.error) {
          builder.addPage({ route, viewport, url, title: nav.title || null, status: nav.status || null, error: nav.error });
          continue;
        }
        if (vi === 0 && opts.crawl) for (const href of await extractLinks(page)) queue.add(href, page.url());

        const ctx = { route, viewport };
        let pageError = null;
        if (checks.has('axe')) {
          try {
            const axeResult = await runAxe(page, axeSource, { bestPractice: opts.bestPractice });
            if (axeResult.axeVersion) builder.meta.tool.axeVersion = axeResult.axeVersion;
            builder.addFindings(axeResult.findings, ctx);
          } catch (err) {
            pageError = `axe failed: ${err.message.split('\n')[0]}`;
          }
        }
        if (viewport === primary) {
          if (checks.has('titles')) titles.push({ route, title: nav.title });
          // Order matters: each check restores what it changes, and the keyboard walk
          // runs last because moving focus can open menus that would skew the others.
          if (checks.has('motion')) {
            const r = await runCheck('motion', () => runMotionCheck(page), checkErrors);
            if (r) builder.addFindings(r.findings, ctx);
          }
          if (checks.has('zoom')) {
            const r = await runCheck('zoom', () => runZoomCheck(page), checkErrors);
            if (r) builder.addFindings(r.findings, ctx);
          }
          if (checks.has('reflow')) {
            const r = await runCheck('reflow', () => runReflowCheck(page), checkErrors);
            if (r) builder.addFindings(r.findings, ctx);
          }
          if (checks.has('keyboard')) {
            const r = await runCheck('keyboard', () => runKeyboardCheck(page), checkErrors);
            if (r) builder.addFindings(r.findings, ctx);
          }
        }
        builder.addPage({ route, viewport, url, title: nav.title || null, status: nav.status || null, error: pageError, checkErrors });
      }

      for (const state of states.filter((s) => (s.viewport || primary) === viewport)) {
        const url = new URL(state.route, opts.url).toString();
        log(`state ${viewport} ${state.route} "${state.label}"`);
        const nav = await visit(page, url, { origin, timeoutMs: opts.timeoutMs });
        if (nav.error) {
          builder.addState({ label: state.label, route: state.route, viewport, error: nav.error });
          continue;
        }
        try {
          await applyState(page, state, { allowFormSubmit: opts.allowFormSubmit, timeoutMs: Math.min(opts.timeoutMs, 10000) });
          await ensureHelpers(page);
          if (checks.has('axe')) {
            const { findings } = await runAxe(page, axeSource, { bestPractice: opts.bestPractice });
            builder.addFindings(findings, { route: state.route, viewport, state: state.label });
          }
          builder.addState({ label: state.label, route: state.route, viewport });
        } catch (err) {
          builder.addState({ label: state.label, route: state.route, viewport, error: err.message.split('\n')[0] });
        }
      }
    } finally {
      await context.close();
    }
  }

  for (const { route, finding } of analyzeTitles(titles)) {
    builder.addFindings([finding], { route, viewport: primary });
  }

  const report = { mode: 'audit', ...builder.build({ crawl: queue.summary() }) };
  return { report, code: exitCodeFor(report) };
}

function writeOutput(report, opts, stdout) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (opts.output) {
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.writeFileSync(opts.output, json);
  } else {
    stdout.write(json);
  }
}

async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  let states = [];
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      stdout.write(`${USAGE}\n`);
      return EXIT.PASS;
    }
    if (opts.statesFile) states = loadStatesFile(opts.statesFile);
    if (opts.authState && !fs.existsSync(opts.authState)) {
      throw new UsageError(`--auth-state file not found: ${opts.authState}`);
    }
  } catch (err) {
    if (err instanceof UsageError || err instanceof StatesFileError) {
      stderr.write(`${err.message}\n\n${USAGE}\n`);
      return EXIT.USAGE;
    }
    throw err;
  }

  const log = (msg) => stderr.write(`[a11y] ${msg}\n`);
  let browser;
  try {
    const roots = candidateRoots({ depsDir: opts.depsDir, projectRoot: opts.projectRoot });
    const { chromium } = loadPlaywright(roots);
    let axe = { source: null };
    if (opts.mode === 'audit' && opts.checks.includes('axe')) axe = loadAxeSource(roots);
    browser = await launchBrowser(chromium, { headless: !opts.headed });

    const { report, code } = opts.mode === 'discover'
      ? await runDiscover(browser, opts, log)
      : await runAudit(browser, opts, { axeSource: axe.source, states }, log);
    writeOutput(report, opts, stdout);
    return code;
  } catch (err) {
    if (err instanceof MissingDependencyError) {
      stderr.write(`${err.message}\n`);
      return EXIT.MISSING_DEPS;
    }
    stderr.write(`Accessibility audit failed: ${err.message}\n`);
    return EXIT.LOAD_FAILURE;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main, slugForRoute };
