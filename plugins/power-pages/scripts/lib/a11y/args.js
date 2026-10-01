'use strict';

// Argument parsing and exit-code contract for scripts/a11y-audit.js.
//
// The exit codes are a public contract for the calling skill: it branches on them,
// so "the audit could not run" must never look like "the audit found violations",
// and "a page failed to load" must never look like "a page passed". The legacy
// create-site/scripts/axe-audit.js returned 1 for both usage errors and violations
// and recorded load failures as zero violations — this module exists partly to fix
// that for new callers without changing create-site's behavior.

const EXIT = Object.freeze({
  PASS: 0,
  VIOLATIONS: 1,
  USAGE: 2,
  LOAD_FAILURE: 3,
  MISSING_DEPS: 4,
});

// Desktop and mobile are the two layouts every Power Pages code site ships. 375px is
// the narrowest common phone width; the 320px WCAG 1.4.10 reflow width is checked
// separately by checks/reflow.js rather than as a full audit viewport.
const VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1280, height: 800, isMobile: false, hasTouch: false }),
  mobile: Object.freeze({ width: 375, height: 812, isMobile: true, hasTouch: true }),
});

const ALL_CHECKS = Object.freeze(['axe', 'keyboard', 'reflow', 'zoom', 'motion', 'titles']);
const MODES = Object.freeze(['audit', 'discover']);

const DEFAULT_MAX_PAGES = 25;
const MAX_PAGES_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 30000;

class UsageError extends Error {}

const USAGE = `Usage: node a11y-audit.js --url <base-url> [options]

Target
  --url <url>               Base URL of the site (http/https). Required.
  --routes </,/about>       Comma-separated routes to audit. Default: /
  --crawl                   Also follow same-origin links found on each page.
  --max-pages <n>           Crawl cap (default ${DEFAULT_MAX_PAGES}, max ${MAX_PAGES_LIMIT}).
  --exclude <a,b>           Extra case-insensitive substrings; matching URLs are skipped.

Mode
  --mode audit|discover     audit (default) runs checks; discover lists pages,
                            interactive controls and state candidates only.

Audit options
  --viewports <list>        desktop,mobile (default both).
  --checks <list>           ${ALL_CHECKS.join(',')} (default all).
  --no-best-practice        Exclude axe best-practice rules (WCAG A/AA only).
  --states <file>           JSON file of interaction states to audit.
  --allow-form-submit       Allow state steps that would submit a form.

Session and environment
  --auth-state <file>       Playwright storage state from a11y-capture-auth.js.
  --deps-dir <path>         Directory populated by install-a11y-deps.js.
  --headed                  Show the browser window while auditing.
  --timeout <ms>            Per-navigation timeout (default ${DEFAULT_TIMEOUT_MS}).

Output
  --output <file>           Write JSON report to a file instead of stdout.
  --snapshot-dir <dir>      discover mode: write per-page ARIA snapshots here.

Exit codes: 0 pass, 1 critical/serious WCAG violations, 2 usage error,
            3 one or more pages failed to load, 4 dependencies missing.`;

function splitList(value) {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`--url is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`--url must use http or https: ${raw}`);
  }
  url.hash = '';
  return url;
}

function parsePositiveInt(flag, raw, max) {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${flag} must be a positive integer: ${raw}`);
  const n = Number(raw);
  if (n < 1 || n > max) throw new UsageError(`${flag} must be between 1 and ${max}: ${raw}`);
  return n;
}

const FLAGS_WITH_VALUE = new Set([
  '--url', '--routes', '--max-pages', '--exclude', '--mode', '--viewports', '--checks',
  '--states', '--auth-state', '--deps-dir', '--timeout', '--output',
  '--snapshot-dir',
]);

function parseArgs(argv) {
  const opts = {
    url: null,
    routes: ['/'],
    crawl: false,
    maxPages: DEFAULT_MAX_PAGES,
    exclude: [],
    mode: 'audit',
    viewports: ['desktop', 'mobile'],
    checks: [...ALL_CHECKS],
    bestPractice: true,
    statesFile: null,
    allowFormSubmit: false,
    authState: null,
    depsDir: null,
    headed: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    output: null,
    snapshotDir: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    let value;
    if (FLAGS_WITH_VALUE.has(flag)) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
      i++;
    }
    switch (flag) {
      case '--help': case '-h': opts.help = true; break;
      case '--url': opts.url = parseBaseUrl(value); break;
      case '--routes': {
        const routes = splitList(value);
        if (routes.length === 0) throw new UsageError('--routes must list at least one route');
        for (const r of routes) {
          if (!r.startsWith('/')) throw new UsageError(`Routes must start with "/": ${r}`);
        }
        opts.routes = [...new Set(routes)];
        break;
      }
      case '--crawl': opts.crawl = true; break;
      case '--max-pages': opts.maxPages = parsePositiveInt(flag, value, MAX_PAGES_LIMIT); break;
      case '--exclude': opts.exclude = splitList(value).map((s) => s.toLowerCase()); break;
      case '--mode':
        if (!MODES.includes(value)) throw new UsageError(`--mode must be one of ${MODES.join(', ')}`);
        opts.mode = value;
        break;
      case '--viewports': {
        const list = splitList(value);
        const bad = list.filter((v) => !Object.hasOwn(VIEWPORTS, v));
        if (list.length === 0 || bad.length) {
          throw new UsageError(`--viewports must be from ${Object.keys(VIEWPORTS).join(', ')}`);
        }
        opts.viewports = [...new Set(list)];
        break;
      }
      case '--checks': {
        const list = splitList(value);
        const bad = list.filter((c) => !ALL_CHECKS.includes(c));
        if (list.length === 0 || bad.length) {
          throw new UsageError(`--checks must be from ${ALL_CHECKS.join(', ')}; unknown: ${bad.join(', ')}`);
        }
        opts.checks = [...new Set(list)];
        break;
      }
      case '--no-best-practice': opts.bestPractice = false; break;
      case '--states': opts.statesFile = value; break;
      case '--allow-form-submit': opts.allowFormSubmit = true; break;
      case '--auth-state': opts.authState = value; break;
      case '--deps-dir': opts.depsDir = value; break;
      case '--headed': opts.headed = true; break;
      case '--timeout': opts.timeoutMs = parsePositiveInt(flag, value, 600000); break;
      case '--output': opts.output = value; break;
      case '--snapshot-dir': opts.snapshotDir = value; break;
      default:
        throw new UsageError(`Unknown argument: ${flag}`);
    }
  }

  if (opts.help) return opts;
  if (!opts.url) throw new UsageError('--url is required');
  if (opts.snapshotDir && opts.mode !== 'discover') {
    throw new UsageError('--snapshot-dir is only valid with --mode discover');
  }
  if (opts.statesFile && opts.mode !== 'audit') {
    throw new UsageError('--states is only valid with --mode audit');
  }
  return opts;
}

module.exports = {
  ALL_CHECKS,
  DEFAULT_MAX_PAGES,
  EXIT,
  MODES,
  USAGE,
  UsageError,
  VIEWPORTS,
  parseArgs,
};
